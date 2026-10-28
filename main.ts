import {
	app,
	BrowserWindow,
	// Phase 1: Tray + Notification moved with chrome (tray core).
	shell,
	protocol,
	ipcMain,
	crashReporter,
	// Phase 1: dialog moved with import; utilityProcess moved with pool.
	nativeImage,
	// Phase 1: globalShortcut moved with chrome-settings (main/ipc/chrome-settings.ts).
} from "electron";
import fs from "node:fs";
import path from "node:path";
// Phase 1: crypto moved with import (hashFile).

// Phase 1: MODELS moved with versions (pruneOrphanSidecars).
import { DEFAULT_MODEL_ID, getModel } from "./indexer/models.js";
import { runSmokeModes } from "./main/smoke.js";
// Phase 1: buildFilenamePhrase moved with the llm/ask domain (main/ipc/llm-ask.ts).
import { SAMPLE_QUERIES } from "./indexer/memory-embedding-utils.js";
// Phase 1: sortPathsByMtime moved with import.
// Phase 1: segment scoring moved with pumps/enrich; suspectedTruncated
// moved with media (both require indexer/segment-store-utils.js directly).
// Phase 1: transcript chunk/assist moved with pumps/transcribe;
// parseWhisperModel moved with media (both require directly).
// Phase 1: probeScreenshotMetadata moved with import.
import {
	initSettings,
	APP_ICON_IDS,
	DEFAULT_APP_ICON,
	parseAppIcon,
	appIconFileFor,
	readAppIcon,
	readSettings,
	writeSettings,
	readVideoQuality,
	// Phase 1: readOcrLangsMigrated + shouldMigrateOcrLangs moved with pumps/ocr.
	readMenuBarOnly,
	// Phase 1: readNotifyOnDone moved with chrome (maybeNotify).
	readStartHidden,
	// Phase 1: readOnboardingSeen moved with chrome-settings (get-onboarding-seen).
} from "./main-lib/settings.ts";
import {
	initFailedImports,
	failedImportsFile,
	// Phase 1: failure-track helpers moved with import; clearFailedImports
	// moved with versions (reset path).
} from "./main-lib/failed-imports.ts";
import {
	initCategoryOverrides,
	// Phase 1: override store moved with reveal (set-category-override);
	// clearCategoryOverrides moved with versions (reset path).
} from "./main-lib/category-overrides.ts";
// Phase 1: llm/ask accessors moved with the domain (main/ipc/llm-ask.ts).
// main.js keeps only init (boot order) + stopServer (will-quit).
import { initLlmConfig } from "./main-lib/llm/config.ts";
import {
	initLlmServer,
	stopServer as stopLlmServer,
} from "./main-lib/llm/server.ts";
import { killTrackedChildren } from "./main-lib/child-registry.ts";
// One errorDetail spec shared with the ipc-wrapper (V2 layer 0).
import { errorDetail } from "./main-lib/ipc-error.ts";
import {
	initLibraryStore,
	resetLibraryCaches,
	// Phase 1: libraryGenerationNumber moved with rank-moments.
	embedFileFor,
	phraseFileFor,
	segmentsMetaFileFor,
	segmentsBinFileFor,
	// Phase 1: loadSampleQueries moved with the llm/ask domain (main/ipc/llm-ask.ts).
	loadLibrary,
	readBin,
	libraryIndex,
	// Phase 1: libraryNorms moved with rank-moments.
	// Phase 1: enqueuePersist moved with versions (drainPersistQueue).
	// Phase 1: bin calibration moved with migration (main/ipc/migration.ts).
	saveLibrary,
	backfillSourceMtimes,
	loadSegments,
	saveSegments,
	// Phase 1: sidecar sweepers + resetModelStateCache moved with versions.
	repairUntranscribedWithAudio,
	loadModelState,
	saveModelState,
	thresholdsFor,
	binInfo,
	cosine,
} from "./main-lib/library-store.js";
// Phase 1: version CRUD moved with versions (init stays for boot).
import { initEmbeddingVersions } from "./main-lib/embedding-versions.ts";
// Phase 1: resetLibraryFiles moved with versions (reset path; init stays).
import { initLibraryReset } from "./main-lib/library-reset.ts";
// Phase 1: rank-search scoring moved with rank-moments (main/ipc/rank-moments.ts).
import * as youtube from "./main-lib/youtube.ts";
// Shared context holder for the main/ipc/* domains. Declared HERE (not at
// the first stub) because stubs run in file order during evaluation and
// several stubs above the llm-ask one assign slots — a later declaration
// throws ReferenceError (TDZ) on boot. Caught by the Electron reveal smoke,
// invisible to unit tests (they never load main.js).
import mainContext from "./main/context.ts";

// ---------------------------------------------------------------------------
// POSITIONAL REQUIRES (kept as requires on purpose, unlike every other
// file in the migration — see the note below for why they must not become
// hoisted ESM imports).
/* eslint-disable @typescript-eslint/no-require-imports -- the positional ipc-domain requires
 * below are the architecture: watched.ts and protocol.ts read VALUE context
 * slots in top-level initializers, and hoisted ESM imports would race the
 * assignments that must land first (the emitted dist-main/main.js is CJS,
 * so these are native requires there and the load order is preserved). */
// converted file): the main/ipc domains below read VALUE context slots in
// their top-level initializers (watched.ts's WATCHED_FOLDERS_FILE from
// ctx.dataDir, protocol.ts's WEB_PREFERENCES.preload from ctx.appDirname),
// and ESM imports would hoist every require ABOVE this body — racing the
// assignments that must land first. The requires stay at their exact
// pre-conversion positions; the emitted dist-main/main.js is CJS, so these
// are native requires there and the load order is preserved 1:1. The source
// main.ts is never executed (the main-load harness runs the compiled mirror,
// and dev/packaged Electron loads package.json's dist-main entry).
// ---------------------------------------------------------------------------

const SCHEME = "app";

// Test isolation: point the whole app (library, models, single-instance
// lock) at a scratch dir. Must happen before the lock/ready paths resolve
// any app paths. Crash dumps follow it (crashReporter below) so smoke runs
// can never write into the developer's real Library.
if (process.env.MEMORIES_DATA_DIR) {
	app.setPath("userData", process.env.MEMORIES_DATA_DIR);
	app.setPath(
		"crashDumps",
		path.join(process.env.MEMORIES_DATA_DIR, "crashdumps"),
	);
}

// ---------------------------------------------------------------------------
// macOS system media controls: OFF. Field crash (0.2.4, Oct-2026, reported):
// switching scene results while a video played terminated the whole app with
// EXC_BREAKPOINT/SIGTRAP, main thread in -[MPRemoteCommand removeTarget:action:]
// inside Chromium's macOS Now-Playing integration.
//
// That integration is Chromium's `HardwareMediaKeyHandling` feature
// (media/base/media_switches.cc, on by default on macOS). When it is on,
// Chromium builds a SystemMediaControlsMac for the browser, which registers
// MPRemoteCommandCenter targets (components/system_media_controls/mac/
// remote_command_center_delegate_cocoa.mm: addTarget:action:/removeTarget:)
// and tears them down on every media-session transition — exactly the crash
// stack. Disabling the feature removes the only MPRemoteCommandCenter
// consumers in Chromium (content/public/browser/media_keys_listener_manager.cc
// gates MediaKeysListenerManager, and with it SystemMediaControls, on this
// feature), so the crash path is never entered.
//
// Cost: in-app videos no longer appear in Control Center / Now Playing and no
// longer respond to hardware media keys. SCM never uses navigator.mediaSession
// — this OS integration was automatic and unwanted crash surface. Do not
// remove this switch without evidence the upstream bug is fixed (see
// AGENTS.md, "Never do this").
// ---------------------------------------------------------------------------
const SYSTEM_MEDIA_CONTROLS_DISABLED = process.platform === "darwin";
if (SYSTEM_MEDIA_CONTROLS_DISABLED) {
	// Merge with whatever the command line already carries — a bare
	// appendSwitch would overwrite it (Chromium's CommandLine is a map,
	// last append wins).
	const existing = app.commandLine.getSwitchValue("disable-features") || "";
	const disabled = new Set(
		existing
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);
	disabled.add("HardwareMediaKeyHandling");
	app.commandLine.appendSwitch("disable-features", [...disabled].join(","));
}

// ---------------------------------------------------------------------------
// Local crash forensics: Crashpad minidumps for main/renderer/child-process
// crashes, collected on disk and NEVER uploaded (uploadToServer: false, so no
// submitURL). Dumps land under app.getPath("crashDumps") — logged at startup
// below so a field report can be asked for the directory verbatim. The 0.2.4
// SIGTRAP (see the block above) arrived with a stack but no dump; from here
// on the next native crash ships with one. Started before ready so startup
// crashes are captured too. Best-effort: forensics must never block boot.
// ---------------------------------------------------------------------------
try {
	crashReporter.start({ uploadToServer: false });
} catch {
	/* best-effort */
}

// ---------------------------------------------------------------------------
// Persistent file logging: the packaged app's stdout goes nowhere on macOS,
// so a native crash (SIGTRAP/SIGSEGV in Electron Framework) leaves zero
// context about what the app was doing. Every console line is therefore also
// appended to userData/logs/main-YYYYMMDD.log (rotated by size, pruned by
// age). All best-effort: logging must never throw, block, or grow unbounded.
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(app.getPath("userData"), "logs");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_DAYS = 14;

// Today's log file, set by initFileLogging. logBreadcrumb (below) appends to
// it synchronously.
let LOG_FILE: string | null = null;

function initFileLogging() {
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		const file = path.join(LOG_DIR, `main-${day}.log`);
		LOG_FILE = file;
		try {
			const stat = fs.statSync(file);
			if (stat.size >= LOG_MAX_BYTES) {
				try {
					fs.renameSync(file, `${file}.1`);
				} catch {
					/* overwrite below */
				}
			}
		} catch {
			/* no log yet today */
		}
		// Prune logs older than the window (filename-dated, lexicographic).
		try {
			const cutoff = new Date(Date.now() - LOG_KEEP_DAYS * 86400_000)
				.toISOString()
				.slice(0, 10);
			for (const entry of fs.readdirSync(LOG_DIR)) {
				const m = /^main-(\d{4}-\d{2}-\d{2})\.log(\.1)?$/.exec(entry);
				// Cast: the capture group always participates in this pattern.
				if (m && (m[1] as string) < cutoff) {
					try {
						fs.unlinkSync(path.join(LOG_DIR, entry));
					} catch {
						/* best-effort */
					}
				}
			}
		} catch {
			/* best-effort */
		}
		const stream = fs.createWriteStream(file, { flags: "a" });
		stream.on("error", () => {});
		const stamp = () => new Date().toISOString();
		for (const level of ["log", "warn", "error"] as const) {
			const orig = console[level].bind(console);
			console[level] = (...args: unknown[]) => {
				orig(...(args as []));
				try {
					const line = args
						.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
						.join(" ");
					stream.write(`${stamp()} [${level}] ${line}\n`);
				} catch {
					/* logging must never throw */
				}
			};
		}
		stream.write(`${stamp()} [log] --- SCM start (pid ${process.pid}) ---\n`);
	} catch {
		/* file logging unavailable; console still works */
	}
}

// ---------------------------------------------------------------------------
// Breadcrumbs: the user-action trail for the next native crash, fed by the
// renderer through the memories:breadcrumb channel (lightbox open/switch/
// close today — the surface the 0.2.4 SIGTRAP fired on). Written with
// appendFileSync at call time on purpose: the console stream above buffers,
// and a hard kill can take its buffered tail with it — exactly what the field
// crash did. Lines are small, rare and user-paced; sanitize + cap so the log
// can never grow unbounded from here. Never throws.
// ---------------------------------------------------------------------------
const BREADCRUMB_MAX_CHARS = 300;

function logBreadcrumb(text: string) {
	try {
		// One breadcrumb = one log line: flatten every whitespace run
		// (newlines included), then cap the length below.
		const clean = String(text).replace(/\s+/g, " ").trim();
		if (!clean) return;
		const line = `${new Date().toISOString()} [breadcrumb] ${clean.slice(0, BREADCRUMB_MAX_CHARS)}\n`;
		if (LOG_FILE) fs.appendFileSync(LOG_FILE, line);
		process.stdout.write(line);
	} catch {
		/* forensics must never throw */
	}
}

// ---------------------------------------------------------------------------
// Last-resort error logging (main process). Nothing else installs global
// handlers, so a rejected background promise or a synchronous throw reaches
// the host default without a line in main-YYYYMMDD.log — the same blind spot
// the breadcrumbs were added for. These handlers add logging only: after
// writing, they detach and re-emit, so the host's existing fate (Electron's
// crash dialog, or Node's exit) is unchanged.
//
// Installed from app.whenReady() on purpose: the stub-electron load harness
// never settles whenReady, so a load-time crash still fails the harness
// instead of being swallowed by a handler.
// ---------------------------------------------------------------------------
const LAST_RESORT_MAX_CHARS = 4000;
let globalErrorLoggingInstalled = false;

function logLastResort(tag: string, err: unknown) {
	const detail = errorDetail(err).slice(0, LAST_RESORT_MAX_CHARS);
	// console is the buffered stream; the synchronous append is what
	// survives a hard kill (same reason logBreadcrumb uses appendFileSync).
	try {
		console.error(`[${tag}] ${detail}`);
	} catch {
		/* logging must never throw */
	}
	try {
		if (LOG_FILE) {
			fs.appendFileSync(
				LOG_FILE,
				`${new Date().toISOString()} [${tag}] ${detail}\n`,
			);
		}
	} catch {
		/* forensics must never throw */
	}
}

function installGlobalErrorLogging() {
	if (globalErrorLoggingInstalled) return;
	globalErrorLoggingInstalled = true;

	function onUnhandledRejection(reason: unknown) {
		logLastResort("unhandled-rejection", reason);
		detach();
		// Re-emit under the host's original policy (Node's throw/warn, or
		// Electron's dialog) instead of silently swallowing it here.
		void Promise.reject(reason);
	}

	function onUncaughtException(err: unknown) {
		logLastResort("uncaught-exception", err);
		detach();
		throw err instanceof Error ? err : new Error(errorDetail(err));
	}

	function detach() {
		process.removeListener("unhandledRejection", onUnhandledRejection);
		process.removeListener("uncaughtException", onUncaughtException);
	}

	process.on("unhandledRejection", onUnhandledRejection);
	process.on("uncaughtException", onUncaughtException);
}

initFileLogging();

// Support-visible record of the macOS media-controls disable above: the next
// time a field crash arrives, the log states whether the crash-surface
// feature was off in that build.
if (SYSTEM_MEDIA_CONTROLS_DISABLED) {
	console.log(
		"[startup] macOS system media controls disabled (HardwareMediaKeyHandling off)",
	);
}

// Crash-forensics pointer: minidumps (never uploaded — see the
// crashReporter.start block above) land in this directory; support asks for
// it verbatim when a native crash is reported.
console.log(`[startup] crash dumps (local only): ${app.getPath("crashDumps")}`);

// App-root asset base (ts-migration Stage A): compiled main.js runs from
// dist-main/, but the renderer bundle (dist/) and public/ stay at the app
// root — repo root in dev, asar root packaged. __dirname-relative paths
// into the mirrored tree (main/**, main-lib/**, indexer/**, shared/**,
// preload.js) keep working; everything app-root-relative goes through
// APP_ROOT.
const APP_ROOT = app.getAppPath();
const RENDERER_DIR = path.join(APP_ROOT, "dist");
const DATA_DIR = path.join(app.getPath("userData"), "library");
// Assigned HERE (not at a stub): main/ipc modules read these in top-level
// const initializers (watched.ts WATCHED_FOLDERS_FILE, protocol.ts
// WEB_PREFERENCES.preload), and modules load via require chains before any
// stub runs — a stub assignment would race them. Same rule as context.ts
// documents: value slots needed at module top must be assigned at top.
mainContext.dataDir = DATA_DIR;
// Compiled runs: this is dist-main/ (preload.js is emitted beside main.js,
// so protocol.ts's join(appDirname, "preload.js") resolves there). Source
// runs (tests, harness): the repo root, where preload.js lives too.
mainContext.appDirname = __dirname;
// settings.json is the source of truth for Appearance etc. Must be defined
// before any helper that reads it (app-icon loader) — otherwise TDZ makes
// the first APP_ICON load fall back to default even when a choice is persisted.
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
initSettings({ userDataDir: app.getPath("userData") });
initFailedImports({ dataDir: DATA_DIR });
initCategoryOverrides({ dataDir: DATA_DIR });
initLibraryStore({ userDataDir: app.getPath("userData") });
initEmbeddingVersions({ userDataDir: app.getPath("userData") });
initLibraryReset({ dataDir: DATA_DIR });
initLlmConfig({ userDataDir: app.getPath("userData") });
youtube.initYoutube({ userDataDir: app.getPath("userData") });
// LLMs-mode sidecar (main-lib/llm/server.ts): status events ride the same
// memories:status channel as every other tray. Idle download/spawn work is
// broadcast-only — the tray logic deliberately never reads "llm" events.
initLlmServer({
	userDataDir: app.getPath("userData"),
	broadcast: (payload) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", payload);
		}
	},
});

// App icon (Dock + BrowserWindow). Users pick one of the 1024×1024 PNGs in
// public/images/app-icons/ via Settings → Appearance. Persisted as
// settings.json `appIcon` (validated; defaults to scm-vhs). Loaded through fs
// rather than by path: nativeImage cannot read from inside the packaged
// app.asar, while fs.readFileSync is asar-aware. The packaged bundle already
// carries SCM.icns, so this is mostly a dev-mode/runtime Dock nicety — and it
// must never be able to block the app from opening.

// C-01 Wave 2 (S1): APP_ICON_IDS, DEFAULT_APP_ICON live in main-lib/settings.ts (imported above).

// In-memory staging for hidden-Dock case. Must be defined before
// APP_ICON init which runs at module load (TDZ guard).
let menuBarOnlyEnabled = false;
let pendingDockIcon: Electron.NativeImage | null = null;
let pendingDockIconId: string | null = null;
let currentAppIconId: string | null = DEFAULT_APP_ICON;

// Dev-time drift guard: main.js and src/lib/appIcons.ts must list the same
// ids. The renderer parses the same ids; a drift would make the main reject
// an id the UI offers (or vice versa) and the "didn't change" bug would look
// like a hidden-Dock bug. In dev we read the TS source and warn.
try {
	const tsPath = path.join(APP_ROOT, "src/lib/appIcons.ts");
	if (fs.existsSync(tsPath)) {
		const ts = fs.readFileSync(tsPath, "utf-8");
		const m = ts.match(/APP_ICON_IDS\s*=\s*\[([\s\S]*?)\]/);
		if (m) {
			// Cast: the capture group always participates in this pattern.
			const ids = [...(m[1] as string).matchAll(/"([^"]+)"/g)].map(
				(x) => x[1] as string,
			);
			const mainSet = new Set(APP_ICON_IDS);
			const tsSet = new Set(ids);
			const missingInMain = ids.filter((id) => !mainSet.has(id));
			const missingInTs = APP_ICON_IDS.filter((id) => !tsSet.has(id));
			if (missingInMain.length || missingInTs.length) {
				console.warn(
					`[app-icon] APP_ICON_IDS drift: missingInMain=${missingInMain.join(",") || "—"} missingInSrc=${missingInTs.join(",") || "—"}`,
				);
			}
		}
	}
} catch {
	/* drift guard is best-effort dev only */
}

// C-01 Wave 2 (S1): parseAppIcon live in main-lib/settings.ts (imported above).

// C-01 Wave 2 (S1): appIconFileFor live in main-lib/settings.ts (imported above).

function loadAppIconImage(id: string) {
	const safeId = parseAppIcon(id);
	const filename = appIconFileFor(safeId);
	const candidates = [
		path.join(APP_ROOT, "dist/images/app-icons", filename),
		path.join(APP_ROOT, "public/images/app-icons", filename),
		// Legacy fallback (single icon before the chooser existed)
		path.join(APP_ROOT, "public/images/icns/SCM.png"),
		path.join(APP_ROOT, "dist/images/icns/SCM.png"),
	];
	for (const file of candidates) {
		try {
			const buf = fs.readFileSync(file);
			const img = nativeImage.createFromBuffer(buf);
			if (!img.isEmpty()) return img;
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

// C-01 Wave 2 (S1): readAppIcon live in main-lib/settings.ts (imported above).

function currentAppIconImage() {
	return loadAppIconImage(readAppIcon());
}

// NOTE: an earlier applyAppIcon() helper was fully superseded by the
// memories:set-app-icon IPC handler below (which adds validation, settings
// persistence, and tray feedback) — it was deleted in Phase 0 (N-04) as
// dead code. Icon application lives in the handler now.
let APP_ICON: Electron.NativeImage | null = currentAppIconImage();
try {
	currentAppIconId = readAppIcon();
} catch {
	currentAppIconId = DEFAULT_APP_ICON;
}
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const POSTERS_DIR = path.join(DATA_DIR, "posters");
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
// Phase 1: preview-proxy consts + pending map moved with previews
// (main/ipc/previews.ts, required here so its shared-slot assignments run;
// PREVIEWS_DIR-adjacent boot/prune logic is unchanged).
require("./main/ipc/previews.js");
const INDEX_FILE = path.join(DATA_DIR, "memories-index.json");
// Pre-v4 libraries wrote one bin pair for the default model; v4+ writes a
// pair PER MODEL (memory-embeddings-<modelId>.bin) so switching models never
// destroys another model's embeddings. The legacy names are still read as a
// fallback when a model's own bins are absent (one-time upgrade).
// (Paths live in main-lib/library-store.js; this file keeps only INDEX_FILE.)
// Per-model persisted state: calibrated ranking thresholds etc.

// C-01 Wave 2 (S4): loadSampleQueries live in main-lib/library-store.js (required at top).

// C-01 Wave 2 (S4): sidecar path helpers live in main-lib/library-store.js (required at top).

// Same set as the site's build (scripts/build-memory-embeddings-core.js)
const IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".heic",
	".heif",
	".JPG",
	".JPEG",
	".PNG",
	".GIF",
	".WEBP",
	".HEIC",
	".HEIF",
]);

// Videos import through ffmpeg frame extraction (see indexer/ffmpeg-process.js,
// the same list must stay in sync with src/lib/media.ts). Everything ffmpeg
// can decode becomes searchable; renderer playability is a narrower set.
const VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".m4v",
	".webm",
	".mkv",
	".avi",
	".ts",
	".m2ts",
	".mts",
	".mpg",
	".mpeg",
	".wmv",
	".flv",
	".3gp",
	".MP4",
	".MOV",
	".M4V",
	".WEBM",
	".MKV",
	".AVI",
	".TS",
	".M2TS",
	".MTS",
	".MPG",
	".MPEG",
	".WMV",
	".FLV",
	".3GP",
]);

const IMPORT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

// Poster sidecar naming: every imported video gets a generated JPEG in
// POSTERS_DIR with the same basename, so the renderer can derive the URL
// purely from the filename (no index change needed).
function posterFor(filename: string) {
	return path.join(
		POSTERS_DIR,
		path.basename(filename, path.extname(filename)) + ".jpg",
	);
}

// Photo thumbnail sidecar: a ~480px JPEG in THUMBS_DIR, derived from the
// filename exactly like posters (basename minus extension + ".jpg"). The
// grid renders this instead of the original — see ensureThumb.

// C-01 Wave 2 (S4): thumbFor live in main-lib/library-store.js (required at top).

function isVideo(filename: string) {
	return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// Phase 1: MIME_TYPES moved with protocol (its only reader).

// Magic-byte sniffing for served/stored images. Files arrive with arbitrary
// extensions (screenshots saved as .png that are really WebP, downloads
// renamed by hand), and the app:// protocol historically answered with the
// MIME for the EXTENSION. Blink picks its image decoder from that MIME, so
// WebP bytes served as image/png route into the PNG decoder — a wrong-decoder
// hazard that has crashed Electron/Chromium on macOS Tahoe (EXC_BREAKPOINT /
// SIGTRAP on a ThreadPoolForegroundWorker inside the framework's Rust image
// code; the stripped frames all alias to ares_dns_rr_get_ttl; Sep-2026
// production incident on 0.2.1). The bytes, not the name, must decide the
// Content-Type — and unrecognized bytes must never inherit an image/* claim
// (see imageContentType). See indexer/mime-sniff.js.
// Phase 1: canonicalImageExt moved with import (sniffImageMime stays
// for the protocol; the import module requires the pure module directly).
const { imageContentType } = require("./indexer/mime-sniff.js");

protocol.registerSchemesAsPrivileged([
	{
		scheme: SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			stream: true,
		},
	},
]);

// C-01 Wave 2 (S4): library store live in main-lib/library-store.js (required at top).

// Queries with no semantic content: the top cosine any one of them can reach
// against the library is the noise ceiling for the ACTIVE model's score band.
const NOISE_QUERIES = [
	"zzz nothing to see here",
	"qwerty gibberish",
	"random noise photo",
	"this is not a real query",
	"unrelated nonsense text",
	"aaa bbb ccc ddd",
];

// Measure a model's score band on the CURRENT in-memory library and persist
// per-model thresholds: minSemanticScore sits between the noise ceiling
// (worst top-1 cosine of a nonsense query) and the weakest genuine match
// (SAMPLE_QUERIES' worst top-1), with a generous floor between them. Each
// model's anisotropy differs, so the CLIP-tuned 0.04 must not be assumed.
// Returns the thresholds, or null when the library is too small to measure.
async function calibrateThresholds(modelId: string) {
	const l = loadLibrary();
	// A retired-model library temporarily names its replacement so the worker
	// can warm it, but its stored rows are still from the old vector space.
	// Never calibrate or persist any replacement state until the migration
	// commits its complete new bin pair.
	if (l.pendingModelMigration) return null;
	if (l.filenames.length === 0 || l.embeddings.length !== l.filenames.length) {
		return null;
	}
	const noise: number[] = [];
	const genuine: number[] = [];
	for (const query of [...NOISE_QUERIES, ...SAMPLE_QUERIES]) {
		const reply = await askIndexer({ type: "embed-query", text: query });
		if (!reply.vec || reply.vec.length !== l.dim) continue;
		let top = 0;
		for (const row of l.embeddings) {
			let dot = 0;
			// Cast: dense parallel rows (the established loop-bound pattern).
			for (let k = 0; k < l.dim; k++) dot += reply.vec[k] * (row[k] as number);
			if (dot > top) top = dot;
		}
		(NOISE_QUERIES.includes(query) ? noise : genuine).push(top);
	}
	if (noise.length === 0) return null;
	const noiseCeiling = Math.max(...noise);
	let minSemanticScore = Math.min(0.1, Math.max(0.01, noiseCeiling * 2));
	if (genuine.length > 0) {
		const weakestGenuine = Math.min(...genuine);
		if (minSemanticScore > weakestGenuine * 0.5) {
			minSemanticScore = Math.max(0.01, weakestGenuine * 0.5);
		}
	}
	const thresholds = {
		minSemanticScore: Math.round(minSemanticScore * 10000) / 10000,
		relativeKeep: 0.6,
	};
	loadModelState().models[modelId] = {
		...loadModelState().models[modelId],
		thresholds,
		calibratedAt: new Date().toISOString(),
	};
	saveModelState();
	console.log(
		`[memories] calibrated ${modelId}: noiseCeiling=${noiseCeiling.toFixed(4)} ` +
			`minSemanticScore=${thresholds.minSemanticScore} ` +
			`(weakestGenuine=${genuine.length ? Math.min(...genuine).toFixed(4) : "n/a"})`,
	);
	return thresholds;
}

// A text-model outage at import time persists all-zero phrase rows (the
// fallback in importPaths), silently disabling the phrase boost; a bin left
// ---------------------------------------------------------------------------
// Stale-entry cleanup: library rows whose photo files no longer exist on
// disk (deleted manually or when the source folder was removed). These
// ghost entries cause endless "thumbnail failed" warnings and waste OCR
// backfill cycles. Runs once on startup, before the backfill passes.
// ---------------------------------------------------------------------------
async function pruneStaleLibraryEntries(): Promise<{
	type: "prune-aborted";
	missing: number;
	total: number;
} | null> {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames) || l.filenames.length === 0)
		return null;
	const total = l.filenames.length;
	// First pass: count missing files. A mass-missing signal (the photos
	// dir was emptied by a "cleaner", a volume is unmounted, a backup
	// restore is half-applied) means the right move is to STOP, not to wipe
	// the index to match — pruning only makes sense when a FEW rows are
	// genuinely stale. PHOTOS_DIR always exists (loadLibrary mkdirs it), so
	// an empty dir surfaces here as "every row's file is missing".
	let missing = 0;
	for (let i = 0; i < total; i++) {
		const filename = l.filenames[i];
		if (!filename) continue;
		if (!fs.existsSync(path.join(PHOTOS_DIR, filename))) missing++;
	}
	if (missing === 0) return null;
	const threshold = Math.max(1, Math.ceil(total / 2));
	if (missing >= threshold) {
		// Refuse to wipe: persist nothing, surface the state, let the user
		// resolve the underlying cause (remount, restore, re-point) and
		// retry on the next launch. This is the guard against the silent
		// library wipe documented in C-05. The caller hands this to
		// protocol.ts so the warning survives until a renderer exists.
		console.warn(
			`[memories] stale-entry cleanup ABORTED: ${missing}/${total} photos missing (≥50%) — refusing to prune to avoid a silent library wipe`,
		);
		return { type: "prune-aborted", missing, total };
	}
	let removed = 0;
	// Walk backwards so splicing doesn't shift unvisited indices.
	for (let i = l.filenames.length - 1; i >= 0; i--) {
		const filename = l.filenames[i];
		if (!filename) continue;
		if (fs.existsSync(path.join(PHOTOS_DIR, filename))) continue;
		// File is gone — remove the entire row (copy, index arrays,
		// sidecars). removeLibraryRow tolerates a missing copy.
		if (removeLibraryRow(filename)) removed++;
	}
	if (removed > 0) {
		await saveLibrary();
		console.log(
			`[memories] stale-entry cleanup: removed ${removed} row(s) with missing files`,
		);
	}
	return null;
}

// misaligned by a partial write is unusable too. Detect and re-embed those
// rows through the indexer once the text model is ready. Returns the number
// healed.
//
// Detection: a real filename-phrase embedding is a CLIP TEXT vector, which
// never equals its photo's IMAGE vector (dot ≈ 0..0.3), so dot > 0.9999 is
// an exact image copy; norm ≈ 0 is the all-zero fallback. A phrase bin that
// failed to load at all (count mismatch) is rebuilt in full.
async function healPhraseBin() {
	if (getMigrationState()) {
		// The library is mid-flip; healing the ACTIVE model's bin now could
		// interleave with the migration's writes. Skip — the next startup
		// (or a switch back) heals it.
		return { healed: 0, attempted: 0 };
	}
	const l = loadLibrary();
	// See calibrateThresholds: a pending retirement migration must preserve
	// the old index on disk until its replacement vectors are complete.
	if (l.pendingModelMigration) return { healed: 0, attempted: 0 };
	if (l.filenames.length === 0) return { healed: 0, attempted: 0 };

	let corrupt: string[];
	if (l.phrases.length !== l.filenames.length) {
		// Unusable bin (wrong count/dim): rebuild every row.
		corrupt = l.filenames.slice();
	} else {
		corrupt = [];
		for (let i = 0; i < l.filenames.length; i++) {
			const ph = l.phrases[i];
			const im = l.embeddings[i];
			if (!ph || !im || ph.length === 0) continue;
			let dot = 0;
			let norm = 0;
			for (let k = 0; k < ph.length; k++) {
				// Casts: parallel rows are dense in a loaded library (the
				// established loop-bound read pattern).
				const phv = ph[k] as number;
				const imv = (im[k] as number) || 0;
				dot += phv * imv;
				norm += phv * phv;
			}
			if (norm < 1e-6 || dot > 0.9999) corrupt.push(l.filenames[i] as string);
		}
	}
	if (corrupt.length === 0) return { healed: 0, attempted: 0 };

	console.log(`[memories] healing ${corrupt.length} corrupted phrase rows…`);
	let healed = 0;
	for (const filename of corrupt) {
		try {
			const reply = await askIndexer({ type: "embed-phrase", filename });
			if (reply && reply.vec && reply.vec.length === l.dim) {
				// Rows can shift while healing runs (a delete or import can
				// land mid-heal); resolve the row by filename so the vector
				// lands on the right entry — a vanished file is skipped.
				const j = l.filenames.indexOf(filename);
				if (j !== -1) {
					l.phrases[j] = new Float32Array(reply.vec);
					healed++;
				}
			}
		} catch (err) {
			console.warn(
				`[memories] phrase heal failed for ${filename}: ${(err as { message?: string }).message}`,
			);
		}
	}
	if (healed > 0) {
		await saveLibrary();
		console.log(`[memories] healed ${healed}/${corrupt.length} phrase rows`);
	}
	return { healed, attempted: corrupt.length };
}

// ---------------------------------------------------------------------------
// Indexer worker pool (utilityProcess — plain Node, exactly the environment
// the site's build script runs in).
//
// A small pool of workers, each holding its own CLIP model, lets import
// batches embed several files at once and keeps search queries from queueing
// behind a long video embed. The first worker ("primary") is spawned eagerly
// and drives the AI status LED + first-run download; extra workers are forked
// only after the primary's model is ready (a first launch must never race the
// download). Dispatch is round-robin over live workers; import batches
// collect replies in file order (see importPaths).
//
// Note: on this machine ONNX Runtime already saturates all cores for a
// single run and ignores thread-count env vars, so measured E2E import time
// is fastest with a single worker (7.0s vs 7.5s at 2-3 workers on the smoke
// batch). Pool size > 1 buys query responsiveness during imports (a search
// no longer queues behind a multi-second video embed) and headroom for GPU
// workers, at the cost of aggregate embed throughput. The default follows
// the measurement; INDEXER_POOL_SIZE=2/3 opts into the pool.
// ---------------------------------------------------------------------------
// Indexer worker pool: MOVED to main/ipc/pool.ts (Phase 1, pure move -
// 2026-10-10). No behavior change: same placement, timeouts, broadcasts.
// Shared refs sibling modules still need arrive via main/context.js
// (reassigned here from the module's own bindings; read at call time).
// Stayer-needed refs re-exported below (boot, tray, purge, will-quit,
// indexer-status handler, e2e ctxs).
// ---------------------------------------------------------------------------
const {
	INDEXER_POOL_SIZE,
	indexerWorkers,
	getIndexerReady,
	indexerFfmpegPids,
	transcribeFfmpegPids,
	trackFfmpegSpawn,
	untrackFfmpegExit,
	killTrackedFfmpegPids,
	requestWorkerKillFfmpeg,
	reapStaleFfmpegOrphans,
	// (getModelStatus moved with the handlers' home; tray + replay read
	// it via the pool module directly.)
	modelDownloaded,
	poolModelId,
	indexerEnv,
	spawnIndexer,
	askIndexer,
	askPrimaryIndexer,
	restartPrimaryIndexer,
	stopIndexerPool,
	getIndexerInitFailed,
} = require("./main/ipc/pool.js");
mainContext.spawnIndexer = spawnIndexer;
mainContext.getIndexerReady = getIndexerReady;
mainContext.askIndexer = askIndexer;
mainContext.indexerEnv = indexerEnv;
mainContext.askPrimaryIndexer = askPrimaryIndexer;
mainContext.restartPrimaryIndexer = restartPrimaryIndexer;
mainContext.getIndexerInitFailed = getIndexerInitFailed;
mainContext.indexerPoolSize = INDEXER_POOL_SIZE;
mainContext.modelDownloaded = modelDownloaded;
mainContext.stopIndexerPool = stopIndexerPool;
mainContext.trackFfmpegSpawn = trackFfmpegSpawn;
mainContext.untrackFfmpegExit = untrackFfmpegExit;
mainContext.transcribeFfmpegPids = transcribeFfmpegPids;
mainContext.poolModelId = poolModelId;

// ---------------------------------------------------------------------------
// Model switching: MOVED to main/ipc/migration.ts (Phase 1, pure move -
// 2026-10-10). No behavior change: same checkpoints, calibration,
// broadcasts. Shared refs the domain still needs arrive via main/context.js
// (assigned here; read at call time). Stayer-needed refs re-exported below
// (pool gate, versions restore, set-model handler, boot, e2e ctxs).
// ---------------------------------------------------------------------------
// Phase 1 (pool): pool slots now arrive from the pool module (assigned
// at its stub above); the bindings this stub closed over have moved.
const {
	reembedToModel,
	// (preloadModelWeights moved with the preload handlers; only the
	// sweep below still needs the fan-out.)
	preloadAllModels,
	modelPreloads,
	migrationSettled,
	migratePendingModel,
	maybeResumeDeltaFill,
	getMigrationState,
	// Phase 1 (versions): get/setWorkerModelId moved with versions
	// (restore path); poolModelId reads it via the migration module.
} = require("./main/ipc/migration.js");
// calibrateThresholds stays in main.js (still beside this stub); the
// migration module reads it at call time.
mainContext.calibrateThresholds = calibrateThresholds;

// ---------------------------------------------------------------------------
// Import pipeline + library rows: MOVED to main/ipc/import.ts (Phase 1, pure
// move - 2026-10-10). No behavior change: same dedupe, retries, checkpoints,
// tombstones, row deletes. Shared refs the domain still needs arrive via
// main/context.js (assigned here; read at call time). Stayer-needed refs
// re-exported below (tray menu, prune, boot, e2e ctxs).
// ---------------------------------------------------------------------------
mainContext.importExtensions = IMPORT_EXTENSIONS;
mainContext.videoExtensions = VIDEO_EXTENSIONS;
// Phase 1 (previews): generatePoster now arrives from the previews module
// (assigned at require time in its stub below).
mainContext.posterFor = posterFor;
// Phase 1 (pool): getIndexerInitFailed + indexerPoolSize now arrive from
// the pool module (assigned at its stub above).
const {
	importPaths,
	removeLibraryRow,
	isImportInFlight,
	setImportInFlight,
	libraryHasRow,
	hashFile,
} = require("./main/ipc/import.js");
// Own bindings (above) backfill the shared slots sibling modules and the
// e2e isolation ctx read at call time. (Older assignments for these five in
// the chrome/watched/enrich/ocr stubs are deleted with this move.)
mainContext.importPaths = importPaths;
mainContext.isImportInFlight = isImportInFlight;
mainContext.libraryHasRow = libraryHasRow;
mainContext.hashFile = hashFile;
// C-01 Wave 2 (S2/S3): import-failure cache live in main-lib/failed-imports.ts and main-lib/category-overrides.ts (imported above).

// C-01 Wave 2 (S2/S3): category-overrides store live in main-lib/failed-imports.ts and main-lib/category-overrides.ts (imported above).

// ---------------------------------------------------------------------------
// Category override + reveal/open: MOVED to main/ipc/reveal.ts (Phase 1,
// pure move - 2026-10-10). No behavior change: same guards. Shared refs via
// main/context.js (existing slots). resolveRevealTarget re-exported below
// for the reveal smoke ctx.
// ---------------------------------------------------------------------------
const { resolveRevealTarget } = require("./main/ipc/reveal.js");

// ---------------------------------------------------------------------------
// Watched folders: MOVED to main/ipc/watched.ts (Phase 1, pure move -
// 2026-10-10). No behavior change except `watchedFolders` keeps a stable
// identity (mutated in place; see module note) so the readers below and the
// watched smoke driver hold it by reference. Shared refs the domain still
// needs arrive via main/context.js (assigned here; read at call time).
// Lifecycle (boot/will-quit) + import + e2e refs re-exported below.
// ---------------------------------------------------------------------------
// (dataDir assigned at top beside its const — see note there.)
// Phase 1 (import): isImportInFlight now arrives from the import module
// (assigned at its stub above).
// Phase 1 (migration): getMigrationState now arrives from the migration
// module (assigned at its stub below).
const {
	WATCHED_FOLDERS_FILE,
	watchedFolders,
	folderWatchers,
	watchFailedFolders,
	addWatchedFolder,
	syncWatchedFolder,
	syncWatchedFolders,
	startWatchedFolderWatchers,
	stopWatchedFolderWatchers,
	watchedFolderList,
	watchedFolderRevealTarget,
	removeWatchedFolder,
} = require("./main/ipc/watched.js");

// Extract a representative frame from an imported video into POSTERS_DIR,
// named after the video's basename (posterFor()). The tile renders this
// instead of the raw video, so nothing else needs to change.
// ---------------------------------------------------------------------------
// Scene-segment enrichment: MOVED to main/ipc/pumps/enrich.ts (Phase 1, pure
// move - 2026-10-10). backgroundPaused + purgeEpoch stay HERE (owned by all
// three pumps + purge/reset; ownership transfers when the pumps land).
// Shared refs the domain still needs arrive via main/context.js (assigned
// here; read at call time). Stayer-needed refs re-exported below.
// ---------------------------------------------------------------------------
// User-controlled pause for ALL background pumps (scene analysis,
// transcription, text extraction), toggled from the tray pills via
// memories:set-background-paused. Session-only: a relaunch resumes work,
// so nobody can strand their library paused forever. While set, the three
// *Allowed() gates refuse new jobs; the in-flight chunk (if any) finishes
// on its own, then everything idles until resumed.
let backgroundPaused = false;
// Purge generation: bumped by memories:purge-background. Jobs capture it
// at pump start and refuse to commit when it moved — a chunk in flight
// across a purge discards its reply instead of landing partial sidecars
// that the launch backfills would then skip forever as "covered".
let purgeEpoch = 0;
mainContext.bumpPurgeEpoch = () => {
	purgeEpoch++;
};
const {
	enrichQueue,
	enrichPhaseCounts,
	// (isJobDead lives in the enrich module; the transcribe + ocr modules
	// require it directly — main.js never calls it.)
	// Phase 1: noteEnrichProgress moved with pool (pool message handler).
	isEnrichInFlight,
	isEnrichPendingQuery,
	getEnrichQueue,
	setEnrichPendingQuery,
	enrichSnapshot,
	broadcastEnrichEvent,
	scheduleEnrichment,
	backfillEnrichment,
	getEnrichEventsObserved,
	getEnrichProgressViolations,
} = require("./main/ipc/pumps/enrich.js");
// Own bindings (above) backfill the shared slots the rank module and the
// staying transcribe/ocr gates read at call time. (The rank stub's older
// assignments for these four are deleted with this move.)
mainContext.getEnrichQueue = getEnrichQueue;
mainContext.isEnrichInFlight = isEnrichInFlight;
mainContext.isEnrichPendingQuery = isEnrichPendingQuery;
mainContext.setEnrichPendingQuery = setEnrichPendingQuery;
mainContext.broadcastEnrichEvent = broadcastEnrichEvent;
mainContext.isBackgroundPaused = () => backgroundPaused;
mainContext.getPurgeEpoch = () => purgeEpoch;
// Phase 1 (pumps/transcribe): isTranscribePendingQuery now arrives from
// the transcribe module (assigned at its stub below).
// Phase 1 (chrome): updateTrayState + maybeNotify now arrive from the
// chrome module (assigned at its stub above).
// Phase 1 (pool): askPrimaryIndexer + restartPrimaryIndexer now arrive
// from the pool module (assigned at its stub above).
// Phase 1 (import): libraryHasRow now arrives from the import module
// (assigned at its stub above).
mainContext.postersDir = POSTERS_DIR;

// Phase 1: generatePoster + preview helpers moved with previews
// (main/ipc/previews.ts); import + protocol read them via shared slots.

// ---------------------------------------------------------------------------
// Speech transcription: MOVED to main/ipc/pumps/transcribe.ts (Phase 1, pure
// move - 2026-10-10). No behavior change: same worker, gates, retries,
// utterance accumulation. Shared refs the domain still needs arrive via
// main/context.js (assigned here; read at call time). Stayer-needed refs
// re-exported below (import/migration/tray/purge/drop/whisper-switch/
// will-quit). Tombstones stay shared via the enrich module's isJobDead.
// ---------------------------------------------------------------------------
// Phase 1 (pumps/ocr): isOcrPendingQuery now arrives from the ocr module
// (assigned at its stub below).
// Phase 1 (pool): ffmpeg tracking now arrives from the pool module
// (assigned at its stub above).
const {
	isTranscribePendingQuery,
	setTranscribePendingQuery,
	isTranscribeInFlight,
	getTranscribeWorker,
	transcribeSnapshot,
	broadcastTranscribeEvent,
	scheduleTranscription,
	backfillTranscription,
} = require("./main/ipc/pumps/transcribe.js");
// Own bindings (above) backfill the shared slots the enrich module and the
// rank module read at call time. (Their older assignments for these two are
// deleted with this move.)
mainContext.isTranscribePendingQuery = isTranscribePendingQuery;
mainContext.setTranscribePendingQuery = setTranscribePendingQuery;
mainContext.isTranscribeInFlight = isTranscribeInFlight;

// ---------------------------------------------------------------------------
// OCR text extraction: MOVED to main/ipc/pumps/ocr.ts (Phase 1, pure move -
// 2026-10-10). No behavior change: same worker, gates, checkpoints,
// migration, summaries. Shared refs the domain still needs arrive via
// main/context.js (assigned here; read at call time). Stayer-needed refs
// re-exported below (import/tray/purge/drop/lang-switch/reanalyze/
// will-quit).
// ---------------------------------------------------------------------------
const {
	ocrQueue,
	isOcrInFlight,
	isOcrPendingQuery,
	setOcrPendingQuery,
	getOcrWorker,
	ocrSnapshot,
	broadcastOcrEvent,
	scheduleOcr,
	// Phase 1: enqueueOcr moved with import (its only caller).
	backfillOcr,
	backfillScreenshotHints,
	backfillHashes,
} = require("./main/ipc/pumps/ocr.js");
// Phase 1 (import): hashFile now arrives from the import module (assigned
// at its stub above).
// Own bindings (above) backfill the shared slot the rank module reads at
// call time. (Its older assignment is deleted with this move.)
mainContext.isOcrPendingQuery = isOcrPendingQuery;
mainContext.setOcrPendingQuery = setOcrPendingQuery;

// ---------------------------------------------------------------------------
// Thumbnails + protocol + menu + window: MOVED to main/ipc/protocol.ts
// (Phase 1, pure move - 2026-10-10). No behavior change: same routes,
// ranges, menus, preferences. Shared refs the domain still needs arrive
// via main/context.js (assigned here; read at call time). Stayer-needed
// refs re-exported below (boot, activate, smoke ctx).
// ---------------------------------------------------------------------------
mainContext.rendererDir = RENDERER_DIR;
mainContext.thumbsDir = THUMBS_DIR;
mainContext.imageExtensions = IMAGE_EXTENSIONS;
// Phase 1 (previews): ensurePreview now arrives from the previews module.
mainContext.imageContentType = imageContentType;
mainContext.isQuitting = () => isQuitting;
const {
	handleAppRequest,
	buildApplicationMenu,
	createWindow,
	setPruneAbortedStatus,
	WEB_PREFERENCES,
} = require("./main/ipc/protocol.js");

// ---------------------------------------------------------------------------
// Search + moment ranking: MOVED to main/ipc/rank-moments.ts (Phase 1, pure
// move - 2026-10-10). No behavior change: same worker, handlers, gates.
// Shared refs the domain still needs arrive via main/context.js (assigned
// here; read at call time). will-quit's stopRankWorker re-exported below.
// ---------------------------------------------------------------------------
// Phase 1 (pool): pool slots now arrive from the pool module (assigned
// at its stub above); the closures this stub held over main.js lets are
// deleted with this move.
// Phase 1 (pumps/enrich): getEnrichQueue / isEnrichInFlight /
// setEnrichPendingQuery / broadcastEnrichEvent now arrive from the enrich
// module (assigned at its stub above) — the old closures over main.js lets
// are deleted with this move.
// (enrich-owned; see enrich stub)
// Phase 1 (pumps/ocr): setOcrPendingQuery now arrives from the ocr module
// (assigned at its stub below).
// Phase 1 (pumps/transcribe): setTranscribePendingQuery now arrives from
// the transcribe module (assigned at its stub below).
const { stopRankWorker, rankSearch } = require("./main/ipc/rank-moments.js");

// Phase 1: get/reveal/remove-watched-folder handlers live in
// main/ipc/watched.ts (registered above).

// N-06: renderer-visible app version (Settings footer). app.getVersion()
// reads package.json, the single version source — no mirror to drift.
ipcMain.handle("memories:get-version", () => app.getVersion());

// Crash forensics: renderer breadcrumbs (lightbox open/switch/close — see
// MasonryGrid) land in the log through logBreadcrumb's synchronous append,
// so a native crash cannot lose the trail to stream buffering. Fire-and-
// forget; the payload mirrors the bridge's `{ text }` shape (ask-stop
// unwraps its `{ reqId }` the same way), non-strings are dropped.
ipcMain.on("memories:breadcrumb", (_event: unknown, rawPayload: unknown) => {
	const payload = rawPayload as { text?: unknown } | null;
	logBreadcrumb(typeof payload?.text === "string" ? payload.text : "");
});

// Phase 1: reveal-file / open-external handlers + resolveRevealTarget live
// in main/ipc/reveal.ts (registered at the import stub above).

// Current AI-engine status, so the renderer can ask on mount instead of
// hoping it didn't miss the broadcast window.
// Phase 1 (pool): modelStatus lives in the pool module.

// ---------------------------------------------------------------------------
// Window + tray + menu-bar mode + app icon: MOVED to main/ipc/chrome.ts
// (Phase 1, pure move - 2026-10-10). No behavior change: same menus, icons,
// mode switches. mainWindowRef + isQuitting + Dock/icon lets stay HERE
// (quit flow + top icon init own them); the domain reads/writes them via
// main/context.js (assigned here; read at call time). Stayer-needed refs
// re-exported below (second-instance, activate, boot).
// ---------------------------------------------------------------------------
mainContext.getMainWindowRef = () => mainWindowRef;
mainContext.setMainWindowRef = (v) => {
	mainWindowRef = v;
};
mainContext.setIsQuitting = (v) => {
	isQuitting = v;
};
mainContext.isMenuBarOnlyEnabled = () => menuBarOnlyEnabled;
mainContext.setMenuBarOnlyEnabled = (v) => {
	menuBarOnlyEnabled = v;
};
mainContext.getAppIconImage = () => APP_ICON;
mainContext.setAppIconImage = (v) => {
	APP_ICON = v;
};
mainContext.getCurrentAppIconId = () => currentAppIconId;
mainContext.setCurrentAppIconId = (v) => {
	currentAppIconId = v;
};
mainContext.getPendingDockIcon = () => pendingDockIcon;
mainContext.setPendingDockIcon = (v) => {
	pendingDockIcon = v;
};
mainContext.getPendingDockIconId = () => pendingDockIconId;
mainContext.setPendingDockIconId = (v) => {
	pendingDockIconId = v;
};
mainContext.loadAppIconImage = loadAppIconImage;
mainContext.settingsFile = SETTINGS_FILE;
// (appDirname assigned at top beside DATA_DIR — protocol.ts reads it at
// module load.)
const { showAndFocusMain, applyMenuBarMode } = require("./main/ipc/chrome.js");
// Shortcut state + handlers (moved earlier; re-anchored here after the
// chrome move swallowed its stub — same registration, same helpers).
const {
	tryRegisterShortcut,
	unregisterCurrentShortcut,
} = require("./main/ipc/chrome-settings.js");
let mainWindowRef: Electron.BrowserWindow | null = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Video/Whisper/OCR settings: MOVED to main/ipc/media.ts (Phase 1, pure
// move - 2026-10-10). No behavior change: same validation, invalidation,
// re-queues. Shared refs the domain still needs arrive via main/context.js
// (assigned here; read at call time). No re-exports: boot reads settings
// directly, and the whisper-switch alias migration stays in main.js.
// ---------------------------------------------------------------------------
const {
	suspectedTruncatedVideos,
	migrateRemovedWhisperModel,
} = require("./main/ipc/media.js");

// ---------------------------------------------------------------------------
// Named embedding versions (Settings → Library): snapshots of the
// searchable state across every model, restorable with auto-backup.
// ---------------------------------------------------------------------------

// A version must capture a QUIESCED library: an import or migration
// rewrites the index shape mid-copy, and an active pump mutates the very
// sidecars being snapshotted. Name the blocker so the UI can say it.
// ---------------------------------------------------------------------------
// Embedding versions + purge/reset: MOVED to main/ipc/versions.ts (Phase 1,
// pure move - 2026-10-10). No behavior change: same guards, snapshots,
// broadcasts. Shared refs the domain still needs arrive via main/context.js
// (assigned here; read at call time). drainPersistQueue re-exported below
// for quitSmoke / will-quit.
// ---------------------------------------------------------------------------
const { drainPersistQueue } = require("./main/ipc/versions.js");

ipcMain.handle(
	"memories:set-background-paused",
	(_event: unknown, paused: unknown) => {
		backgroundPaused = paused === true;
		// Push fresh snapshots so every open window's tray flips immediately.
		broadcastEnrichEvent(enrichSnapshot());
		broadcastTranscribeEvent(transcribeSnapshot());
		broadcastOcrEvent(ocrSnapshot());
		// Resuming kicks the pumps without waiting out their gap timers; the
		// gates re-check everything, so a kick under import/migration/query
		// pressure is a harmless no-op that reschedules itself.
		if (!backgroundPaused) {
			scheduleEnrichment();
			scheduleTranscription();
			scheduleOcr();
		}
		return { ok: true, paused: backgroundPaused };
	},
);

// ---------------------------------------------------------------------------
// AI Insights + LLMs/Ask: MOVED to main/ipc/llm-ask.ts (Phase 1, pure move -
// 2026-10-10). No behavior change: same handlers, channels, gates, retry.
// The one shared helper still owned by main.js (isVideo, defined above)
// arrives via main/context.js (assigned here; read at call time).
// ---------------------------------------------------------------------------
mainContext.isVideo = isVideo;
require("./main/ipc/llm-ask.js");

// ---------------------------------------------------------------------------
// YouTube video agent: MOVED to main/ipc/youtube.ts (Phase 1, pure move -
// 2026-10-10). No behavior change: same queue, timers, handlers, channels.
// Shared refs the domain still needs arrive via main/context.js (assigned
// here; read at call time by the domain). Lifecycle + smoke-test refs are
// re-exported below so boot (9317/9325) and ELECTRON_SMOKE_YOUTUBE keep
// working unchanged.
// ---------------------------------------------------------------------------
// Phase 1 (import): importPaths now arrives from the import module
// (assigned at its stub above).
mainContext.photosDir = PHOTOS_DIR;
const {
	backfillYoutubeMeta,
	repairSilentYoutubeImports,
	mergeYoutubeIntermediates,
	resolveYtDlpFfmpegLocation,
	runYoutubeJob,
} = require("./main/ipc/youtube.js");

// C-01: runE2E lives in scripts/e2e/e2e.js (required at dispatch).
// cosine stays here: shared by runE2E (via ctx) and the migrate dispatch.

// C-01 Wave 2 (S4): cosine live in main-lib/library-store.js (required at top).

// C-01: runSearchMatrixProbe lives in scripts/e2e/search-matrix.js (required at dispatch).

// C-01: runOcrHighlightProbe lives in scripts/e2e/ocr-highlight.js (required at dispatch).

// C-01: runRevealTest lives in scripts/e2e/reveal.js (required at dispatch).

// C-01: runReimportTest lives in scripts/e2e/reimport.js (required at dispatch).

// C-01: runWatchedFoldersTest lives in scripts/e2e/watched.js (required at dispatch).

// C-01: runFailureCacheTest lives in scripts/e2e/failcache.js (required at dispatch).

// C-01: runRenameDedupeTest lives in scripts/e2e/renamededupe.js (required at dispatch).

// C-01: runMigrateTest lives in scripts/e2e/migrate.js (required at dispatch).

// C-01: runPhase4DeepTest lives in scripts/e2e/phase4.js (required at dispatch).

// Smoke dispatch helper (ts-migration Stage A): compiled main.js runs from
// dist-main/, so ./scripts/e2e/* and ./test/* no longer sit beside it — and
// packaging ships neither. These branches are env-gated dev smokes only;
// resolve helpers against the app root (repo root in dev, asar root
// packaged — where the require simply fails if a smoke env leaks into a
// packaged launch, exactly as it would have before dist-main existed).
function requireDev(rel: string) {
	return require(path.join(APP_ROOT, rel));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on("web-contents-created", (_event, contents) => {
	contents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://") || url.startsWith("https://")) {
			shell.openExternal(url);
		}
		return { action: "deny" };
	});
	contents.on("will-navigate", (event, url) => {
		// Dropping a file on the window must never navigate the app away.
		if (!url.startsWith(`${SCHEME}://`)) event.preventDefault();
	});
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		// Surface even a menu-bar-hidden window (a second launch means the
		// user is looking for the app).
		showAndFocusMain();
	});

	// Smoke-mode teardown: app.quit() does not propagate process.exitCode
	// (a failed suite still exited 0, so the battery reported ALL PASSED
	// with a failure inside). Capture the code and exit explicitly —
	// passing suites are unaffected (code 0 either way). Drain the persist
	// queue first: saves are async (serial queue + fsync) and a blind
	// 1500ms exit stranded the warm run's last saves on loaded runners,
	// failing the cold-restart suite on stale bins. The cap keeps a stuck
	// fsync from hanging CI forever.
	function quitSmoke(forceCode?: number) {
		// Cast: the node types widen exitCode to string | number | undefined;
		// this app only ever assigns numbers (the runtime value is numeric).
		// forceCode lets a smoke branch pin the outcome — its own success
		// criterion is authoritative over late drain noise (a killed worker's
		// rejection during the quit drain must not flip a passed suite).
		const code = forceCode ?? (process.exitCode as number | undefined) ?? 0;
		void (async () => {
			try {
				await drainPersistQueue(60000);
			} catch {
				/* exit with the suite's code regardless */
			}
			// app.exit() skips the will-quit event, so the quit sweep never
			// runs here: kill the main-process children (the sidecar,
			// yt-dlp) explicitly or they outlive the smoke as orphans.
			killTrackedChildren("quit-smoke");
			app.exit(code);
		})();
	}
	app.whenReady().then(async () => {
		installGlobalErrorLogging();
		loadLibrary();
		// Remove library rows whose photo files no longer exist on disk
		// (manual deletion, crash mid-dedupe, unwatched folder). Runs
		// before backfills so ghost entries don't waste OCR/enrichment work.
		setPruneAbortedStatus(await pruneStaleLibraryEntries());
		// Existing libraries predate sourceMtimes. Populate this display-only
		// metadata before the renderer's first index request, so All/File is
		// correct immediately rather than only after a newly imported batch.
		await backfillSourceMtimes();
		// YouTube downloads that landed before the youtube.json metadata fix
		// (unmerged .fXXX intermediates missed their .info.json sibling):
		// re-link staging info.jsons to library rows so the YouTube tab and
		// its dialogue search see already-indexed videos immediately.
		try {
			backfillYoutubeMeta();
		} catch {
			/* best-effort */
		}
		// Silent YouTube imports (video-only files that never merged): heal
		// them from staging audio before the transcription backfill runs, so
		// repaired files re-transcribe in the same boot.
		try {
			await repairSilentYoutubeImports();
		} catch {
			/* best-effort */
		}
		protocol.handle(SCHEME, handleAppRequest);
		buildApplicationMenu();
		// Apply the persisted app icon BEFORE entering menu-bar-only. The Dock
		// icon must be staged while the Dock is still visible — macOS drops
		// setIcon calls made while hidden, so hiding first then setting would
		// be lost and the next show() would revert to the bundled SCM.icns.
		// Setting before hide (and the pendingDockIcon path for changes made
		// while hidden) guarantees the choice survives both hidden periods and
		// restarts.
		try {
			const chosen = readAppIcon();
			const img = loadAppIconImage(chosen);
			if (img) {
				APP_ICON = img;
				currentAppIconId = chosen;
			}
			// Don't call app.dock.setIcon here if we're about to hide — the
			// staged set happens inside applyMenuBarMode(true) (which sets
			// before hide). For the normal visible case, apply now so the
			// first window sees the right Dock icon immediately.
			if (
				img &&
				process.platform === "darwin" &&
				app.dock &&
				!readMenuBarOnly()
			) {
				app.dock.setIcon(img);
			}
		} catch {
			/* icon apply is best-effort */
		}
		const menuBarOn = applyMenuBarMode(readMenuBarOnly());
		try {
			reapStaleFfmpegOrphans();
		} catch {
			/* reaper is best-effort */
		}
		spawnIndexer();
		// Watch folders the user imported in past sessions: their live
		// watchers + safety-net poll start here, and the first sync runs
		// below once the indexer is ready.
		startWatchedFolderWatchers();

		const win = createWindow({
			// "Start hidden" (menu-bar-only mode): boot straight to the tray
			// with no window. Ignored in normal mode — without a tray the
			// app would launch with no visible presence at all.
			showOnReady: !(menuBarOn && readStartHidden()),
		});
		mainWindowRef = win;
		console.log("[app] loading renderer…");
		await win.loadURL(`${SCHEME}://localhost/`);
		console.log("[app] renderer loaded");

		// MobileCLIP2-S2 (and any pre-registry model id) is retired. The
		// loader holds its persisted vectors aside rather than resolving them
		// into CLIP's 768-d space. Start the checkpointed re-embed as soon as
		// the replacement worker is warm; it broadcasts ordinary migration
		// progress, blocks imports, and leaves the old on-disk index intact if
		// anything fails. Schedule this before every other post-init task so
		// none can persist replacement metadata over the old vector space.
		void (async () => {
			try {
				await getIndexerReady();
				await migratePendingModel();
			} catch (err) {
				console.warn(
					`[memories] retired-model migration deferred: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// Register the user's global shortcut (if any) to bring SCM to focus.
		const savedShortcut = readSettings().globalShortcut;
		if (savedShortcut) {
			const result = tryRegisterShortcut(savedShortcut);
			if (!result.ok) {
				console.warn(
					`[shortcut] failed to restore saved shortcut "${savedShortcut}": ${result.error}`,
				);
				for (const w of BrowserWindow.getAllWindows()) {
					w.webContents.send("memories:status", {
						type: "shortcut-error",
						error: result.error,
					});
				}
			}
		}

		// Heal corrupted phrase rows (a text-model outage at import time
		// persisted zero rows; an older/misaligned bin may also be present).
		// Fire-and-forget after the indexer is ready; when rows are fixed,
		// broadcast library-updated so the renderer reloads the corrected
		// phrase bin. Also calibrate a model whose thresholds are still null
		// (first use of a new model from a past session): its score band is
		// unknown until measured against the real library.
		void (async () => {
			try {
				await getIndexerReady();
				const { healed, attempted } = await healPhraseBin();
				if (attempted > 0) {
					// Surface the automatic repair (or its failure) so users aren't
					// left wondering why search quality changed.
					for (const w of BrowserWindow.getAllWindows()) {
						w.webContents.send("memories:status", {
							type: "heal",
							healed,
							attempted,
						});
					}
				}
				if (healed > 0) {
					for (const w of BrowserWindow.getAllWindows()) {
						w.webContents.send("memories:status", { type: "library-updated" });
					}
				}
				const active = loadLibrary().modelId;
				if (!thresholdsFor(active)) {
					await calibrateThresholds(active);
				}
			} catch (err) {
				console.warn(
					`[memories] post-init maintenance skipped: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// Watched folders: import anything new that appeared in a watched
		// folder since the last launch. Runs after the indexer warms so new
		// files embed immediately; a folder full of new photos imports in
		// the background while the app is usable.
		if (watchedFolders.length > 0) {
			void (async () => {
				try {
					await getIndexerReady();
					await syncWatchedFolders();
				} catch (err) {
					console.warn(
						`[memories] watched-folder sync skipped: ${(err as { message?: string }).message}`,
					);
				}
			})();
		}

		// Phase 4 backfill: analyze videos that predate scene enrichment
		// (or whose sidecar never landed) in the background after the
		// indexer warms — one at a time, gated by the same idle rules as
		// import-time enrichment, so a big library catches up without ever
		// touching search or import latency.
		void (async () => {
			try {
				await getIndexerReady();
				// Interrupted delta fill FIRST: a previous run may have quit
				// mid-tail, leaving zero rows under the active model. Resume
				// them before the scene backfills queue work against them.
				try {
					await maybeResumeDeltaFill();
				} catch (err) {
					console.warn(
						`[memories] delta fill resume skipped: ${(err as { message?: string }).message}`,
					);
				}
				backfillEnrichment();
				// Removed-rung migration FIRST (before the stub-era repair):
				// settings/sidecars still naming small.en move to base.en and
				// the orphaned ~1GB weights are swept, so the backfill below
				// re-queues under a surviving engine.
				try {
					migrateRemovedWhisperModel();
				} catch (err) {
					console.warn(
						`[memories] whisper migration skipped: ${(err as { message?: string }).message}`,
					);
				}
				// Stub-era repair FIRST: drops poisoned empty transcript
				// entries (recorded before whisper existed) for videos WITH
				// audio, so the backfill below actually re-queues them.
				try {
					await repairUntranscribedWithAudio();
				} catch (err) {
					console.warn(
						`[memories] transcript repair skipped: ${(err as { message?: string }).message}`,
					);
				}
				backfillTranscription();
			} catch (err) {
				console.warn(
					`[memories] enrichment backfill skipped: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// OCR backfill: photos that predate OCR (or whose pass failed) get
		// their text extracted in the background, same idle rules. Runs
		// independently of the CLIP pool — tesseract doesn't need the model
		// and must not wait for it, so the OCR queue can start draining even
		// while the indexer still warms.
		void (async () => {
			try {
				backfillOcr();
			} catch (err) {
				console.warn(
					`[memories] OCR backfill skipped: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// Hash backfill: one-time background pass so pre-upgrade libraries
		// get content hashes (rename-duplicate detection).
		void (async () => {
			try {
				await backfillHashes();
			} catch (err) {
				console.warn(
					`[memories] hash backfill skipped: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// Screenshot-hint backfill: probe pre-upgrade rows for screenshot
		// metadata so the Screenshots tab classifies renamed screenshots
		// correctly without waiting for a re-import.
		void (async () => {
			try {
				await backfillScreenshotHints();
			} catch (err) {
				console.warn(
					`[memories] screenshot-hint backfill skipped: ${(err as { message?: string }).message}`,
				);
			}
		})();

		// Real-library search test (keeps existing library): loads the index
		// exactly as the renderer does, embeds real queries through the IPC
		// path, and prints cosine scores for every photo.
		if (process.env.ELECTRON_SEARCH_TEST === "1") {
			try {
				const queries = [
					"rack",
					"desk",
					"screenshot",
					"interior",
					"blue square",
				];
				const out = await win.webContents.executeJavaScript(`
					(async () => {
						const res = [];
						const idx = await fetch('/memories-index.json').then(r => r.json());
						const emb = new Uint8Array(await fetch('/memory-embeddings.bin').then(r => r.arrayBuffer()));
						const dim = idx.dim;
						const photos = idx.images;
						res.push('library: ' + photos.length + ' photos, dim=' + dim + ', textMean=' + (idx.textMean ? idx.textMean.length : 'none'));
						const vecs = photos.map((_, i) => new Float32Array(emb.buffer, 8 + i * dim * 4, dim));
						for (const q of ${JSON.stringify(queries)}) {
							const qv = await window.memories.embedQuery(q);
							if (!qv) { res.push(q + ': embedQuery returned null'); continue; }
							const scores = photos.map((p, i) => {
								let dot = 0;
								for (let k = 0; k < dim; k++) dot += qv[k] * vecs[i][k];
								return [p, dot];
							}).sort((a, b) => b[1] - a[1]);
							res.push(q + ': ' + scores.map(([p, s]) => p + '=' + s.toFixed(3)).join(' '));
						}
						return res.join('\\n');
					})()
				`);
				console.log("[search-test]\n" + out);
			} catch (err) {
				console.error("[search-test] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			// A mode that ran must not fall through into the generic
			// ELECTRON_SMOKE probe below: quitSmoke exits the app, and the
			// probe would race app.exit against a dying window
			// ("Object has been destroyed"). Each mode owns its quit.
			return;
		}

		// Headless smoke dispatch (main/smoke.ts): every ELECTRON_SMOKE_* mode
		// verifies one subsystem and quits. true means a mode ran and already
		// quit, so stop here — the inline returns used to do exactly this.
		const smokeRan = await runSmokeModes({
			win,
			requireDev,
			quitSmoke,
			importPaths,
			loadLibrary,
			resetLibraryCaches,
			resolveRevealTarget,
			PHOTOS_DIR,
			POSTERS_DIR,
			DATA_DIR,
			INDEX_FILE,
			WEB_PREFERENCES,
			DEFAULT_MODEL_ID,
			VIDEO_EXTENSIONS,
			youtube,
			mergeYoutubeIntermediates,
			backfillYoutubeMeta,
			repairSilentYoutubeImports,
			resolveYtDlpFfmpegLocation,
			runYoutubeJob,
			watchedFolders,
			folderWatchers,
			watchFailedFolders,
			watchedFolderList,
			addWatchedFolder,
			removeWatchedFolder,
			watchedFolderRevealTarget,
			syncWatchedFolder,
			stopWatchedFolderWatchers,
			WATCHED_FOLDERS_FILE,
			isImportInFlight,
			setImportInFlight,
			failedImportsFile,
			askIndexer,
			binInfo,
			loadSegments,
			thresholdsFor,
			calibrateThresholds,
			getModel,
			cosine,
			reembedToModel,
			migrationSettled,
			modelDownloaded,
			embedFileFor,
			preloadAllModels,
			readVideoQuality,
			writeSettings,
			removeLibraryRow,
			saveLibrary,
			backfillEnrichment,
			suspectedTruncatedVideos,
			segmentsBinFileFor,
			segmentsMetaFileFor,
			enrichPhaseCounts,
			getEnrichQueue,
			getEnrichEventsObserved,
			getEnrichProgressViolations,
			isEnrichInFlight,
			isTranscribeInFlight,
			healPhraseBin,
			phraseFileFor,
			ocrQueue,
			isOcrInFlight,
			enrichQueue,
			pruneStaleLibraryEntries,
			readBin,
			saveSegments,
			libraryIndex,
			rankSearch,
		});
		if (smokeRan) return;

		app.on("activate", () => {
			const wins = BrowserWindow.getAllWindows();
			if (wins.length === 0) {
				// Local ref: tsc does not narrow the module let across the
				// assignment statement.
				const created = createWindow();
				mainWindowRef = created;
				void created.loadURL(`${SCHEME}://localhost/`);
			} else {
				// A menu-bar-hidden window still exists — reshow it (the
				// old zero-windows-only check would do nothing here).
				showAndFocusMain();
			}
		});
	});

	// A real quit is underway (Cmd+Q, app-menu Quit, tray Quit item): stand
	// down the close-to-tray handler so the window is allowed to close.
	app.on("before-quit", () => {
		isQuitting = true;
	});

	// Child-process forensics: when a utilityProcess (indexer, OCR,
	// transcribe, rank) dies unexpectedly, `reason` names it — oom vs
	// crashed vs killed vs clean-exit — which the worker's own exit event
	// cannot tell us (a SIGKILL leaves no stderr). This is the discriminator
	// for CI worker deaths; normal quits also log here with clean-exit.
	app.on("child-process-gone", (_event, details) => {
		try {
			console.log(
				`[child-process-gone] ${JSON.stringify({ type: details.type, serviceName: details.serviceName, reason: details.reason, exitCode: details.exitCode })}`,
			);
		} catch {
			console.log("[child-process-gone] (unserializable details)");
		}
	});

	// Renderer complement: a renderer crash (crashed/oom/killed) blanks the
	// window but otherwise leaves no trace in the log; reason + exit code
	// name it (child-process-gone above covers the utility workers).
	app.on("render-process-gone", (_event, _webContents, details) => {
		try {
			console.log(
				`[render-process-gone] ${JSON.stringify({ reason: details.reason, exitCode: details.exitCode })}`,
			);
		} catch {
			console.log("[render-process-gone] (unserializable details)");
		}
	});

	// will-quit drains the async persist queue before the process exits:
	// an orderly quit must not strand queued saves (the warm→cold smoke
	// caught exactly this: unflushed bins on relaunch). First entry stops
	// every save source synchronously (workers, watchers), drains with a
	// cap so a stuck fsync can never hang quit, then quits for real; the
	// second entry runs nothing (cleanup already ran). Tray-hides never
	// reach here (no isQuitting, no will-quit), so hiding stays instant.
	let quitDraining = false;
	let quitDrained = false;
	app.on("will-quit", (e) => {
		if (!quitDrained) {
			e.preventDefault();
			if (quitDraining) return; // re-entry while draining: wait for it
			quitDraining = true;
			runWillQuitCleanup();
			void (async () => {
				try {
					await drainPersistQueue(10000);
				} catch {
					/* quit with what's flushed */
				}
				// Final sweep: the first sweep ran BEFORE the drain, so
				// anything spawned during it (e.g. a late Ask starting the
				// sidecar) is killed here instead of outliving the app.
				killTrackedChildren("will-quit-final");
				quitDrained = true;
				app.quit();
			})();
			return;
		}
	});

	function runWillQuitCleanup() {
		unregisterCurrentShortcut();
		// Stop the watched-folder watchers + poll.
		stopWatchedFolderWatchers();
		// Kill the LLMs sidecar (llama-server) with everything else.
		stopLlmServer("quit");
		// Main-process children (yt-dlp, the ffmpeg merge, a llama-server
		// still starting) are invisible to the worker sweeps below — they
		// are tracked in their own registry, so a quit mid-job cannot leave
		// a process behind (the 2026-09-28 orphan lesson).
		killTrackedChildren("will-quit");
		// Rank utilityProcess (Phase 0.4) — graceful shutdown first, then kill.
		stopRankWorker();
		// Kill any in-flight model preloads (throwaway download workers).
		for (const entry of modelPreloads.values()) {
			if (entry.process) {
				try {
					entry.process.kill();
				} catch {
					/* already gone */
				}
			}
		}
		modelPreloads.clear();
		// Orphan fix: SIGKILL ffmpeg grandchildren BEFORE their Node workers.
		// Killing a utilityProcess alone reparents ffmpeg to PID 1 (it keeps
		// burning CPU after quit with no timers left). Each worker is asked
		// to sweep its own children first; tracked PIDs cover dead workers.
		for (const worker of indexerWorkers) {
			requestWorkerKillFfmpeg(worker, indexerFfmpegPids, "will-quit");
		}
		if (getTranscribeWorker()) {
			requestWorkerKillFfmpeg(
				getTranscribeWorker(),
				transcribeFfmpegPids,
				"will-quit",
			);
		} else {
			killTrackedFfmpegPids(transcribeFfmpegPids, "will-quit-no-worker");
		}
		killTrackedFfmpegPids(indexerFfmpegPids, "will-quit-sweep");
		// Preview transcodes run in the MAIN process (tracked in this
		// process's own ffmpeg-process registry, not a worker's) — sweep them
		// here too so a quit mid-transcode cannot orphan ffmpeg either.
		try {
			require("./indexer/ffmpeg-process.js").killAllFfmpeg("will-quit-main");
		} catch {
			/* best-effort */
		}
		if (getOcrWorker()) {
			try {
				// OCR worker hosts tesseract, not ffmpeg — plain kill is enough.
				if (getOcrWorker().process) getOcrWorker().process.kill();
			} catch {
				/* already gone */
			}
		}
		for (const worker of indexerWorkers) {
			if (worker.process) {
				try {
					worker.process.kill();
				} catch {
					/* already gone */
				}
			}
		}
		try {
			if (getTranscribeWorker() && getTranscribeWorker().process) {
				getTranscribeWorker().process.kill();
			}
		} catch {
			/* already gone */
		}
	}

	app.on("window-all-closed", () => {
		// In menu-bar-only mode there is nothing to quit to: the tray icon
		// keeps the app resident (close hides the window instead, so this
		// only fires if every window was truly destroyed).
		if (menuBarOnlyEnabled) return;
		app.quit();
	});
}
