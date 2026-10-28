// Phase 1 (protocol): pure move from main.js (2026-10-10) — thumbnails,
// app:// protocol (renderer + media + thumbs + previews), application menu,
// window preferences/CSP, window creation. No behavior change: same routes,
// ranges, menus, web preferences. Shared refs still owned by main.js arrive
// via main/context.js and are read AT CALL TIME: rendererDir / thumbsDir /
// photosDir / appDirname (stable path consts), ensurePreview /
// imageContentType / resolveRevealTarget (hoisted fns staying for later
// slices), getAppIconImage / isQuitting / isMenuBarOnlyEnabled (existing
// chrome slots). Sibling domains are required directly (no cycles — none
// require protocol back): store, settings, pool status, pump snapshots,
// import picker, chrome focuser. Exports below serve boot (protocol handle,
// menu, window), activate (window), and the smoke ctx (web preferences).
// This module never requires main.js.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { BrowserWindow, Menu, app } from "electron";
import ctx from "../context.ts";
import {
	thumbFor,
	libraryIndex,
	cachedLibraryBins,
	cachedSegmentsBin,
	cachedTranscriptsBin,
	loadLibrary,
	loadSegments,
	loadTranscripts,
} from "../../main-lib/library-store.ts";
import { sniffImageMime } from "../../indexer/mime-sniff.ts";
import { modelsManifest } from "./migration.ts";
import { getModelStatus } from "./pool.ts";
import { enrichSnapshot } from "./pumps/enrich.ts";
import { transcribeSnapshot } from "./pumps/transcribe.ts";
import { pickAndImport } from "./import.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".bin": "application/octet-stream",
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".ts": "video/mp2t",
	".m2ts": "video/mp2t",
	".mts": "video/mp2t",
	".mpg": "video/mpeg",
	".mpeg": "video/mpeg",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
};

// ---------------------------------------------------------------------------
// Photo thumbnails: the grid renders a ~480px JPEG instead of the original —
// camera originals average 2MB+ and GIFs can be hundreds of MB, so decoding
// those per tile was the app's biggest memory/jank source. Generated lazily
// on the first /images/thumbs/* request (covers legacy libraries without a
// backfill pass) and cached on disk forever, with per-filename single-flight
// plus a small global cap so a first browse can't fan out one sharp decode
// per tile.
// ---------------------------------------------------------------------------

const THUMB_WIDTH = 480;
const THUMB_CONCURRENCY = 2;

const thumbJobs = new Map<string, Promise<string>>(); // filename → Promise<path>
// Slot promises exist only to serialize; their resolved values are never
// read (hence unknown).
const thumbSlots: Array<Promise<unknown>> = Array.from(
	{ length: THUMB_CONCURRENCY },
	() => Promise.resolve(),
);
let thumbSlotIndex = 0;

async function ensureThumb(filename: string) {
	const out = thumbFor(filename);
	try {
		await fs.promises.access(out);
		return out;
	} catch {
		/* not generated yet */
	}
	const existing = thumbJobs.get(filename);
	if (existing) return existing;
	// Cast: slot is always in [0, THUMB_CONCURRENCY) — the array is built
	// with exactly that many entries (the index-signal undefined never
	// occurs).
	const slot = thumbSlotIndex++ % THUMB_CONCURRENCY;
	const prev = thumbSlots[slot] as Promise<unknown>;
	const job = prev
		.then(async () => {
			try {
				await fs.promises.access(out);
				return out;
			} catch {
				/* generate below */
			}
			fs.mkdirSync(ctx.thumbsDir, { recursive: true });
			const sharp = (await import("sharp")).default;
			// First page only (animated GIFs collapse to their first frame),
			// EXIF-rotated, downscaled, quality-tuned JPEG.
			await sharp(path.join(ctx.photosDir, filename))
				.rotate()
				.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
				.jpeg({ quality: 82 })
				.toFile(out);
			return out;
		})
		.finally(() => {
			thumbJobs.delete(filename);
		});
	thumbSlots[slot] = job.catch(() => {});
	thumbJobs.set(filename, job);
	return job;
}

// ---------------------------------------------------------------------------
// Protocol: renderer bundle + library files, all under app://
// ---------------------------------------------------------------------------

async function resolveRenderer(p: string) {
	if (p === "/" || p === "") p = "/index.html";
	const filePath = path.normalize(path.join(ctx.rendererDir, p));
	if (
		!filePath.startsWith(ctx.rendererDir + path.sep) &&
		filePath !== ctx.rendererDir
	)
		return null;
	try {
		const stat = await fs.promises.stat(filePath);
		if (stat.isFile()) return filePath;
	} catch {
		/* fall through */
	}
	if (!path.extname(p)) {
		const withHtml = filePath + ".html";
		try {
			if ((await fs.promises.stat(withHtml)).isFile()) return withHtml;
		} catch {
			/* 404 below */
		}
	}
	return null;
}

// A web ReadableStream over a byte window of a file — the streaming
// equivalent of readFile().subarray(). The file is OPENED first so a
// vanished file is a clean ENOENT (→ 404 from the caller's catch) instead
// of an aborted response after headers were already sent. The handle is
// released when the stream ends or errors.
function openFileStreamRange(filePath: string, start: number, end: number) {
	return fs.promises.open(filePath, "r").then((handle) => {
		// The fd is provided, so the path argument is inert (the
		// pre-conversion code passed null — same call).
		const nodeStream = fs.createReadStream(
			null as unknown as Parameters<typeof fs.createReadStream>[0],
			{
				fd: handle.fd,
				start,
				end,
				autoClose: false,
			},
		);
		const release = () => handle.close().catch(() => {});
		nodeStream.on("error", release);
		nodeStream.on("end", release);
		nodeStream.on("close", release);
		// Cast: node's stream/web ReadableStream and the DOM lib's
		// ReadableStream are structurally the same object at runtime but
		// nominally distinct in the two type libs — Response consumes it
		// verbatim (the standard node↔dom interop cast).
		return Readable.toWeb(nodeStream) as unknown as ReadableStream;
	});
}

async function handleAppRequest(request: Request) {
	const urlPath = safeDecode(new URL(request.url).pathname);
	const headers = new Headers();
	// Body widens to include Buffer: the DOM lib's BufferSource misses
	// node's Buffer<ArrayBufferLike> (a types-only friction — the bytes are
	// consumed verbatim), so the single construction site casts.
	const respond = (
		status: number,
		body: BodyInit | Buffer | null,
		contentType: string | null,
		extra: Record<string, string> = {},
	) => {
		if (contentType) headers.set("Content-Type", contentType);
		for (const [k, v] of Object.entries(extra)) headers.set(k, v);
		return new Response(body as BodyInit, { status, headers });
	};

	// Library files (served from memory so imports are atomic)
	if (urlPath === "/memories-index.json") {
		const idx = libraryIndex();
		const l = loadLibrary();
		const etag = `"idx-${l.filenames.length}-${l.dim}-${l.modelId}"`;
		if (request.headers.get("if-none-match") === etag) {
			return respond(304, null, null);
		}
		return respond(
			200,
			JSON.stringify(idx),
			"application/json; charset=utf-8",
			{
				"Cache-Control": "no-store",
				ETag: etag,
			},
		);
	}
	if (urlPath === "/memories-models.json") {
		return respond(
			200,
			JSON.stringify(modelsManifest()),
			"application/json; charset=utf-8",
			{
				"Cache-Control": "no-store",
			},
		);
	}
	if (
		urlPath === "/memory-embeddings.bin" ||
		urlPath === "/memory-phrase-embeddings.bin"
	) {
		const bins = cachedLibraryBins();
		const body = urlPath.endsWith("phrase-embeddings.bin")
			? bins.phrases
			: bins.embeddings;
		// ETag from the bin cache key (modelId|count|dim|phraseDim): the
		// renderer caches parsed Float32Arrays keyed on this, so a 304
		// means "same data — don't re-parse thousands of Float32Array views".
		const etag = `"${bins.key}"`;
		if (request.headers.get("if-none-match") === etag) {
			return respond(304, null, null);
		}
		return respond(200, body, "application/octet-stream", {
			"Cache-Control": "no-store",
			ETag: etag,
		});
	}
	// Scene-segment sidecars (Phase 1): ok:false means "no scene data for the
	// active model" — the renderer treats that as a SUCCESS (file-level
	// search is unchanged), never an error.
	if (urlPath === "/memory-segments.json") {
		const l = loadLibrary();
		const c = loadSegments(l.modelId);
		if (!c.loaded) {
			return respond(
				200,
				JSON.stringify({ ok: false }),
				"application/json; charset=utf-8",
				{
					"Cache-Control": "no-store",
				},
			);
		}
		const videos = [...c.videos.entries()].map(([filename, segments]) => ({
			filename,
			segments,
		}));
		return respond(
			200,
			JSON.stringify({
				ok: true,
				version: 1,
				modelId: c.modelId,
				dim: c.dim,
				total: c.rows.length,
				videos,
			}),
			"application/json; charset=utf-8",
			{ "Cache-Control": "no-store" },
		);
	}
	if (urlPath === "/memory-segment-embeddings.bin") {
		const c = loadSegments(loadLibrary().modelId);
		if (!c.loaded) return respond(404, "Not found", "text/plain");
		return respond(200, cachedSegmentsBin().buf, "application/octet-stream", {
			"Cache-Control": "no-store",
		});
	}
	// Transcript sidecars (speech index): ok:false means "no transcript data
	// for the active model" — renderer treats as SUCCESS (visual-only search
	// unchanged), never an error. Same header validation as segments.
	if (urlPath === "/memory-transcripts.json") {
		const l = loadLibrary();
		const c = loadTranscripts(l.modelId);
		if (!c.loaded) {
			return respond(
				200,
				JSON.stringify({ ok: false }),
				"application/json; charset=utf-8",
				{
					"Cache-Control": "no-store",
				},
			);
		}
		const videos = [...c.videos.entries()].map(([filename, chunks]) => ({
			filename,
			chunks,
		}));
		return respond(
			200,
			JSON.stringify({
				ok: true,
				version: 1,
				modelId: c.modelId,
				dim: c.dim,
				total: c.rows.length,
				videos,
			}),
			"application/json; charset=utf-8",
			{ "Cache-Control": "no-store" },
		);
	}
	if (urlPath === "/memory-transcript-embeddings.bin") {
		const c = loadTranscripts(loadLibrary().modelId);
		if (!c.loaded) return respond(404, "Not found", "text/plain");
		return respond(
			200,
			cachedTranscriptsBin().buf,
			"application/octet-stream",
			{
				"Cache-Control": "no-store",
			},
		);
	}

	// Photo thumbnails (lazy-generated, immutable — a thumbnail for a given
	// filename never changes). On a generation failure the request falls
	// through to the original-file route below so a tile never breaks (the
	// no-store fallback keeps the browser honest until the thumb exists).
	if (urlPath.startsWith("/images/thumbs/")) {
		const filename = path.basename(urlPath);
		if (
			filename &&
			ctx.imageExtensions.has(path.extname(filename).toLowerCase())
		) {
			try {
				const body = await fs.promises.readFile(await ensureThumb(filename));
				return respond(200, body, "image/jpeg", {
					"Cache-Control": "public, max-age=31536000, immutable",
				});
			} catch (err) {
				console.warn(
					`[memories] thumbnail failed for ${filename}: ${(err as { message?: string }).message}`,
				);
				/* fall through to the original-file route below */
			}
		}
	}

	// Posters (generated video thumbnails; never part of the index)
	if (urlPath.startsWith("/images/posters/")) {
		const filePath = ctx.posterFor(path.basename(urlPath)); // never allow traversal
		try {
			const body = await fs.promises.readFile(filePath);
			return respond(200, body, "image/jpeg", {
				"Cache-Control": "public, max-age=31536000, immutable",
			});
		} catch {
			return respond(404, "Not found", "text/plain");
		}
	}

	// In-app preview proxies for searchable-only videos (mkv/hevc/...): a
	// short mp4/h264 clip transcoded on demand around ?t= (the matched scene
	// timestamp). Deterministic cache name per (file, t) so repeat views
	// never re-transcode; failures are 404 so the lightbox falls back to the
	// poster. Range support mirrors /images/projects/ so <video> can seek.
	if (urlPath.startsWith("/images/preview/")) {
		const filename = path.basename(urlPath); // never allow traversal
		let t = 0;
		try {
			const q = new URL(request.url).searchParams.get("t");
			if (q !== null) t = Math.max(0, Number(q) || 0);
		} catch {
			t = 0;
		}
		const result = await ctx.ensurePreview(filename, t);
		if (!result.ok) {
			return respond(404, result.error || "preview unavailable", "text/plain");
		}
		const mime = "video/mp4";
		try {
			const stat = await fs.promises.stat(result.path);
			const range = request.headers.get("range");
			if (range) {
				const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
				if (m && (m[1] || m[2])) {
					const size = stat.size;
					let start = m[1] ? parseInt(m[1], 10) : 0;
					let end = m[2] ? parseInt(m[2], 10) : size - 1;
					if (!m[1] && m[2]) start = Math.max(0, size - parseInt(m[2], 10));
					if (end >= size) end = size - 1;
					if (start <= end && start < size) {
						const body = await openFileStreamRange(result.path, start, end);
						return respond(206, body, mime, {
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes ${start}-${end}/${size}`,
							"Content-Length": String(end - start + 1),
						});
					}
				}
				return respond(416, "Range not satisfiable", "text/plain", {
					"Content-Range": `bytes */${stat.size}`,
				});
			}
			const body = await openFileStreamRange(result.path, 0, stat.size - 1);
			return respond(200, body, mime, {
				"Accept-Ranges": "bytes",
				"Cache-Control": "public, max-age=86400",
			});
		} catch {
			return respond(404, "Not found", "text/plain");
		}
	}

	// Photos live in the library dir, at the same URL the components use.
	// Videos get Range support so the lightbox <video> can seek.
	if (urlPath.startsWith("/images/projects/")) {
		const filename = path.basename(urlPath); // never allow traversal
		const filePath = path.join(ctx.photosDir, filename);
		// Content-Type from the BYTES, not the extension: mislabeled files
		// (WebP bytes under a .png name) must not route into the wrong
		// Chromium image decoder, and unrecognized bytes must not inherit
		// ANY image/* claim (see imageContentType — the Sep-2026 trap).
		const extMime = MIME_TYPES[path.extname(filename).toLowerCase()];
		const mime = ctx.isVideo(filename)
			? extMime || "application/octet-stream"
			: ctx.imageContentType({
					sniffed: sniffImageMime(filePath),
					extMime,
				});
		try {
			const stat = await fs.promises.stat(filePath);
			const range = request.headers.get("range");
			if (range && ctx.isVideo(filename)) {
				const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
				if (m && (m[1] || m[2])) {
					const size = stat.size;
					let start = m[1] ? parseInt(m[1], 10) : 0;
					let end = m[2] ? parseInt(m[2], 10) : size - 1;
					if (!m[1] && m[2]) start = Math.max(0, size - parseInt(m[2], 10));
					if (end >= size) end = size - 1;
					if (start <= end && start < size) {
						// Stream the byte window instead of reading the whole
						// file into memory — a seek into a multi-GB video
						// must not load it all into the main process.
						const body = await openFileStreamRange(filePath, start, end);
						return respond(206, body, mime, {
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes ${start}-${end}/${size}`,
							"Content-Length": String(end - start + 1),
						});
					}
				}
				return respond(416, "Range not satisfiable", "text/plain", {
					"Content-Range": `bytes */${stat.size}`,
				});
			}
			const extra: Record<string, string> = ctx.isVideo(filename)
				? { "Accept-Ranges": "bytes", "Cache-Control": "no-store" }
				: { "Cache-Control": "no-store" };
			// Videos stream from disk (they can be gigabytes); photos are
			// small enough to buffer.
			const body =
				ctx.isVideo(filename) && stat.size > 0
					? await openFileStreamRange(filePath, 0, stat.size - 1)
					: await fs.promises.readFile(filePath);
			return respond(200, body, mime, extra);
		} catch {
			return respond(404, "Not found", "text/plain");
		}
	}

	// Renderer bundle
	if (urlPath === "/index.html" || urlPath === "/") {
		return respond(
			200,
			await fs.promises.readFile(path.join(ctx.rendererDir, "index.html")),
			"text/html; charset=utf-8",
			{
				"Cache-Control": "no-cache",
				"Content-Security-Policy": CSP,
			},
		);
	}
	// Any other renderer file (Vite bundle under /assets/, /fonts/, and
	// top-level static like /theme-bootstrap.js). resolveRenderer confines
	// reads to RENDERER_DIR (no traversal).
	const rendererFile = await resolveRenderer(urlPath);
	if (rendererFile) {
		const body = await fs.promises.readFile(rendererFile);
		const mime =
			MIME_TYPES[path.extname(rendererFile).toLowerCase()] ||
			"application/octet-stream";
		const extra = urlPath.startsWith("/assets/")
			? { "Cache-Control": "public, max-age=31536000, immutable" }
			: { "Cache-Control": "no-cache" };
		return respond(200, body, mime, extra);
	}
	return respond(404, "Not found", "text/plain");
}

function safeDecode(p: string) {
	try {
		return decodeURIComponent(p);
	} catch {
		return p;
	}
}

// ---------------------------------------------------------------------------
// Settings (persisted shortcut, etc.)
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readSettings live in main-lib/settings.ts (imported above).

// C-01 Wave 2 (S1): writeSettings live in main-lib/settings.ts (imported above).

// ---------------------------------------------------------------------------
// Video search quality (Settings → Video search): the scene-segment density
// preset for background enrichment. Stored in settings.json so the main
// process (which queues enrichment) and the renderer (which displays it)
// share one source of truth; the worker receives the resolved (target, min,
// max) triple per enrich-video message. Only affects enrichment planned
// AFTER the change — existing sidecars keep their old density until the
// user runs "Re-analyze videos".
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readVideoQuality live in main-lib/settings.ts (imported above).

// C-01 Wave 2 (S1): videoBudgetForCurrentQuality live in main-lib/settings.ts (imported above).

// ---------------------------------------------------------------------------
// Speech model (Settings → Video search → Speech model): the whisper engine
// for background transcription. Stored in settings.json (same validated-
// fallback pattern as video quality); the resolved id rides each
// transcribe-video message and the sidecar is stamped with it — a switch
// invalidates the sidecar (transcripts are model-quality-dependent) and
// re-queues every video. Default tiny.en = today's behavior.
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readWhisperModel live in main-lib/settings.ts (imported above).

// One-time migration off the removed small.en rung (OOM on 8GB Macs):
// stored settings + sidecar stamps carrying "small.en" resolve to base.en
// via parseWhisperModel, but a small-stamped sidecar would then look like a
// valid base.en sidecar and never re-transcribe. So when the raw stored
// value (or the raw sidecar stamp) is still "small.en", rewrite settings to
// base.en and invalidate the speech sidecar once — the launch backfill
// re-queues every video under base.en. Idempotent: no-ops when nothing
// still names small.en. Also sweeps the orphaned ~1GB small.en weight cache.

// C-01 Wave 2 (S1): cleanupRemovedWhisperWeights live in main-lib/settings.ts (imported above).

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------

function buildApplicationMenu() {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{
					label: "Import Photos…",
					accelerator: "CmdOrCtrl+O",
					click: () => pickAndImport(),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ role: "front" },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Renderer sandbox: contextIsolation + sandbox isolate the renderer from
// Node/the main process so a renderer compromise can't reach the OS. The
// preload requires only "electron" (sandbox-compatible), so sandbox:true is
// a drop-in. Exposed as a const so tests can assert on it (M-01).
const WEB_PREFERENCES = {
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
	preload: path.join(ctx.appDirname, "preload.js"),
	spellcheck: false,
	backgroundThrottling: false,
};

// Content-Security-Policy: the renderer is a local app:// bundle with no
// external fetches (models load in the main-process worker, not here), so
// everything is pinned to 'self'. style-src allows 'unsafe-inline' only
// because Tailwind/React may inject <style>; script-src is strict 'self'
// — the inline theme bootstrap was moved to /theme-bootstrap.js so no
// inline <script> remains. object/frame/base/form denied (M-02).
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

type PruneAbortedStatus = {
	type: "prune-aborted";
	missing: number;
	total: number;
};

// Boot-time prune runs before the first window exists. Keep the warning
// here so createWindow can replay it on ready-to-show (after React has
// subscribed to onStatus); a later prune (or a second window) also gets it
// immediately.
let pruneAbortedStatus: PruneAbortedStatus | null = null;

export function setPruneAbortedStatus(status: PruneAbortedStatus | null): void {
	pruneAbortedStatus = status;
	if (!status) return;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", status);
	}
}

function createWindow({ showOnReady = true }: { showOnReady?: boolean } = {}) {
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 900,
		minHeight: 600,
		backgroundColor: "#000000",
		show: false,
		fullscreen: false,
		fullscreenable: true,
		title: "SCM",
		icon: ctx.getAppIconImage() || undefined,
		webPreferences: WEB_PREFERENCES,
	});
	// Open at full window size (maximized windowed, never fullscreen) on
	// every launch — unless this is a start-hidden launch (menu-bar-only +
	// "start hidden"): the window still loads so the renderer is warm, but
	// stays invisible until summoned from the tray, shortcut, or Dock
	// activate. Maximized is a windowed zoom (fills workArea, keeps traffic
	// lights + Dock + menu bar), distinct from macOS fullscreen space.
	win.once("ready-to-show", () => {
		try {
			if (win.isFullScreen()) win.setFullScreen(false);
		} catch {
			/* leaving fullscreen is best-effort */
		}
		try {
			win.maximize();
		} catch {
			/* maximize is best-effort (headless/smoke) */
		}
		if (showOnReady) {
			win.show();
			// Defensive: some window managers restore fullscreen after show.
			try {
				if (win.isFullScreen()) win.setFullScreen(false);
			} catch {
				/* leaving fullscreen is best-effort */
			}
		}
		// The stale-entry guard runs before this window exists (see boot).
		// Replay its warning on first paint, after React has subscribed to
		// onStatus (did-finish-load can beat the effect that registers it).
		if (pruneAbortedStatus) {
			win.webContents.send("memories:status", pruneAbortedStatus);
		}
	});
	// Model status can resolve before the renderer subscribes (cached model
	// download, or a fast load on a warm cache); replay the latest state so
	// the UI always knows whether the AI engine is up.
	win.webContents.on("did-finish-load", () => {
		// Phase 1 (pool): modelStatus lives in the pool module.
		const poolStatus = getModelStatus();
		if (poolStatus) {
			win.webContents.send("memories:status", poolStatus);
		}
		// Background enrichment can start before the renderer subscribes
		// (e.g. the launch backfill); replay its state so the tray is
		// correct from the first paint.
		const snap = enrichSnapshot();
		if (snap.active || snap.pending > 0) {
			win.webContents.send("memories:status", snap);
		}
		try {
			const tsnap = transcribeSnapshot();
			if (tsnap.active || tsnap.pending > 0) {
				win.webContents.send("memories:status", tsnap);
			}
		} catch {
			/* transcribe snapshot optional pre-init */
		}
	});
	// Menu-bar-only mode: closing the window hides it to the menu bar
	// instead of quitting, so background work (indexing, watched folders,
	// global shortcut) keeps running with no Dock presence. Quit happens
	// from the tray menu / Cmd+Q, which set isQuitting via before-quit.
	win.on("close", (event) => {
		if (!ctx.isQuitting() && ctx.isMenuBarOnlyEnabled()) {
			event.preventDefault();
			win.hide();
		}
	});
	return win;
}

export {
	handleAppRequest,
	buildApplicationMenu,
	createWindow,
	WEB_PREFERENCES,
};
