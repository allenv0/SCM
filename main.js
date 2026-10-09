"use strict";

const {
	app,
	BrowserWindow,
	Menu,
	Tray,
	Notification,
	shell,
	protocol,
	ipcMain,
	dialog,
	utilityProcess,
	nativeImage,
	globalShortcut,
} = require("electron");
const fs = require("fs");
const path = require("path");
// Explicit require: global `crypto` is absent on older Electron/node.
// eslint-disable-next-line no-redeclare
const crypto = require("crypto");
const { Readable } = require("stream");

const {
	MODELS,
	DEFAULT_MODEL_ID,
	getModel,
	resolveModelId,
} = require("./indexer/models.js");
const {
	SAMPLE_QUERIES,
	buildFilenamePhrase,
} = require("./indexer/memory-embedding-utils.js");
const { sortPathsByMtime } = require("./indexer/import-order-utils.js");
const {
	SEGMENT_ROW_PER,
	mergeChunkSegments,
	partitionChunkReply,
	shouldParkEnrichment,
	suspectedTruncated,
	ENRICH_CHUNK_TIMEOUT_MS,
	ENRICH_STALL_TIMEOUT_MS,
	ENRICH_MAX_RETRIES,
} = require("./indexer/segment-store-utils.js");
const {
	TRANSCRIPT_ROW_PER,
	partitionTranscriptReply,
	attachQueryVec,
	applyTranscriptReply,
	exactDialogueSearch,
	transcribeBackfillList,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_MAX_RETRIES,
	TRANSCRIBE_LOAD_MAX_RETRIES,
	transcribeExitLabel,
	transcribeFailureLabel,
	isLoadPhaseCrash,
	parseWhisperModel,
	transcribeTimeoutsFor,
} = require("./indexer/transcript-store-utils.js");
const { probeScreenshotMetadata } = require("./screenshot-probe.js");
const {
	initSettings,
	APP_ICON_IDS,
	DEFAULT_APP_ICON,
	parseAppIcon,
	appIconFileFor,
	readAppIcon,
	readSettings,
	writeSettings,
	readVideoQuality,
	videoBudgetForCurrentQuality,
	readWhisperModel,
	cleanupRemovedWhisperWeights,
	readOcrLangs,
	resolveOcrLangString,
	readOcrLangsMigrated,
	shouldMigrateOcrLangs,
	readMenuBarOnly,
	readNotifyOnDone,
	readStartHidden,
	readOnboardingSeen,
} = require("./main-lib/settings.js");
const {
	initFailedImports,
	failedImportsFile,
	isSystemIndexerError,
	rememberImportFailure,
	isKnownImportFailure,
	retireImportFailure,
	clearFailedImports,
} = require("./main-lib/failed-imports.js");
const {
	initCategoryOverrides,
	CATEGORY_OVERRIDE_VALUES,
	loadCategoryOverrides,
	saveCategoryOverrides,
	clearCategoryOverrides,
} = require("./main-lib/category-overrides.js");
const {
	initLlmConfig,
	readLlmConfig,
	writeLlmConfig,
	llmModelInfos,
} = require("./main-lib/llm/config.js");
const {
	initLlmServer,
	llmServerSnapshot,
	binaryDownloaded: llmBinaryDownloaded,
	modelDownloaded: llmModelDownloaded,
	downloadBinary: llmDownloadServerBinary,
	downloadModel: llmDownloadModelWeights,
	llmChat,
	stopServer: stopLlmServer,
	chatThreadCount: llmChatThreadCount,
} = require("./main-lib/llm/server.js");
const {
	validateScopedFilenames,
	partitionScoped,
	buildAskEvidence,
} = require("./main-lib/ask/retrieve.js");
const { buildAskMessages } = require("./main-lib/ask/prompts.js");
const {
	initLibraryStore,
	resetLibraryCaches,
	libraryGenerationNumber,
	embedFileFor,
	phraseFileFor,
	segmentsMetaFileFor,
	segmentsBinFileFor,
	transcriptsMetaFileFor,
	thumbFor,
	loadSampleQueries,
	loadLibrary,
	readBin,
	libraryIndex,
	libraryNorms,
	enqueuePersist,
	cachedLibraryBins,
	cachedSegmentsBin,
	cachedTranscriptsBin,
	writeBins,
	saveLibrary,
	readEmbedMeta,
	setEmbedIncomplete,
	isZeroVector,
	planDeltaReuse,
	backfillSourceMtimes,
	loadSegments,
	saveSegments,
	removeSegmentsForAllModels,
	loadTranscripts,
	saveTranscripts,
	removeTranscriptsForAllModels,
	repairUntranscribedWithAudio,
	loadModelState,
	resetModelStateCache,
	saveModelState,
	thresholdsFor,
	binInfo,
	cosine,
} = require("./main-lib/library-store.js");
const {
	initEmbeddingVersions,
	listVersions,
	createVersion,
	renameVersion,
	deleteVersion,
	restoreVersion,
} = require("./main-lib/embedding-versions.js");
const {
	initLibraryReset,
	resetLibraryFiles,
} = require("./main-lib/library-reset.js");
const {
	cosineSim,
	RANK_MIN_SCORE,
	RANK_RELATIVE_KEEP,
	scoreLibrary,
} = require("./main-lib/rank-search.js");
const youtube = require("./main-lib/youtube.js");

const SCHEME = "app";

// Test isolation: point the whole app (library, models, single-instance
// lock) at a scratch dir. Must happen before the lock/ready paths resolve
// any app paths.
if (process.env.MEMORIES_DATA_DIR) {
	app.setPath("userData", process.env.MEMORIES_DATA_DIR);
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

function initFileLogging() {
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		const file = path.join(LOG_DIR, `main-${day}.log`);
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
				if (m && m[1] < cutoff) {
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
		for (const level of ["log", "warn", "error"]) {
			const orig = console[level].bind(console);
			console[level] = (...args) => {
				orig(...args);
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

initFileLogging();

const RENDERER_DIR = path.join(__dirname, "dist");
const DATA_DIR = path.join(app.getPath("userData"), "library");
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
// LLMs-mode sidecar (main-lib/llm/server.js): status events ride the same
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

// C-01 Wave 2 (S1): APP_ICON_IDS, DEFAULT_APP_ICON live in main-lib/settings.js (required at top).

// In-memory staging for hidden-Dock case. Must be defined before
// APP_ICON init which runs at module load (TDZ guard).
let menuBarOnlyEnabled = false;
let pendingDockIcon = null;
let pendingDockIconId = null;
let currentAppIconId = DEFAULT_APP_ICON;

// Dev-time drift guard: main.js and src/lib/appIcons.ts must list the same
// ids. The renderer parses the same ids; a drift would make the main reject
// an id the UI offers (or vice versa) and the "didn't change" bug would look
// like a hidden-Dock bug. In dev we read the TS source and warn.
try {
	const tsPath = path.join(__dirname, "src/lib/appIcons.ts");
	if (fs.existsSync(tsPath)) {
		const ts = fs.readFileSync(tsPath, "utf-8");
		const m = ts.match(/APP_ICON_IDS\s*=\s*\[([\s\S]*?)\]/);
		if (m) {
			const ids = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
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

// C-01 Wave 2 (S1): parseAppIcon live in main-lib/settings.js (required at top).

// C-01 Wave 2 (S1): appIconFileFor live in main-lib/settings.js (required at top).

function loadAppIconImage(id) {
	const safeId = parseAppIcon(id);
	const filename = appIconFileFor(safeId);
	const candidates = [
		path.join(__dirname, "dist/images/app-icons", filename),
		path.join(__dirname, "public/images/app-icons", filename),
		// Legacy fallback (single icon before the chooser existed)
		path.join(__dirname, "public/images/icns/SCM.png"),
		path.join(__dirname, "dist/images/icns/SCM.png"),
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

// C-01 Wave 2 (S1): readAppIcon live in main-lib/settings.js (required at top).

function currentAppIconImage() {
	return loadAppIconImage(readAppIcon());
}

// NOTE: an earlier applyAppIcon() helper was fully superseded by the
// memories:set-app-icon IPC handler below (which adds validation, settings
// persistence, and tray feedback) — it was deleted in Phase 0 (N-04) as
// dead code. Icon application lives in the handler now.
let APP_ICON = currentAppIconImage();
try {
	currentAppIconId = readAppIcon();
} catch {
	currentAppIconId = DEFAULT_APP_ICON;
}
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const POSTERS_DIR = path.join(DATA_DIR, "posters");
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
// In-app preview proxies for searchable-only videos (mkv/hevc/...): short
// mp4/h264 clips transcoded on demand around the matched scene timestamp so
// Chromium can play them. Cached on disk, pruned by age/size (see below).
const PREVIEWS_DIR = path.join(DATA_DIR, "previews");
const PREVIEW_SECONDS = 30;
const PREVIEW_LEAD_SECONDS = 5;
const PREVIEW_TIMEOUT_MS = 120000;
const PREVIEW_MAX_BYTES = 500 * 1024 * 1024;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const previewPending = new Map(); // preview filename → Promise<path>
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

// Videos import through ffmpeg frame extraction (see indexer/video-utils.js,
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
function posterFor(filename) {
	return path.join(
		POSTERS_DIR,
		path.basename(filename, path.extname(filename)) + ".jpg",
	);
}

// Photo thumbnail sidecar: a ~480px JPEG in THUMBS_DIR, derived from the
// filename exactly like posters (basename minus extension + ".jpg"). The
// grid renders this instead of the original — see ensureThumb.

// C-01 Wave 2 (S4): thumbFor live in main-lib/library-store.js (required at top).

function isVideo(filename) {
	return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

const MIME_TYPES = {
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
const {
	sniffImageMime,
	canonicalImageExt,
	imageContentType,
} = require("./indexer/mime-sniff.js");

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
async function calibrateThresholds(modelId) {
	const l = loadLibrary();
	// A retired-model library temporarily names its replacement so the worker
	// can warm it, but its stored rows are still from the old vector space.
	// Never calibrate or persist any replacement state until the migration
	// commits its complete new bin pair.
	if (l.pendingModelMigration) return null;
	if (l.filenames.length === 0 || l.embeddings.length !== l.filenames.length) {
		return null;
	}
	const noise = [];
	const genuine = [];
	for (const query of [...NOISE_QUERIES, ...SAMPLE_QUERIES]) {
		const reply = await askIndexer({ type: "embed-query", text: query });
		if (!reply.vec || reply.vec.length !== l.dim) continue;
		let top = 0;
		for (const row of l.embeddings) {
			let dot = 0;
			for (let k = 0; k < l.dim; k++) dot += reply.vec[k] * row[k];
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
async function pruneStaleLibraryEntries() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames) || l.filenames.length === 0) return;
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
	if (missing === 0) return;
	const threshold = Math.max(1, Math.ceil(total / 2));
	if (missing >= threshold) {
		// Refuse to wipe: persist nothing, surface the state, let the user
		// resolve the underlying cause (remount, restore, re-point) and
		// retry on the next launch. This is the guard against the silent
		// library wipe documented in C-05.
		console.warn(
			`[memories] stale-entry cleanup ABORTED: ${missing}/${total} photos missing (≥50%) — refusing to prune to avoid a silent library wipe`,
		);
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "prune-aborted",
				missing,
				total,
			});
		}
		return;
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
	if (migrationState) {
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

	let corrupt;
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
				dot += ph[k] * (im[k] || 0);
				norm += ph[k] * ph[k];
			}
			if (norm < 1e-6 || dot > 0.9999) corrupt.push(l.filenames[i]);
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
				`[memories] phrase heal failed for ${filename}: ${err.message}`,
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

const INDEXER_POOL_SIZE = Math.max(
	1,
	Number(process.env.INDEXER_POOL_SIZE) || 1,
);

let indexerWorkers = []; // { process, primary, ready, dead, pending }
let indexerReady = null; // primary worker's init-done promise
// Set when the primary's init handshake rejects (model load failed) so
// import batches can fail fast without copying files that will never embed.
// Cleared on a fresh spawn (a respawn retries init from scratch).
let indexerInitFailed = null;
let requestId = 0;
let pickRoundRobin = 0;
// Latest AI-model status (loading/ready/error + download %). Cached so a
// window that mounts after events fired still learns the current state.
let modelStatus = null;
// True while the ACTIVE model's weights are absent from the model cache —
// i.e. the user's first launch with this model. Computed once per worker
// spawn and stamped onto every model status so the UI can show a one-time
// download hint without flapping mid-download (partial files appear in the
// cache early).
let modelFirstRun = false;
// The model the pool was forked for. Normally follows the library's active
// model (null); a migration pins it to the TARGET model while the library
// still names the old one, so the respawned pool embeds in the new model
// before the index flips. Cleared when the flip completes.
let workerModelId = null;

// Which model the next worker fork should load: the migration target when
// one is pinned, else the library's active model.
function poolModelId() {
	return workerModelId || resolveModelId(loadLibrary().modelId);
}

// ---------------------------------------------------------------------------
// Orphan-proof ffmpeg PID tracking (2026-09-28 ffmpeg-CPU fix).
//
// Workers report every ffmpeg spawn/exit ({type:ffmpeg-spawn/exit,pid}) so
// main can SIGKILL grandchildren by PID even AFTER the worker died (the old
// code only killed the Node worker; ffmpeg survived to PID 1 with no timers
// left — the 500%+ CPU after "done" and after quit). Maps survive worker
// restarts; entries are best-effort (ESRCH on kill = already gone).
// ---------------------------------------------------------------------------
const indexerFfmpegPids = new Map(); // pid -> { firstSeen, label }
const transcribeFfmpegPids = new Map();

function trackFfmpegSpawn(map, pid, label) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (!map.has(pid)) {
		map.set(pid, { firstSeen: Date.now(), label: String(label || "") });
	}
}

function untrackFfmpegExit(map, pid) {
	if (Number.isInteger(pid)) map.delete(pid);
}

// SIGKILL every PID in the map. Never throws. Returns killed count.
function killTrackedFfmpegPids(map, reason) {
	let killed = 0;
	for (const pid of [...map.keys()]) {
		try {
			process.kill(pid, "SIGKILL");
			killed++;
		} catch {
			/* ESRCH = already gone, EPERM = not ours — both fine */
		} finally {
			map.delete(pid);
		}
	}
	if (killed > 0) {
		console.warn(
			`[memories] killed ${killed} tracked ffmpeg child(ren) (${reason || "unknown"})`,
		);
	}
	return killed;
}

// Ask a live worker to kill its own ffmpeg children first (fast path when
// the worker is still alive), then belt-and-braces kill tracked PIDs by PID
// (covers the worker-already-dead case). Never throws, never awaits.
function requestWorkerKillFfmpeg(worker, map, reason) {
	try {
		if (worker && worker.process && !worker.dead) {
			try {
				worker.process.postMessage({ type: "kill-ffmpeg", reason });
			} catch {
				/* worker gone — PID sweep below still applies */
			}
		}
	} finally {
		if (map) killTrackedFfmpegPids(map, reason);
	}
}

// Startup orphan reaper (2026-09-28): previous runs (pre-fix, or crashes)
// may have left ffmpeg children reparented to PID 1 still decoding. They
// share our bundled binary path and usually the library path. Best-effort:
// list processes via `ps`, SIGKILL matches, never throw, never kill anything
// that does not look like ours.
function reapStaleFfmpegOrphans() {
	try {
		const { execFileSync } = require("child_process");
		let out = "";
		try {
			out = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
				encoding: "utf8",
				timeout: 5000,
				windowsHide: true,
			});
		} catch {
			return 0;
		}
		let killed = 0;
		for (const line of String(out).split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			if (!m) continue;
			const pid = Number(m[1]);
			const ppid = Number(m[2]);
			const cmd = m[3] || "";
			if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
			// Our bundled binary only: packaged Resources/ffmpeg or
			// ffmpeg-static under node_modules. Never touch system ffmpeg.
			const isOurs =
				cmd.includes("Contents/Resources/ffmpeg") ||
				cmd.includes("node_modules/ffmpeg-static");
			if (!isOurs) continue;
			// Extra guard: only orphans (PPID 1) or library-path decodes.
			// A live worker's ffmpeg has a live parent and is tracked; the
			// dangerous leftovers are exactly the PPID-1 ones.
			const touchesLibrary =
				cmd.includes("library/photos") || cmd.includes("memories-transcribe-");
			if (ppid !== 1 && !touchesLibrary) continue;
			try {
				process.kill(pid, "SIGKILL");
				killed++;
			} catch {
				/* already gone */
			}
		}
		if (killed > 0) {
			console.warn(
				`[memories] reaped ${killed} stale ffmpeg orphan(s) from previous runs`,
			);
		}
		return killed;
	} catch {
		return 0;
	}
}

// transformers.js writes the ONNX weights last, so a cache holding only
// partial files is an interrupted FIRST download — that must still count as
// first run. Both quantized weights (vision + text) must be on disk for the
// model to count as downloaded. Per-model: the cache root may already hold
// ANOTHER model's weights, which says nothing about the active one's.
function countOnnx(dir) {
	try {
		let n = 0;
		for (const entry of fs.readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (fs.statSync(full).isDirectory()) {
				n += countOnnx(full);
			} else if (entry.endsWith(".onnx")) {
				n++;
			}
		}
		return n;
	} catch {
		return 0;
	}
}

// transformers.js (v2 and v3 alike) caches each repo under
// <cache>/<org>/<name>/onnx/ (the FileCache keys on the request path, e.g.
// Xenova/clip-vit-base-patch32/onnx/…), so weights downloaded by either
// version are found. Legacy v1 caches used models--<org>--<name>; both are
// checked so a model downloaded by any version counts as downloaded.
function modelCacheDir(modelId) {
	const repo = (getModel(resolveModelId(modelId)) || {}).repo || "";
	return path.join(app.getPath("userData"), "models", ...repo.split("/"));
}

function modelDownloaded(modelId) {
	const config = getModel(resolveModelId(modelId)) || {};
	if (config.minimumWeightBytes) {
		const root = modelCacheDir(modelId);
		return Object.entries(config.minimumWeightBytes).every(
			([relativePath, minimumBytes]) => {
				try {
					return (
						fs.statSync(path.join(root, relativePath)).size >= minimumBytes
					);
				} catch {
					return false;
				}
			},
		);
	}
	const current = countOnnx(modelCacheDir(modelId));
	if (current >= 2) return true;
	// Legacy transformers v1 layout (models--<org>--<name>).
	const repo = (getModel(resolveModelId(modelId)) || {}).repo || "";
	const legacy = path.join(
		app.getPath("userData"),
		"models",
		`models--${repo}`,
	);
	return countOnnx(legacy) >= 2;
}

function indexerEnv() {
	const ffmpegPath =
		process.env.FFMPEG_PATH ||
		(process.resourcesPath &&
		fs.existsSync(path.join(process.resourcesPath, "ffmpeg"))
			? path.join(process.resourcesPath, "ffmpeg")
			: undefined);
	return {
		...process.env,
		INDEXER_MODEL: poolModelId(),
		TRANSFORMERS_CACHE: path.join(app.getPath("userData"), "models"),
		// Phase 1.4 detect cache: per-file shot plans live next to other
		// userData state so re-import / re-analysis skips the ffmpeg scene
		// pass. MEMORIES_DATA_DIR smoke runs already isolate userData; this
		// makes the packaged app (which does not set MEMORIES_DATA_DIR)
		// cache too.
		SCM_DETECT_CACHE_DIR: path.join(app.getPath("userData"), "detect-cache"),
		// EP A/B knob (plan 0.3): pass through if set in the main process;
		// default remains cpu inside the worker when unset.
		...(process.env.SCM_EXECUTION_PROVIDERS
			? { SCM_EXECUTION_PROVIDERS: process.env.SCM_EXECUTION_PROVIDERS }
			: {}),
		...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}),
	};
}

// Kill the whole pool (and any in-flight requests). Used when the model
// must change: the workers hold the old model in memory, so a model switch
// is a pool respawn, never a reload inside a worker.
//
// Orphan fix: each worker is asked to SIGKILL its ffmpeg children FIRST,
// then tracked PIDs are killed by PID (covers workers already dead), and
// only then is the Node worker itself killed. The old order (kill worker
// only) orphaned ffmpeg to PID 1.
function stopIndexerPool() {
	for (const worker of indexerWorkers) {
		requestWorkerKillFfmpeg(worker, indexerFfmpegPids, "stopIndexerPool");
		if (worker.process) {
			try {
				worker.process.kill();
			} catch {
				/* already gone */
			}
		}
	}
	indexerWorkers = [];
	indexerReady = null;
	indexerInitFailed = null;
	modelStatus = null;
	modelFirstRun = false;
}

// Fork one worker and wire its message/exit handlers. The worker serializes
// its own message handling (see indexer.js) — the pool just feeds it requests.
function createIndexerWorker({ primary = false } = {}) {
	const worker = {
		process: null,
		primary,
		ready: null,
		dead: false,
		pending: new Map(),
	};
	worker.ready = new Promise((resolve, reject) => {
		// Kept so the exit handler can settle init when the process dies
		// before answering (kill-during-fork): without this, an
		// `await indexerReady` that captured this promise hangs forever —
		// every other indexer call carries a timeout, this one never did.
		worker.readyReject = reject;
		worker.process = utilityProcess.fork(
			path.join(__dirname, "indexer", "indexer.js"),
			[],
			{
				env: indexerEnv(),
				serviceName: primary
					? "clip-indexer"
					: `clip-indexer-${indexerWorkers.length}`,
			},
		);
		// From the moment a worker forks the model is warming; the primary
		// drives the renderer's status (a first-run download is its job; the
		// extras load from the already-populated cache and stay quiet).
		if (primary) {
			modelFirstRun = !modelDownloaded(poolModelId());
			modelStatus = {
				type: "model",
				phase: "loading",
				progress: null,
				firstRun: modelFirstRun,
				modelId: poolModelId(),
			};
			updateTrayState();
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send("memories:status", modelStatus);
			}
		}
		const onInit = (msg) => {
			if (msg && msg.type === "init-done") {
				worker.process.off("message", onInit);
				if (msg.ok) {
					// A worker for the CURRENTLY ACTIVE model owns the library's
					// textMean (centering is per-model). During a migration the
					// pool runs the TARGET model while the library still names
					// the old one, so its textMean is NOT adopted here — the
					// migration fetches it explicitly at the flip.
					if (
						primary &&
						poolModelId() === loadLibrary().modelId &&
						!loadLibrary().pendingModelMigration
					) {
						if (Array.isArray(msg.textMean)) {
							loadLibrary().textMean = new Float32Array(msg.textMean);
							void saveLibrary();
						}
						// The ONNX output dim is the truth: align the library's
						// dim with it (and warn when the persisted dim disagreed
						// — a stale/wrong-model bin must not rank silently).
						if (Number(msg.dim) > 0 && loadLibrary().dim !== msg.dim) {
							if (loadLibrary().filenames.length === 0) {
								loadLibrary().dim = msg.dim;
							} else {
								console.warn(
									`[memories] indexed dim ${loadLibrary().dim} does not match ` +
										`the ${loadLibrary().modelId} model output (${msg.dim}); ` +
										"re-embed the library (switch models or re-import) to fix ranking.",
								);
							}
						}
					}
					resolve(msg);
					// The active model's weights just finished downloading (first
					// run): let the picker refresh its downloaded flags via the
					// same channel the preload path uses.
					if (primary && modelFirstRun) {
						for (const win of BrowserWindow.getAllWindows()) {
							win.webContents.send("memories:status", {
								type: "model-preload",
								modelId: poolModelId(),
								phase: "ready",
								progress: 100,
							});
						}
					}
				} else {
					const err = new Error(msg.error || "Indexer init failed");
					if (primary) indexerInitFailed = err;
					// A worker that cannot load its model can never serve a
					// request. Drop it from dispatch and free the half-loaded
					// model so the pool rebuilds cleanly: the primary's exit
					// resets indexerReady/status (the next spawn retries the
					// load — an interrupted first download resumes from its
					// cache, which is the recovery path), and a failed extra
					// just disappears from round-robin instead of poisoning
					// every Nth request with a 180s timeout.
					worker.dead = true;
					// Demote before killing so a late exit event can't promote a
					// stale worker's ready promise onto a newer pool.
					worker.primary = false;
					try {
						worker.process.kill();
					} catch {
						/* already gone */
					}
					reject(err);
				}
			}
		};
		worker.process.on("message", (event) => {
			const msg = event && event.data !== undefined ? event.data : event;
			// Orphan-fix PID tracking: workers report every ffmpeg spawn/exit
			// so main can SIGKILL grandchildren by PID after the worker dies.
			if (msg && msg.type === "ffmpeg-spawn") {
				trackFfmpegSpawn(indexerFfmpegPids, msg.pid, msg.label);
				return;
			}
			if (msg && msg.type === "ffmpeg-exit") {
				untrackFfmpegExit(indexerFfmpegPids, msg.pid);
				return;
			}
			if (msg && msg.type === "ffmpeg-killed") {
				// Worker confirmed its own sweep; PID map entries for exited
				// children arrive separately as ffmpeg-exit. Best-effort sync:
				// drop any PIDs the worker says are gone (none named = noop).
				return;
			}
			if (msg && (msg.type === "status" || msg.type === "model")) {
				if (msg.type === "model" && primary) {
					modelStatus = {
						...msg,
						firstRun: modelFirstRun,
						modelId: poolModelId(),
					};
					updateTrayState();
				}
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", msg);
				}
			}
			if (msg && msg.type === "enrich-progress") {
				// Background scene analysis → renderer tray (Phase 4). The
				// worker omits the request id so this can never collide with
				// the pending-map resolution below; the queue length rides
				// along so the tray can show "N more waiting".
				enrichEventsObserved++;
				lastEnrichProgress = msg;
				// Heartbeat clock: every embed tick (including heartbeat-only
				// ticks that repeat the same done count) proves the worker is
				// alive inside a long ffmpeg decode. pumpEnrichment uses the
				// silence duration to tell slow-but-alive from wedged.
				lastEnrichHeartbeatAt = Date.now();
				if (msg.phase === "embed" && Number.isFinite(msg.gi)) {
					lastEnrichDetail = {
						gi: msg.gi,
						t: msg.t,
						step: msg.step || null,
					};
				} else if (msg.phase !== "embed") {
					lastEnrichDetail = null;
				}
				if (msg.phase === "detect") {
					enrichPhaseCounts.detect++;
					if (!(msg.pct >= 0 && msg.pct <= 1)) enrichProgressViolations++;
				} else if (msg.phase === "embed") {
					enrichPhaseCounts.embed++;
					// Heartbeat ticks repeat the previous done count by design
					// (same segment still decoding) — only validate real
					// forward progress, never the liveness pings.
					if (!msg.heartbeat) {
						if (!(msg.total > 0 && msg.done >= 1 && msg.done <= msg.total)) {
							enrichProgressViolations++;
						}
					}
				}
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", {
						...msg,
						type: "enrich",
						pending: Math.max(0, enrichQueue.length - 1),
					});
				}
			}
			onInit(msg);
			if (msg && msg.id && worker.pending.has(msg.id)) {
				const { resolve: r, reject: j, timer } = worker.pending.get(msg.id);
				worker.pending.delete(msg.id);
				clearTimeout(timer);
				if (msg.ok) r(msg);
				else j(new Error(msg.error || "Indexer request failed"));
			}
		});
		worker.process.on("exit", (...args) => {
			// Forensic log: a dead worker with no reason in the log is
			// undebuggable from CI artifacts. Arg shape varies by Electron
			// version, so dump everything (code-first vs event-first).
			// Pair with the app-level child-process-gone listener below,
			// whose `reason` names oom/crashed/killed explicitly.
			try {
				console.log(`[indexer] worker exited args=${JSON.stringify(args)}`);
			} catch {
				console.log(`[indexer] worker exited (unserializable args)`);
			}
			worker.dead = true;
			indexerWorkers = indexerWorkers.filter((w) => w !== worker);
			for (const [, req] of worker.pending) {
				clearTimeout(req.timer);
				req.reject(new Error("Indexer exited"));
			}
			worker.pending = new Map();
			// Init never answered and never will — settle it so a captured
			// `await indexerReady` fails fast (every awaiter try/catches)
			// instead of hanging on a dead fork. A later spawn assigns a
			// fresh promise, so this rejection can't poison the new pool.
			if (worker.readyReject) {
				const reject = worker.readyReject;
				worker.readyReject = null;
				reject(new Error("Indexer exited during init"));
			}
			if (indexerWorkers.length === 0) {
				// Whole pool gone: let a fresh spawn rebuild everything.
				indexerReady = null;
				indexerInitFailed = null;
				modelStatus = null;
				modelFirstRun = false;
			} else if (worker.primary) {
				// The primary died but extras survive: promote the oldest
				// remaining worker so indexerReady always points at a live
				// worker's (already settled) promise — a dead primary's ready
				// could otherwise hang embed-query/healPhraseBin forever.
				indexerWorkers[0].primary = true;
				indexerReady = indexerWorkers[0].ready;
			}
		});
		worker.process.postMessage({ type: "init" });
	});
	// Extras' ready promises are never awaited (only the primary's is, via
	// indexerReady); without a handler, a failed extra's rejection would be
	// an unhandled rejection, which crashes the main process on modern Node.
	worker.ready.catch(() => {});
	return worker;
}

function spawnIndexer() {
	if (indexerWorkers.some((w) => !w.dead)) {
		// Pool already alive — top it up (e.g. after a worker exited).
		void growPool();
		return;
	}
	indexerWorkers = [];
	indexerInitFailed = null;
	const primary = createIndexerWorker({ primary: true });
	indexerWorkers.push(primary);
	indexerReady = primary.ready;
	void growPool();
}

// Fork the extra workers once the primary's model is ready (on a first run
// that means after the ~150MB download, so the extras never race it). Extra
// workers that fail init are simply dropped from dispatch — the pool keeps
// serving from whatever is alive.
async function growPool() {
	try {
		await indexerReady;
	} catch {
		return; // primary init failed; extras can't help
	}
	while (indexerWorkers.filter((w) => !w.dead).length < INDEXER_POOL_SIZE) {
		indexerWorkers.push(createIndexerWorker({ primary: false }));
	}
}

// Round-robin dispatch across live workers; queries and batch embeds share
// the pool (a query landing on a busy worker is an edge case, not the norm).
function askIndexer(message) {
	const live = indexerWorkers.filter((w) => !w.dead && w.process);
	if (live.length === 0) {
		return Promise.reject(new Error("Indexer not running"));
	}
	const worker = live[pickRoundRobin++ % live.length];
	return new Promise((resolve, reject) => {
		const id = `r${++requestId}`;
		const timer = setTimeout(() => {
			worker.pending.delete(id);
			reject(new Error("Indexer request timed out"));
		}, 180000);
		worker.pending.set(id, { resolve, reject, timer });
		worker.process.postMessage({ ...message, id });
	});
}

// Enrichment is pinned to the PRIMARY worker so chunked scene data reuses
// the worker's per-path plan cache — a round-robin would bounce chunks
// across workers and re-run the ffmpeg scene pass on every chunk.
// `timeoutMs` overrides the 180 s default: enrich-video chunks of a 2–3 h
// Ultra film (16 ffmpeg seeks + 16 CLIP embeds) are legitimately slower
// than a single photo embed, so pumpEnrichment passes ENRICH_CHUNK_TIMEOUT_MS.
function askPrimaryIndexer(message, timeoutMs = 180000) {
	const primary = indexerWorkers.find((w) => !w.dead && w.process && w.primary);
	if (!primary) return askIndexer(message);
	return new Promise((resolve, reject) => {
		const id = `r${++requestId}`;
		const timer = setTimeout(() => {
			primary.pending.delete(id);
			const err = new Error("Indexer request timed out");
			err.code = "INDEXER_TIMEOUT";
			err.timeoutMs = timeoutMs;
			reject(err);
		}, timeoutMs);
		primary.pending.set(id, { resolve, reject, timer });
		primary.process.postMessage({ ...message, id });
	});
}

// Restart a wedged primary worker: a chunk that timed out on the main side
// may still be grinding inside the worker (its queue stays busy), so every
// later chunk would queue behind the zombie and time out too — the exact
// 16/1024-forever signature.
//
// Orphan fix (2026-09-28): killing the Node worker does NOT drop ffmpeg —
// POSIX reparents it to PID 1 with no timers left. So the worker is asked to
// SIGKILL its ffmpeg children first AND main kills tracked PIDs by PID
// (covers the worker-already-dead case) before the worker itself is killed.
// The exit handler promotes an extra (or spawnIndexer rebuilds a fresh
// primary when the pool was size 1), and the plan cache rebuilds on the next
// chunk's scene pass. The job's `off` is preserved by the caller, so the
// retry resumes where it stalled.
function restartPrimaryIndexer(reason) {
	try {
		const primary = indexerWorkers.find(
			(w) => w.process && w.primary && !w.dead,
		);
		if (primary) {
			console.warn(`[memories] restarting wedged indexer worker (${reason})`);
			requestWorkerKillFfmpeg(primary, indexerFfmpegPids, `restart:${reason}`);
			primary.dead = true;
			primary.primary = false;
			try {
				primary.process.kill();
			} catch {
				/* already gone */
			}
		} else {
			// No live primary (already dead): tracked ffmpeg PIDs may still
			// be grinding — sweep them so a dead worker can't leave orphans.
			killTrackedFfmpegPids(indexerFfmpegPids, `restart-no-primary:${reason}`);
		}
	} finally {
		try {
			spawnIndexer();
		} catch {
			/* spawn retries on next pump */
		}
	}
}

// ---------------------------------------------------------------------------
// Model switching: re-embed the whole library in another model.
//
// The worker pool is respawned with INDEXER_MODEL pinned to the target; each
// row is re-embedded from its ORIGINAL source file (falling back to the
// app-managed library copy) through the same embed-photo path imports use,
// so GIF middle-frame averaging and phrase centering match exactly. The new
// pair is written to the target model's own bin files as the pump advances
// (checkpointed, but the index still names the OLD model — a crash mid-run
// leaves a consistent old-model library; the partial new bins are simply
// overwritten on retry). At the end the library flips: modelId, dim, and
// textMean come from the worker's own outputs, saveLibrary persists the new
// index + bins, and the model is calibrated against its real score band.
// The old model's bins stay on disk (memory-embeddings-<old>.bin), so
// switching back is a re-embed, never a loss.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model preload ("Download all models"): download a model's weights WITHOUT
// switching the library to it. The user can fetch every model ahead of time
// so switching later is instant (no download wait). Each preload forks a
// THROWAWAY indexer worker pinned to the target model (INDEXER_MODEL) whose
// normal init downloads + warms that model; its download progress relays to
// the renderer as { type: "model-preload", modelId, phase, progress }, and
// the worker is killed once init lands. The library is untouched — the
// weights land in the shared cache, nothing else changes.
// ---------------------------------------------------------------------------

let modelPreloads = new Map(); // modelId → { process, progress }

// Fork one worker, feed it INDEXER_MODEL=modelId so its init downloads the
// target's weights, relay progress, then kill it on init-done. Resolves
// { modelId, downloaded } when the model is on disk (or was already).
function preloadModelWeights(modelId) {
	const config = getModel(modelId);
	if (!config) return Promise.reject(new Error(`Unknown model: ${modelId}`));
	if (modelDownloaded(modelId)) {
		// Already cached — nothing to do (the UI calls this for every model
		// in "download all"; skipped ones resolve immediately).
		return Promise.resolve({ modelId, downloaded: true, skipped: true });
	}
	// The pool owns the ACTIVE model's download on first run, and a migration
	// pool owns its TARGET's download. Two processes writing the same cache
	// files would race (FileCache.put is a plain write in transformers.js v2
	// and v3 alike — no atomic temp+rename), so never preload those. This
	// guard lives HERE (not just in preloadAllModels) so the single-model IPC
	// can't bypass it.
	if (modelId === poolModelId()) {
		return Promise.resolve({
			modelId,
			skipped: true,
			note: "active model — the engine is downloading it",
		});
	}
	if (migrationState && migrationState.targetId === modelId) {
		return Promise.resolve({
			modelId,
			skipped: true,
			note: "already downloading — the model switch owns it",
		});
	}
	if (modelPreloads.has(modelId)) return modelPreloads.get(modelId).promise;

	const entry = {
		process: null,
		progress: null,
		promise: null,
	};
	entry.promise = new Promise((resolve, reject) => {
		entry.process = utilityProcess.fork(
			path.join(__dirname, "indexer", "indexer.js"),
			[],
			{
				env: { ...indexerEnv(), INDEXER_MODEL: modelId },
				serviceName: `clip-preload-${modelId}`,
			},
		);
		entry.process.on("message", (event) => {
			const msg = event && event.data !== undefined ? event.data : event;
			if (!msg) return;
			if (msg.type === "model") {
				entry.progress = msg.progress ?? null;
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", {
						type: "model-preload",
						modelId,
						phase: msg.phase,
						progress: entry.progress,
					});
				}
				// The worker posts phase "error" BEFORE the ok:false reply that
				// carries the real message; don't reject on the bare event or
				// the detailed error is lost.
				return;
			}
			if (msg.ok === false) {
				// Download/load failed — drop the worker and report the real error.
				entry.process.kill();
				modelPreloads.delete(modelId);
				reject(new Error(msg.error || `Preload of ${modelId} failed`));
				return;
			}
			if (msg.type === "init-done" && msg.ok) {
				entry.process.kill();
				modelPreloads.delete(modelId);
				resolve({
					modelId,
					downloaded: modelDownloaded(modelId),
					skipped: false,
				});
			}
		});
		entry.process.on("exit", () => {
			// Only fatal if the promise is still pending (the normal kill
			// after init-done already resolved it).
			if (modelPreloads.has(modelId)) {
				modelPreloads.delete(modelId);
				reject(new Error(`Preload worker for ${modelId} exited unexpectedly`));
			}
		});
		entry.process.postMessage({ type: "init" });
	});
	modelPreloads.set(modelId, entry);
	return entry.promise;
}

// Fetch every model the app knows about that isn't already on disk. Runs
// sequentially so a slow link doesn't saturate bandwidth across models, and
// each already-downloaded model resolves instantly. The ACTIVE model is
// skipped when its weights are missing — the primary pool owns that download
// on first run, and a parallel writer to the same cache files would race it.
// Resolves to an array of per-model results ({ modelId, downloaded, skipped? }).
async function preloadAllModels() {
	// preloadModelWeights itself skips the active/migration-owned models, so
	// this loop is a plain sequential fan-out over the registry.
	const results = [];
	for (const modelId of Object.keys(MODELS)) {
		try {
			results.push(await preloadModelWeights(modelId));
		} catch (err) {
			results.push({ modelId, error: err.message });
		}
	}
	return results;
}

// A migration is in flight; further switches are refused until it settles.
// A background delta tail (kind "fill") is the exception: a new switch
// cancels it (generation bump — its checkpoints stay on disk and the next
// delta resumes them) and proceeds.
let migrationState = null;
let migrationFillGeneration = 0;

// How often (rows) a running migration writes the target's bins to disk.
const MIGRATE_CHECKPOINT = 25;

// The file a row's embedding was computed from at import. The recorded
// source may have moved away; the app-managed copy is the fallback.
function rowSourcePath(i) {
	const l = loadLibrary();
	const source = l.sources && l.sources[i];
	if (source && fs.existsSync(source)) return source;
	return path.join(PHOTOS_DIR, l.filenames[i]);
}

// Re-embed every row of the library into `targetId`'s model. Resolves to
// { modelId, reembedded, failures } or throws on a blocking error. Progress
// is broadcast as { type: "migrate", phase, done, total, modelId }.
// Bounded-concurrency pump, sized like the import pipeline (pool×2).
const MIGRATE_CONCURRENCY = Math.max(2, INDEXER_POOL_SIZE * 2);
async function reembedToModel(targetId) {
	const target = getModel(targetId);
	if (!target) throw new Error(`Unknown model: ${targetId}`);
	// An in-flight import embeds rows through the pool, which a migration
	// pins to the TARGET model — those rows would land as target-model
	// vectors in a library that still names the old one. Refuse to start
	// until the batch settles.
	if (importInFlight) {
		throw new Error(
			"An import is in progress — switch models after it finishes.",
		);
	}
	const l = loadLibrary();
	const pendingRetirement = l.pendingModelMigration;
	if (pendingRetirement && pendingRetirement.targetId !== targetId) {
		throw new Error(
			`The retired ${pendingRetirement.fromId} index must finish migrating to ${pendingRetirement.targetId} first.`,
		);
	}
	if (l.modelId === targetId && !pendingRetirement)
		return { modelId: targetId, reembedded: 0, failures: [] };
	if (migrationState) {
		if (migrationState.kind === "fill") {
			migrationFillGeneration++;
			migrationState = null;
		} else {
			throw new Error("A model migration is already running");
		}
	}
	if (l.filenames.length === 0) {
		// No rows to re-embed — the switch is just a metadata flip.
		l.modelId = targetId;
		l.dim = getModel(targetId).dim || l.dim;
		l.textMean = null;
		l.pendingModelMigration = null;
		await saveLibrary();
		console.log(`[memories] switched empty library to ${targetId}`);
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		return { modelId: targetId, reembedded: 0, failures: [] };
	}

	const total = l.filenames.length;
	migrationState = { targetId, done: 0, total };
	const broadcast = (phase, extra = {}) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "migrate",
				phase,
				modelId: targetId,
				done: migrationState.done,
				total,
				...extra,
			});
		}
	};
	broadcast("embedding", { done: 0 });

	// Respawn the pool for the target model and wait for its model (a first
	// use downloads the weights here — the status LED shows that progress).
	stopIndexerPool();
	workerModelId = targetId;
	spawnIndexer();
	let initMsg;
	try {
		initMsg = await indexerReady;
	} catch (err) {
		// The respawned pool runs (or failed to run) the TARGET model. Put it
		// down so the next import/query re-forks for the library's actual
		// model — a live target-model pool here would embed later rows in the
		// wrong model.
		stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(`Failed to load model ${targetId}: ${err.message}`, {
			cause: err,
		});
	}
	const dim = Number(initMsg.dim) > 0 ? initMsg.dim : l.dim;

	// Fast path — the target model's bins already exist and match this
	// library's row count and dim (a previous switch, or a pre-v4 legacy
	// pair). Flip to them instead of re-embedding every row, so switching is
	// truly instant (the picker advertises exactly this). The pool is already
	// running the target model (respawned above), so textMean and dim come
	// from its live output; the target's own phrase bin is used when present
	// (otherwise the renderer degrades to image-only ranking, same as the
	// heal path). The old model's pair is untouched — switching back and
	// forth never re-does work or loses data.
	const existing = binInfo(targetId);
	if (
		existing &&
		existing.rows === l.filenames.length &&
		existing.dim === dim
	) {
		const embeddings = readBin(embedFileFor(targetId), l.filenames.length, dim);
		const phrases = readBin(phraseFileFor(targetId), l.filenames.length, dim);
		// The phrase bin must ALSO match: the slow migration always writes both
		// pairs, so a target with matching embed rows but a missing/mismatched
		// phrase bin is a partial/corrupt state — flipping to it would silently
		// degrade ranking to image-only. Fall through to the re-embed (which
		// rebuilds and heals) instead.
		if (
			embeddings.length === l.filenames.length &&
			phrases.length === l.filenames.length
		) {
			let textMean = null;
			try {
				const tm = await askIndexer({ type: "get-text-mean" });
				if (tm.ok && Array.isArray(tm.textMean)) {
					textMean = new Float32Array(tm.textMean);
				}
			} catch (err) {
				console.warn(
					`[memories] textMean fetch failed (${err.message}); uncentered queries`,
				);
			}
			l.embeddings = embeddings;
			l.phrases = phrases;
			l.dim = dim;
			l.textMean = textMean;
			l.modelId = targetId;
			l.pendingModelMigration = null;
			workerModelId = null;
			await saveLibrary();
			console.log(
				`[memories] switched ${l.filenames.length} rows to ${targetId} from existing bins ` +
					"(instant, no re-embed)",
			);
			migrationState = null;
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send("memories:status", { type: "library-updated" });
			}
			try {
				await calibrateThresholds(targetId);
			} catch (err) {
				console.warn(`[memories] threshold calibration failed: ${err.message}`);
			}
			try {
				backfillEnrichment();
				backfillTranscription();
			} catch (err) {
				console.warn(
					`[memories] post-migration scene backfill skipped: ${err.message}`,
				);
			}
			return { modelId: targetId, reembedded: 0, failures: [], instant: true };
		}
	}

	// Delta path — the target's bins exist with a row-identity snapshot from
	// a previous switch (same pipeline version): flip to the reused rows NOW
	// and embed only the missing tail in the background, so a switch after N
	// new imports costs N embeds instead of the whole library. Falls through
	// to the foreground slow path when there is nothing reusable (first
	// switch, pipeline change, or unreadable bins).
	const delta = planDeltaReuse(targetId, dim, [...l.filenames]);
	if (delta.usable && delta.reused > 0) {
		return flipWithBackgroundFill(targetId, dim, delta, broadcast, total);
	}

	// Snapshot the row set: if an import lands mid-migration the flip below
	// aborts rather than misaligning (the old model's library stays intact).
	// The snapshot ALSO pairs every checkpoint's bins with the row identity
	// they align to (delta resumes from them), and the flip verifies identity
	// — not just length — so a same-length delete+import can't silently
	// misalign vectors.
	const rowCount = l.filenames.length;
	const rowFilenames = [...l.filenames];
	// Dense from the start: checkpointed writeBins mid-migration must never
	// see sparse holes (.map skips holes, so Buffer.concat would throw on
	// the unwritten tail). Unwritten rows read as zero vectors until their
	// reply lands — same contract as failed rows below.
	const newEmbeddings = new Array(rowCount).fill(null);
	const newPhrases = new Array(rowCount).fill(null);
	const failures = [];
	let next = 0;
	let inFlight = 0;
	// Checkpoints below carry partial target-model vectors: stamp them
	// incomplete so a crash resumes the tail (delta) instead of serving
	// zeros as final. Cleared before the final save at the flip.
	setEmbedIncomplete(targetId, true);

	await new Promise((resolveBatch) => {
		const pump = () => {
			while (inFlight < MIGRATE_CONCURRENCY && next < rowCount) {
				const i = next++;
				inFlight++;
				(async () => {
					try {
						const filename = l.filenames[i];
						// Videos go through the video path (ffmpeg frame
						// extraction); sharp cannot decode a video file, so
						// embedding one as a photo always fails and zeroes
						// the row. Photos use the same embed path imports do
						// (GIF middle-frame averaging included).
						const reply = await askIndexer({
							type: isVideo(filename) ? "embed-video" : "embed-photo",
							path: rowSourcePath(i),
							filename,
						});
						// Failed rows persist as explicit zero vectors (not
						// undefined) so every row keeps a real, aligned array
						// and encodeBin has nothing to guess about.
						if (reply.vec && reply.vec.length === dim) {
							newEmbeddings[i] = new Float32Array(reply.vec);
						} else {
							failures.push(`${filename}: empty or wrong-dim vector`);
							newEmbeddings[i] = new Float32Array(dim);
						}
						if (reply.phrase && reply.phrase.length === dim) {
							newPhrases[i] = new Float32Array(reply.phrase);
						} else {
							if (reply.phrase) {
								failures.push(`${filename}: wrong-dim phrase`);
							}
							newPhrases[i] = new Float32Array(dim);
						}
					} catch (err) {
						failures.push(`${l.filenames[i]}: ${err.message}`);
					} finally {
						inFlight--;
						migrationState.done++;
						if (migrationState.done % MIGRATE_CHECKPOINT === 0) {
							void writeBins(targetId, newEmbeddings, newPhrases, dim, dim, {
								filenames: rowFilenames,
								incomplete: true,
							});
						}
						broadcast("embedding");
						pump();
						if (migrationState.done >= rowCount && inFlight === 0) {
							resolveBatch();
						}
					}
				})();
			}
		};
		pump();
	});

	if (failures.length === rowCount) {
		// Same as the model-load failure: never leave a pool forked for the
		// target model behind a library that still names the old one.
		stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(
			`Migration to ${targetId} failed for every row: ${failures[0]}`,
		);
	}

	// Flip. If the library changed while we worked, refuse the flip — the
	// new rows have no vectors in the target model yet (the old model stays).
	// Identity, not just length: a delete+import of equal length would pass a
	// length check with misaligned vectors.
	if (
		l.filenames.length !== rowCount ||
		rowFilenames.some((f, i) => f !== l.filenames[i])
	) {
		// Same as the model-load failure: never leave a pool forked for the
		// target model behind a library that still names the old one.
		// (The checkpoints already on disk stay resumable via delta.)
		stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(
			`Library changed during migration (${rowCount} → ${l.filenames.length}); ` +
				"run the model switch again",
		);
	}

	// The worker computed the target model's shared text direction at load.
	let textMean = null;
	try {
		const tm = await askIndexer({ type: "get-text-mean" });
		if (tm.ok && Array.isArray(tm.textMean)) {
			textMean = new Float32Array(tm.textMean);
		}
	} catch (err) {
		console.warn(
			`[memories] textMean fetch failed (${err.message}); uncentered queries`,
		);
	}

	l.embeddings = newEmbeddings;
	l.phrases = newPhrases;
	l.dim = dim;
	l.textMean = textMean;
	l.modelId = targetId;
	l.pendingModelMigration = null;
	workerModelId = null;
	// All rows landed: the final save stamps the meta complete.
	setEmbedIncomplete(targetId, false);
	await saveLibrary();

	console.log(
		`[memories] migrated ${rowCount - failures.length}/${rowCount} rows to ${targetId} ` +
			`(dim ${dim}, failures ${failures.length})`,
	);
	// The final "indexing" event reads migrationState.done (== total), so it
	// must fire BEFORE the state is cleared.
	broadcast("indexing");
	migrationState = null;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}

	// Calibrate the target's thresholds against its real score band (no-op
	// when the library is too small to measure).
	try {
		await calibrateThresholds(targetId);
	} catch (err) {
		console.warn(`[memories] threshold calibration failed: ${err.message}`);
	}

	// Phase 5: segment sidecars are per-model, so the target's is empty
	// after a migration — re-run the launch backfill so videos regain scene
	// coverage without waiting for the next app launch. Enrichment is gated
	// on !migrationState, so it queues safely behind nothing here.
	try {
		backfillEnrichment();
		backfillTranscription();
	} catch (err) {
		console.warn(
			`[memories] post-migration scene backfill skipped: ${err.message}`,
		);
	}

	return {
		modelId: targetId,
		reembedded: rowCount - failures.length,
		failures,
	};
}

// Delta switch (Option A): flip the library to the target model using cached
// rows NOW, then embed only the missing tail in the background. The switch
// promise resolves at the flip — search works immediately across reused rows
// (missing rows read as zero vectors until their tail lands, the same
// contract as failed rows) — while migrate-phase "embedding" events keep the
// tray informed until the tail completes with "indexing" + library-updated.
// Resolves to { modelId, reembedded: 0, reused, pending, failures: [],
// delta: true }; callers that need the settled state await
// migrationSettled().
async function flipWithBackgroundFill(targetId, dim, delta, broadcast, total) {
	const l = loadLibrary();
	const missing = [...delta.missing];
	// Dense flip: reused rows keep their cached vectors; missing rows are
	// explicit zero vectors until the background tail lands.
	l.embeddings = delta.reusedEmbeddings.map((v) => v || new Float32Array(dim));
	l.phrases = delta.reusedPhrases.map((v) => v || new Float32Array(dim));
	let textMean = null;
	try {
		const tm = await askIndexer({ type: "get-text-mean" });
		if (tm.ok && Array.isArray(tm.textMean)) {
			textMean = new Float32Array(tm.textMean);
		}
	} catch (err) {
		console.warn(
			`[memories] textMean fetch failed (${err.message}); uncentered queries`,
		);
	}
	l.dim = dim;
	l.textMean = textMean;
	l.modelId = targetId;
	l.pendingModelMigration = null;
	workerModelId = null;
	// Stamp incomplete BEFORE the save so the on-disk meta says resumable
	// even if the app quits mid-tail.
	setEmbedIncomplete(targetId, true);
	await saveLibrary();
	console.log(
		`[memories] switched ${l.filenames.length} rows to ${targetId} ` +
			`(delta: ${delta.reused} reused, ${missing.length} filling in background)`,
	);
	const gen = ++migrationFillGeneration;
	migrationState = {
		targetId,
		done: delta.reused,
		total,
		kind: "fill",
		gen,
	};
	broadcast("embedding");
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	// Detached: the switch is done at the flip; the tail reports through the
	// same migrate events and settles migrationState when it lands.
	void runDeltaFill(targetId, dim, missing, gen, broadcast);
	return {
		modelId: targetId,
		reembedded: 0,
		reused: delta.reused,
		pending: missing.length,
		failures: [],
		delta: true,
	};
}

// Background tail of a delta switch: embed the missing filenames through the
// target-model pool (already running — the switch respawned it), resolving
// each row's index LIVE by filename so imports/deletes/reorders mid-fill
// can't misalign vectors. Rows that gained real vectors meanwhile (an import
// embedding through the active pool) are skipped, never clobbered.
async function runDeltaFill(targetId, dim, missing, gen, broadcast) {
	const failures = [];
	let next = 0;
	let inFlight = 0;
	let done = 0;
	const alive = () => gen === migrationFillGeneration;
	await new Promise((resolveFill) => {
		const pump = () => {
			if (!alive()) return resolveFill();
			if (missing.length === 0) return resolveFill();
			while (inFlight < MIGRATE_CONCURRENCY && next < missing.length) {
				const filename = missing[next++];
				inFlight++;
				(async () => {
					try {
						if (!alive()) return;
						const cur = loadLibrary();
						const idx = cur.filenames.indexOf(filename);
						if (idx === -1) return; // deleted mid-fill
						const existing = cur.embeddings[idx];
						// An import embedded this row through the active
						// (target-model) pool while we queued — keep it.
						if (existing && !isZeroVector(existing)) return;
						const reply = await askIndexer({
							type: isVideo(filename) ? "embed-video" : "embed-photo",
							path: rowSourcePathAt(cur, idx),
							filename,
						});
						if (!alive()) return;
						const after = loadLibrary();
						const at = after.filenames.indexOf(filename);
						if (at === -1) return; // deleted while embedding
						if (reply.vec && reply.vec.length === dim) {
							after.embeddings[at] = new Float32Array(reply.vec);
						} else {
							failures.push(`${filename}: empty or wrong-dim vector`);
							after.embeddings[at] = new Float32Array(dim);
						}
						if (reply.phrase && reply.phrase.length === dim) {
							after.phrases[at] = new Float32Array(reply.phrase);
						} else {
							if (reply.phrase) {
								failures.push(`${filename}: wrong-dim phrase`);
							}
							after.phrases[at] = new Float32Array(dim);
						}
					} catch (err) {
						if (alive()) failures.push(`${filename}: ${err.message}`);
					} finally {
						inFlight--;
					}
					if (!alive()) {
						if (inFlight === 0) resolveFill();
					} else {
						done++;
						if (migrationState) migrationState.done++;
						if (done % MIGRATE_CHECKPOINT === 0) {
							const snap = loadLibrary();
							void writeBins(
								targetId,
								snap.embeddings,
								snap.phrases,
								dim,
								dim,
								{
									filenames: [...snap.filenames],
									incomplete: true,
								},
							);
						}
						broadcast("embedding");
						pump();
						if (done >= missing.length && inFlight === 0) resolveFill();
					}
				})();
			}
		};
		pump();
	});
	// Superseded by a newer switch — it owns the state now; our checkpoints
	// stay on disk for the next delta to resume.
	if (!alive()) return;
	if (loadLibrary().modelId !== targetId) return;
	const filled = missing.length - failures.length;
	setEmbedIncomplete(targetId, false);
	await saveLibrary();
	console.log(
		`[memories] delta fill for ${targetId} complete: ${filled}/${missing.length} rows ` +
			`(failures ${failures.length})`,
	);
	// The final "indexing" event reads migrationState.done, so it must fire
	// BEFORE the state is cleared (same contract as the slow path).
	broadcast("indexing");
	migrationState = null;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	// Calibrate against the now-complete vectors (skipped at the flip: zeros
	// would have skewed the score band).
	try {
		await calibrateThresholds(targetId);
	} catch (err) {
		console.warn(`[memories] threshold calibration failed: ${err.message}`);
	}
	// Scene/transcript sidecars are per-model: re-queue coverage for the
	// target now that its vectors are final (same as the slow path).
	try {
		backfillEnrichment();
		backfillTranscription();
	} catch (err) {
		console.warn(
			`[memories] post-migration scene backfill skipped: ${err.message}`,
		);
	}
}

// Scripts/tests: resolve once no migration or delta fill is in flight (the
// delta switch promise resolves at the flip; this waits for the tail).
function migrationSettled() {
	if (!migrationState) return Promise.resolve();
	return new Promise((resolve) => {
		const t = setInterval(() => {
			if (!migrationState) {
				clearInterval(t);
				resolve();
			}
		}, 250);
	});
}

// rowSourcePath for a live library snapshot + resolved index (the delta fill
// re-resolves indices by filename, so it can't use the index-based helper).
function rowSourcePathAt(lib, idx) {
	const source = lib.sources && lib.sources[idx];
	if (source && fs.existsSync(source)) return source;
	return path.join(PHOTOS_DIR, lib.filenames[idx]);
}

// Launch resume: a previous run quit (or crashed) mid-fill, leaving
// incomplete:true in the active model's meta. Resume the tail instead of
// serving zeros as final. Called after the pool is warm, beside the scene
// backfills.
async function maybeResumeDeltaFill() {
	if (migrationState) return;
	let l;
	try {
		l = loadLibrary();
	} catch {
		return;
	}
	if (l.pendingModelMigration) return;
	if (l.filenames.length === 0 || !(l.dim > 0)) return;
	let meta;
	try {
		meta = readEmbedMeta(l.modelId);
	} catch {
		return;
	}
	if (!meta || meta.incomplete !== true) return;
	const delta = planDeltaReuse(l.modelId, l.dim, [...l.filenames]);
	if (!delta.usable || delta.missing.length === 0) {
		// Nothing to resume. When the vectors are complete (missing==0) the
		// stale flag is wrong — clear it and persist complete. When unusable
		// (no meta match), leave the flag: the next switch falls back to the
		// foreground path, which repairs everything.
		if (delta.usable) {
			setEmbedIncomplete(l.modelId, false);
			try {
				await saveLibrary();
			} catch {
				/* best-effort flag repair */
			}
		}
		return;
	}
	if (delta.reused === 0) return; // degenerate: leave it to a real switch
	const gen = ++migrationFillGeneration;
	setEmbedIncomplete(l.modelId, true);
	migrationState = {
		targetId: l.modelId,
		done: delta.reused,
		total: l.filenames.length,
		kind: "fill",
		gen,
	};
	console.log(
		`[memories] resuming interrupted fill for ${l.modelId}: ` +
			`${delta.reused} rows ok, ${delta.missing.length} to embed`,
	);
	const resumeModelId = l.modelId;
	const resumeDim = l.dim;
	const broadcast = (phase, extra = {}) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "migrate",
				phase,
				modelId: resumeModelId,
				done: migrationState ? migrationState.done : l.filenames.length,
				total: l.filenames.length,
				...extra,
			});
		}
	};
	void runDeltaFill(
		resumeModelId,
		resumeDim,
		[...delta.missing],
		gen,
		broadcast,
	);
}

// Retired/unknown model ids are detected by loadLibrary without changing the
// persisted index. Once the replacement worker is ready, run the normal
// checkpointed migration. A failed download or re-embed leaves that original
// disk state untouched, so the next launch can retry safely.
async function migratePendingModel() {
	const pending = loadLibrary().pendingModelMigration;
	if (!pending) return null;
	console.log(
		`[memories] migrating retired ${pending.fromId} library to ${pending.targetId}`,
	);
	return reembedToModel(pending.targetId);
}

// The manifest the renderer fetches from /memories-models.json: registry
// info + per-model state, enough to render the model picker and rank with
// the active model's thresholds.
function modelsManifest() {
	const l = loadLibrary();
	return {
		version: 1,
		activeModelId: l.modelId,
		models: Object.entries(MODELS).map(([id, config]) => {
			const bin = binInfo(id);
			return {
				id,
				label: config.label,
				description: config.description,
				dim: config.dim,
				inputSize: config.inputSize,
				license: config.license,
				speed: config.speed,
				quality: config.quality,
				thresholds: thresholdsFor(id),
				binCount: bin ? bin.rows : 0,
				calibrated: Boolean(thresholdsFor(id)),
				// True when the model's weights are on disk (drives the picker's
				// per-model Download chip + the "download all" affordance).
				downloaded: modelDownloaded(id),
			};
		}),
	};
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Recursively collect every supported media file under `dir`. Symlinked
// directories are skipped to avoid cycles; unreadable entries are ignored.
function scanDirForMedia(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Never recurse into symlinked directories (cycle risk); real
			// subdirectories are scanned recursively.
			if (!entry.isSymbolicLink()) scanDirForMedia(full, out);
		} else if (entry.isSymbolicLink()) {
			// Follow symlinks that resolve to media files (common in iCloud /
			// cloud-sync folders); statSync resolves the target, unlike the
			// lstat-based Dirent flags.
			try {
				if (
					fs.statSync(full).isFile() &&
					IMPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
				) {
					out.push(full);
				}
			} catch {
				/* dangling symlink — ignore */
			}
		} else if (
			entry.isFile() &&
			IMPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
		) {
			out.push(full);
		}
	}
	return out;
}

// Collapse a list of picked/dropped paths into importable files: directories
// expand to their media contents (recursive); plain files pass through so the
// per-file importer can still report unsupported ones.
function expandMediaPaths(paths) {
	const out = [];
	for (const p of paths) {
		let stat;
		try {
			stat = fs.statSync(p);
		} catch {
			out.push(p); // let importPaths report "File not found"
			continue;
		}
		if (stat.isDirectory()) scanDirForMedia(p, out);
		else out.push(p);
	}
	return out;
}

function uniqueName(base, taken) {
	const ext = path.extname(base);
	const stem = path.basename(base, ext);
	let candidate = base;
	let n = 2;
	while (taken.has(candidate)) {
		candidate = `${stem} (${n})${ext}`;
		n++;
	}
	taken.add(candidate);
	return candidate;
}

// SHA-256 of a file's bytes (hex). Content-based duplicate detection: a file
// renamed inside a watched folder is a NEW source path (path-dedupe can't see
// it) but its bytes are already in the library — the hash proves it, so the
// sync skips the copy+embed instead of growing the library with duplicates.
// Stall-bounded like copyFileWithWatchdog: a source on a hung network volume
// must not freeze the pipeline during the read either.
function hashFile(file, { stallMs = 30_000 } = {}) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash("sha256");
		let lastData = Date.now();
		const s = fs.createReadStream(file);
		const timer = setInterval(() => {
			if (Date.now() - lastData >= stallMs) {
				clearInterval(timer);
				s.destroy(
					new Error(`Read stalled (no progress for ${stallMs / 1000}s)`),
				);
			}
		}, 2_000);
		s.on("error", (err) => {
			clearInterval(timer);
			reject(err);
		});
		s.on("data", (c) => {
			lastData = Date.now();
			h.update(c);
		});
		s.on("end", () => {
			clearInterval(timer);
			resolve(h.digest("hex"));
		});
	});
}

// copyFile has no abort and no progress signal, so it is the ONE unbounded
// await in the import critical path: a stalled network volume (SMB/iCloud) or
// a locked file could otherwise freeze the whole pipeline forever (the embed
// phase is bounded by askIndexer's timeout, the copy was not). Watch the
// destination grow instead of using a wall-clock timeout — a legitimately
// large copy on a slow disk must never be killed just for being slow, only
// for making NO progress. On a stall the copy keeps running in the background
// (its late rejection is swallowed); the error outcome unlinks the partial
// destination in applyOutcome.
function copyFileWithWatchdog(
	src,
	dst,
	{ stallMs = 30_000, tickMs = 2_000 } = {},
) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let lastSize = -1;
		let lastGrow = Date.now();
		const timer = setInterval(() => {
			if (settled) return;
			let size;
			try {
				size = fs.statSync(dst).size;
			} catch {
				size = -1; // copy hasn't created the destination yet
			}
			if (size !== lastSize) {
				// Any change counts as progress — including a shrink, which is
				// copyFile truncating a stale destination before rewriting it.
				lastSize = size;
				lastGrow = Date.now();
			} else if (Date.now() - lastGrow >= stallMs) {
				clearInterval(timer);
				settled = true;
				reject(new Error(`Copy stalled (no progress for ${stallMs / 1000}s)`));
			}
		}, tickMs);
		fs.promises
			.copyFile(src, dst)
			.then((r) => {
				if (settled) return;
				clearInterval(timer);
				settled = true;
				resolve(r);
			})
			.catch((err) => {
				if (settled) return; // watchdog already reported the stall
				clearInterval(timer);
				settled = true;
				reject(err);
			});
	});
}

// C-01 Wave 2 (S2/S3): import-failure cache live in main-lib/failed-imports.js and main-lib/category-overrides.js (required at top).

// C-01 Wave 2 (S2/S3): category-overrides store live in main-lib/failed-imports.js and main-lib/category-overrides.js (required at top).

ipcMain.handle(
	"memories:set-category-override",
	(_event, filename, category) => {
		if (typeof filename !== "string" || !filename) {
			return { ok: false, error: "Invalid filename" };
		}
		if (category !== null && !CATEGORY_OVERRIDE_VALUES.has(category)) {
			return { ok: false, error: "Invalid category" };
		}
		const l = loadLibrary();
		const idx = l.filenames.indexOf(filename);
		if (idx === -1) return { ok: false, error: "Unknown file" };
		const hash = l.hashes && l.hashes[idx];
		if (!hash) {
			return {
				ok: false,
				error: "File has no content hash yet — try again shortly",
			};
		}
		const overrides = loadCategoryOverrides();
		if (category === null) delete overrides[hash];
		else overrides[hash] = category;
		saveCategoryOverrides();
		// The grid re-derives categories from the index on this broadcast.
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		return { ok: true };
	},
);

// C-01 Wave 2 (S2/S3): isSystemIndexerError live in main-lib/failed-imports.js and main-lib/category-overrides.js (required at top).

// C-01 Wave 2 (S2/S3): rememberImportFailure live in main-lib/failed-imports.js and main-lib/category-overrides.js (required at top).

// C-01 Wave 2 (S2/S3): isKnownImportFailure live in main-lib/failed-imports.js and main-lib/category-overrides.js (required at top).

// True while an import batch is running. The migration refuses to start
// while a batch is in flight (its rows would embed in the wrong model), and
// a second batch is refused too (uniqueName dedupe and the ordered flush
// assume one writer at a time).
let importInFlight = false;

// `fromWatch` marks a watched-folder sync (launch / poll / live fs event).
// The import-failure cache is only consulted for these: a manual re-import is
// the user explicitly asking for a fresh attempt, so it always runs.
async function importPaths(rawPaths, { fromWatch = false } = {}) {
	// A model migration re-embeds the whole library and pins the worker
	// pool to the target model. Rows imported mid-migration would be
	// embedded in the WRONG model — they'd land as target-model vectors in
	// a library that still names the old one (or misalign it when the flip
	// aborts). Refuse until it settles.
	if (migrationState) {
		const first =
			Array.isArray(rawPaths) && rawPaths[0] ? String(rawPaths[0]) : "import";
		return {
			added: [],
			skipped: [],
			errors: [
				{
					file: path.basename(first),
					error:
						"A model switch is in progress — import again once it finishes.",
				},
			],
			watched: [],
		};
	}
	if (importInFlight) {
		const first =
			Array.isArray(rawPaths) && rawPaths[0] ? String(rawPaths[0]) : "import";
		return {
			added: [],
			skipped: [],
			errors: [
				{
					file: path.basename(first),
					error: "An import is already running — try again when it finishes.",
				},
			],
			watched: [],
		};
	}
	importInFlight = true;
	updateTrayState();
	let result;
	try {
		result = await importPathsInner(rawPaths, { fromWatch });
	} finally {
		importInFlight = false;
		updateTrayState();
	}
	// Hidden-window completion note (watched-folder syncs with nothing new
	// stay silent — only batches that actually added photos ping).
	if (result && Array.isArray(result.added) && result.added.length > 0) {
		const n = result.added.length;
		const errs = Array.isArray(result.errors) ? result.errors.length : 0;
		maybeNotify(
			"Import complete",
			`${n} photo${n === 1 ? "" : "s"} added to your library` +
				(errs > 0 ? ` (${errs} file${errs === 1 ? "" : "s"} failed)` : "") +
				".",
		);
	}
	return result;
}

async function importPathsInner(rawPaths, { fromWatch = false } = {}) {
	spawnIndexer();
	// Any path may be a directory (folder picker / folder drop): expand it to
	// the media files inside so the batch counter below counts real files.
	const paths = expandMediaPaths(rawPaths);

	// Auto-watch folders: any DIRECTORY in the batch joins the persisted
	// watch list (the expand above already flattened it to files — rawPaths
	// still name the folders). Individual files are imported once, never
	// watched. The newly-watched names ride the result so the renderer can
	// say "now watching …" without a separate round trip.
	const watchedNow = [];
	for (const raw of rawPaths) {
		try {
			if (fs.statSync(raw).isDirectory() && addWatchedFolder(raw)) {
				watchedNow.push(path.basename(raw));
			}
		} catch {
			/* unreadable/missing — the import itself reports it */
		}
	}

	// Model warm-up now overlaps the copy phase: embed requests sent before
	// the model is ready queue in the workers (their message listeners attach
	// at module load, and every request awaits ensureModel()). Only a FAILED
	// model load short-circuits the batch — spawnIndexer sets the module-level
	// indexerInitFailed flag, which each file checks synchronously.
	const l = loadLibrary();
	const taken = new Set(l.filenames);
	// Source paths already recorded in the library — re-importing the same
	// folder (or re-picking/dragging the same files) must skip these instead
	// of importing renamed copies. Skipped paths are keyed by path (then
	// flattened to basenames) so one file dragged twice can't inflate the
	// skipped count.
	const importedSources = new Set(l.sources);
	// Content hashes of rows ALREADY in the library (from past sessions) — a
	// renamed file (new source path) whose bytes match one of these is a
	// duplicate and is skipped instead of copied+embedded again. The set is
	// fixed for the batch on purpose: two same-content files imported
	// together are two entries in the user's folder and both import, exactly
	// as before — dedupe targets renames BETWEEN syncs, not within a batch.
	const libraryHashes = new Set(l.hashes.filter(Boolean));
	const skippedPaths = new Set();
	const result = { added: [], skipped: [], errors: [], watched: watchedNow };

	// A path listed twice in one drop must import once. The sequential loop
	// used to catch this at iteration time; the concurrent pipeline checks
	// the source set at dispatch, so identical paths are collapsed here —
	// the first occurrence wins and the rest are reported skipped.
	const seenPaths = new Set();
	let uniquePaths = [];
	for (const p of paths) {
		if (seenPaths.has(p)) {
			skippedPaths.add(p);
			continue;
		}
		seenPaths.add(p);
		uniquePaths.push(p);
	}

	// A watched-folder scan has no chronological ordering guarantee. The
	// ordered flush below persists this sequence, and the All/File UI reads
	// the tail first, so establish source mtime order before dispatching work.
	uniquePaths = sortPathsByMtime(uniquePaths, fs.statSync);

	// Video posters are generated off the import critical path (see below);
	// all jobs must settle before the library-updated broadcast so the
	// renderer never sees a tile whose thumbnail is still missing.
	const posterJobs = [];

	// Disk persistence is coalesced: a per-file save rewrites the whole
	// index trio (O(n²) total I/O over a batch) while nothing reads the disk
	// mid-batch — the renderer only reloads on library-updated (batch end).
	// Poster extractions each spawn ffmpeg; cap how many run at once so a
	// video-heavy batch cannot saturate the machine while it is off the
	// critical path. Failures are swallowed (the video stays searchable;
	// its tile falls back to the "missing media" placeholder).
	const POSTER_CONCURRENCY = 2;
	const posterSlots = Array.from({ length: POSTER_CONCURRENCY }, () =>
		Promise.resolve(),
	);
	let posterSlotIndex = 0;
	const pushPoster = (filename, make) => {
		const slot = posterSlotIndex % POSTER_CONCURRENCY;
		posterSlotIndex++;
		const run = posterSlots[slot].then(make).catch((err) => {
			console.warn(`[memories] poster failed for ${filename}: ${err.message}`);
		});
		posterSlots[slot] = run;
		posterJobs.push(run);
	};

	// Per-file AI-processing status: main.js owns the batch counters so the
	// renderer can draw a real "N/total + phase" progress bar (copy → CLIP
	// embed → video frames/poster). `done` = files completed IN ORDER before
	// the current one, so the bar shows done+1/total while it's in flight.
	const total = uniquePaths.length;
	// Scale the checkpoint with batch size: a large import (3000 rows)
	// checkpoints every 25 rows = 120 saves, each encoding the full
	// growing bin pair (~18 MB at row 3000). Target ~20 checkpoints
	// instead to cut encoding+I/O by ~6× while still protecting
	// against mid-batch crashes.
	const CHECKPOINT_INTERVAL = Math.max(25, Math.ceil(total / 20));
	let sinceCheckpoint = 0;
	let done = 0;
	const sendImport = (phase, filename) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "import",
				phase,
				filename,
				done,
				total,
			});
		}
	};

	// The batch embeds run CONCURRENTLY across the worker pool; outcomes are
	// applied in file order so library rows stay 1:1 with filenames.
	const pendingResults = new Map();
	let next = 0;

	// Apply one file's outcome in order: add rows, checkpoint-save, or record
	// the skip/error. `done` doubles as the flush cursor — every path yields
	// exactly one outcome, so when done reaches total the batch is complete.
	const applyOutcome = (outcome) => {
		if (outcome.kind === "skipped") {
			skippedPaths.add(outcome.filePath);
			return;
		}
		if (outcome.kind === "error") {
			// The failure may predate the copy (validation, embed timeout);
			// unlink only what actually landed.
			try {
				fs.unlinkSync(outcome.dest);
			} catch {
				/* never copied — nothing to clean up */
			}
			result.errors.push({
				file: outcome.filename,
				error: outcome.err.message,
			});
			return;
		}
		l.filenames.push(outcome.filename);
		l.sources.push(outcome.filePath);
		if (!l.sourceMtimes) l.sourceMtimes = [];
		l.sourceMtimes.push(outcome.sourceMtime ?? null);
		// OCR text is extracted in the background after the batch (posters,
		// screenshots); the slot starts null so the backfill pass knows.
		if (!l.ocr) l.ocr = [];
		l.ocr.push(null);
		if (!l.ocrWords) l.ocrWords = [];
		l.ocrWords.push(null);
		// Content hash (parallel to filenames) — the rename-duplicate dedupe
		// of future syncs compares new files against this set.
		if (!l.hashes) l.hashes = [];
		l.hashes.push(outcome.hash || null);
		// Screenshot metadata hint (parallel to filenames) — the Screenshots
		// tab's rename-proof signal. false = probed, no metadata found.
		if (!l.screenshotHints) l.screenshotHints = [];
		l.screenshotHints.push(outcome.screenshotHint ?? null);
		importedSources.add(outcome.filePath);
		// A successful import retires any failure-cache entry for the file
		// (it was transient after all — the cache is only for poison files).
		retireImportFailure(outcome.filePath);
		l.dim = l.dim || outcome.reply.vec.length;
		l.embeddings.push(new Float32Array(outcome.reply.vec));
		// Phrase vectors must never be null: saveLibrary writes the bin
		// 1:1 with filenames, and a null would crash encodeBin after the
		// index file was already persisted (leaving an inconsistent trio).
		const phraseVec = outcome.reply.phrase
			? new Float32Array(outcome.reply.phrase)
			: new Float32Array(outcome.reply.vec.length);
		l.phrases.push(phraseVec);
		// Persist periodically instead of after every file (see the
		// checkpoint note above); the final save happens at batch end.
		if (++sinceCheckpoint >= CHECKPOINT_INTERVAL) {
			sinceCheckpoint = 0;
			void saveLibrary();
		}
		result.added.push(outcome.filename);
	};

	const flushResults = () => {
		while (pendingResults.has(done)) {
			const outcome = pendingResults.get(done);
			pendingResults.delete(done);
			applyOutcome(outcome);
			done++;
		}
	};

	// Process one file: validate, copy, then embed through the worker pool.
	// Always returns an outcome object (never throws) so the ordered flush
	// sees a row for every path.
	const processOne = async (seq) => {
		const filePath = uniquePaths[seq];
		let dest = null;
		try {
			// A failed model load (broken weights / download failure) must
			// not copy+unlink every remaining file: report the rest and bail.
			if (indexerInitFailed) {
				return {
					kind: "error",
					filename: path.basename(filePath),
					dest,
					err: new Error(
						`AI indexing unavailable: ${indexerInitFailed.message}`,
					),
				};
			}
			// Already imported from this exact source path: skip instead of
			// creating a "name (2).ext" copy. The source PATH (not the basename)
			// decides, so a same-named file from a different folder still imports.
			if (importedSources.has(filePath)) {
				return { kind: "skipped", filePath };
			}
			// A file that failed import MAX_IMPORT_FAILURES times UNCHANGED is
			// poison — don't re-copy + re-attempt it on every poll/event. Only
			// watched-folder syncs consult the cache: a manual re-import is the
			// user explicitly asking for a fresh attempt.
			if (fromWatch && isKnownImportFailure(filePath)) {
				return { kind: "skipped", filePath };
			}
			if (!fs.existsSync(filePath)) {
				return {
					kind: "error",
					filename: filePath,
					dest,
					err: new Error("File not found"),
				};
			}
			const sourceStat = fs.statSync(filePath);
			if (!sourceStat.isFile()) {
				return {
					kind: "error",
					filename: filePath,
					dest,
					err: new Error("File not found"),
				};
			}
			const sourceMtime = Number.isFinite(sourceStat.mtimeMs)
				? sourceStat.mtimeMs
				: null;
			const ext = path.extname(filePath).toLowerCase();
			if (!IMPORT_EXTENSIONS.has(ext)) {
				return {
					kind: "error",
					filename: path.basename(filePath),
					dest,
					err: new Error("Unsupported file type"),
				};
			}
			// Content dedupe: a file whose bytes are already in the library is
			// a duplicate even though its source path is new (the rename case).
			// Hashed before the copy so the expensive part is skipped entirely.
			const srcHash = await hashFile(filePath);
			if (libraryHashes.has(srcHash)) {
				return { kind: "skipped", filePath };
			}
			const isVideoFile = VIDEO_EXTENSIONS.has(ext);
			// Rename-proof Screenshots-tab signal: the file's own PNG/JPEG
			// text metadata ("Screenshot" in Software/UserComment) is read
			// straight from the source before the copy — a bounded read (see
			// screenshot-probe.js), so it never stalls the batch.
			const screenshotHint = isVideoFile
				? false
				: await probeScreenshotMetadata(filePath);
			let filename = uniqueName(path.basename(filePath), taken);
			dest = path.join(PHOTOS_DIR, filename);

			sendImport("copying", filename);
			// Async copy: a multi-GB video copied synchronously would freeze
			// the main process (and every IPC/status event with it) for the
			// duration of the copy. The watchdog bounds it: a stalled network
			// copy must not freeze the pipeline forever (see the helper).
			await copyFileWithWatchdog(filePath, dest);
			// Extension normalization: a file whose BYTES disagree with its
			// extension (WebP saved as .png, JPEG saved as .webp) is renamed
			// to match its content before anything else references it. This
			// keeps the served Content-Type, the decoder Chromium picks, and
			// the filename truthful with each other (see sniffImageMime —
			// mislabeled images are a wrong-decoder crash hazard). Videos are
			// untouched; same-type spellings (.jpeg vs .jpg) are untouched.
			if (!isVideoFile) {
				const sniffed = sniffImageMime(dest);
				const canon = sniffed ? canonicalImageExt(sniffed) : null;
				if (canon) {
					const cur = path.extname(filename).toLowerCase();
					const sameType =
						canon === cur || (canon === ".jpg" && cur === ".jpeg");
					if (!sameType) {
						const corrected = uniqueName(
							path.basename(filename, path.extname(filename)) + canon,
							taken,
						);
						try {
							fs.renameSync(dest, path.join(PHOTOS_DIR, corrected));
							console.log(
								`[memories] normalized ${filename} → ${corrected} (content is ${sniffed})`,
							);
							filename = corrected;
							dest = path.join(PHOTOS_DIR, filename);
						} catch (err) {
							console.warn(
								`[memories] extension normalization failed for ${filename}: ${err.message}`,
							);
						}
					}
				}
			}
			sendImport("embedding", filename);
			const reply = await askIndexer({
				type: isVideoFile ? "embed-video" : "embed-photo",
				path: dest,
				filename,
			});
			if (!reply.vec) throw new Error("Embedding produced no vector");
			if (isVideoFile) {
				sendImport("poster", filename);
				// Poster generation never touches the index, so it runs
				// concurrently with the rest of the batch instead of
				// stalling the import loop; all jobs settle just before
				// the library-updated broadcast below.
				pushPoster(filename, () => generatePoster(dest));
			}
			return {
				kind: "added",
				filename,
				filePath,
				reply,
				dest,
				hash: srcHash,
				sourceMtime,
				screenshotHint,
			};
		} catch (err) {
			// The failure predates the copy (validation, hash, embed timeout)
			// or the copy stalled — remember it so the watched-folder sync
			// stops retrying a poison file every poll. indexerInitFailed and
			// "File not found" return before the try's risky section, so only
			// real file-level failures land here; worker-lifecycle errors are
			// transient and system-wide, and must not poison individual files.
			if (!isSystemIndexerError(err)) rememberImportFailure(filePath);
			return { kind: "error", filename: path.basename(filePath), dest, err };
		}
	};

	// Bounded-concurrency pump: keep a couple of files in flight per worker
	// so a slow video on one worker doesn't idle the others; each worker
	// serializes its own requests (see indexer.js). The batch completes when
	// every path has been dispatched AND every in-flight task has settled
	// (its outcome flushed) — a plain Promise.all over the first wave would
	// miss tasks launched later by pump().
	const BATCH_CONCURRENCY = Math.max(2, INDEXER_POOL_SIZE * 2);
	const inflight = new Set();
	let resolveBatch = null;
	const batchDone = new Promise((r) => {
		resolveBatch = r;
	});
	const pump = () => {
		while (inflight.size < BATCH_CONCURRENCY && next < total) {
			const seq = next++;
			const task = processOne(seq).then(
				(outcome) => {
					pendingResults.set(seq, outcome);
					flushResults();
				},
				(err) => {
					// Defensive guard for the alignment invariant: processOne
					// always returns an outcome today, but an unexpected
					// rejection must still produce a row so the ordered flush
					// never stalls below total (which would misalign the bins).
					pendingResults.set(seq, {
						kind: "error",
						filename: path.basename(uniquePaths[seq]),
						dest: null,
						err,
					});
					flushResults();
				},
			);
			inflight.add(task);
			void task.finally(() => {
				inflight.delete(task);
				pump();
				// Every task's .then (flush) runs before its .finally, so when
				// this fires with nothing left in flight the batch is complete.
				if (next >= total && inflight.size === 0) resolveBatch();
			});
		}
	};
	pump();
	// Empty batch: nothing was dispatched, so nothing will ever resolve it.
	if (total === 0) resolveBatch();
	await batchDone;

	for (const p of skippedPaths) {
		result.skipped.push(path.basename(p));
	}

	// Let every video's poster land before the renderer learns about the
	// batch (poster jobs swallow their own errors — see pushPoster).
	await Promise.all(posterJobs);

	// Terminal event: all UI-visible work (copy → embed → poster) is done.
	// The renderer clears its progress card on this, so a main-initiated
	// sync (watched-folder launch/poll/live event) can't leave the card
	// stuck on screen — only the user-initiated paths used to clear it.
	sendImport("done", "");

	if (result.added.length > 0) {
		// Guarantee the disk matches memory (the loop checkpointed periodically).
		await saveLibrary();
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		// Scene enrichment: new videos are analyzed in the background AFTER
		// the batch broadcast, so import wall-clock is untouched.
		enqueueEnrichment(
			result.added
				.filter((name) => isVideo(name))
				.map((name) => ({
					filename: name,
					path: path.join(PHOTOS_DIR, name),
				})),
		);
		// Speech transcription: same videos, queued behind visual
		// enrichment (transcribeAllowed serializes on enrich drain).
		enqueueTranscription(
			result.added
				.filter((name) => isVideo(name))
				.map((name) => ({
					filename: name,
					path: path.join(PHOTOS_DIR, name),
				})),
		);
		// OCR text extraction: new photos are recognized in the background
		// too (posters, screenshots — the visible text CLIP can't read).
		enqueueOcr(result.added.filter((name) => !isVideo(name)));
	}
	return result;
}

// ---------------------------------------------------------------------------
// Watched folders ("Import Photos" auto-watch).
//
// Importing a FOLDER (native picker or drag & drop) adds it to a persisted
// watch list — individual files are imported once and never watched. The
// library then stays in sync with each watched folder on its own:
//   • every launch re-scans each folder and imports anything new,
//   • while running, fs events (debounced) and a periodic safety-net poll
//     do the same for files that land mid-session.
// Re-scanning is cheap by construction: importPaths dedupes by recorded
// source path, so already-imported files short-circuit before any copy or
// AI work and only genuinely new files are embedded.
// ---------------------------------------------------------------------------

const WATCHED_FOLDERS_FILE = path.join(DATA_DIR, "watched-folders.json");

// Watched directory paths, in import order (persisted across launches).
let watchedFolders = [];
// Live fs.watch handles keyed by folder, for teardown and re-arm.
const folderWatchers = new Map();
// Debounce per folder: a burst of fs events (a copy tool writing several
// files at once) collapses into a single re-scan.
const watchDebounceTimers = new Map();
// Folders whose fs.watch could not be armed at all (permissions, exotic
// volumes). Sync re-arm attempts skip these so the poll doesn't retry a
// known failure every cycle (and spam the log); a fresh user import of the
// folder tries again from scratch.
const watchFailedFolders = new Set();
let watchPollTimer = null;

function loadWatchedFolders() {
	try {
		const parsed = JSON.parse(fs.readFileSync(WATCHED_FOLDERS_FILE, "utf8"));
		if (Array.isArray(parsed.folders)) {
			watchedFolders = parsed.folders.filter((p) => typeof p === "string");
		}
	} catch {
		/* no watch list yet */
	}
}

function saveWatchedFolders() {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(
		WATCHED_FOLDERS_FILE,
		JSON.stringify({ version: 1, folders: watchedFolders }, null, "\t"),
	);
}

// Add a folder to the watch list (idempotent) and arm its live watcher.
// Returns true when the folder is newly watched. Paths are canonicalized
// (path.resolve strips trailing slashes and resolves relative paths), so
// "/Photos" and "/Photos/" are the same watched folder.
function addWatchedFolder(dir) {
	if (typeof dir !== "string" || !dir) return false;
	dir = path.resolve(dir);
	if (watchedFolders.includes(dir)) return false;
	watchedFolders.push(dir);
	saveWatchedFolders();
	watchFolder(dir);
	return true;
}

// Window after a folder change before re-syncing it (see the debounce note
// above).
const WATCH_DEBOUNCE_MS = 3000;
// fs events can be missed entirely on network/synced volumes (iCloud
// placeholders materialize quietly); the poll re-scans everything on a
// schedule so nothing is stranded until the next launch.
const WATCH_POLL_INTERVAL_MS = 60_000;

// Re-scan ONE folder and import anything new. Skips folders that vanished
// (they stay on the watch list — they may come back). While an import or
// migration owns the pipeline, importPaths would refuse, so retry shortly
// instead of dropping the change. Resolves when the (possibly empty) sync
// import settles.
function syncWatchedFolder(folder) {
	// A scheduled retry can outlive the watch itself (the user removed the
	// folder while an import was busy). Never sync — or worse, re-arm and
	// importPaths (which auto-watches folders in the batch) would resurrect
	// the folder the user just unwatched.
	if (!watchedFolders.includes(folder)) return Promise.resolve();
	if (importInFlight || migrationState) {
		setTimeout(() => syncWatchedFolder(folder), 5000);
		return Promise.resolve();
	}
	let stat;
	try {
		stat = fs.statSync(folder);
	} catch {
		return Promise.resolve();
	}
	if (!stat.isDirectory()) return Promise.resolve();
	// Re-arm a watcher that errored out earlier (poll-only coverage) — but
	// not one that could never be armed (the set below gates the retry).
	if (!folderWatchers.has(folder) && !watchFailedFolders.has(folder)) {
		watchFolder(folder);
	}
	return importPaths([folder], { fromWatch: true }).catch((err) => {
		console.warn(
			`[memories] watched-folder sync failed for ${folder}: ${err.message}`,
		);
	});
}

// Re-scan every watched folder, in order. Runs on launch and on the poll;
// awaiting each import keeps the pipeline single-writer.
async function syncWatchedFolders() {
	for (const folder of watchedFolders.slice()) {
		await syncWatchedFolder(folder);
	}
}

// Arm one folder's fs.watch. Recursive on macOS/Windows (catches files
// landing in subfolders); elsewhere it falls back to a top-level watch, and
// the poll covers whatever the platform watch can't see.
function watchFolder(folder) {
	if (folderWatchers.has(folder)) return;
	const onChange = () => {
		clearTimeout(watchDebounceTimers.get(folder));
		watchDebounceTimers.set(
			folder,
			setTimeout(() => {
				watchDebounceTimers.delete(folder);
				syncWatchedFolder(folder);
			}, WATCH_DEBOUNCE_MS),
		);
	};
	let watcher;
	try {
		watcher = fs.watch(folder, { recursive: true }, onChange);
	} catch {
		try {
			watcher = fs.watch(folder, onChange);
		} catch (err) {
			console.warn(`[memories] cannot watch ${folder}: ${err.message}`);
			watchFailedFolders.add(folder);
			return;
		}
	}
	watchFailedFolders.delete(folder);
	watcher.on("error", () => {
		// The watch died (folder unmounted / permissions). Drop it — the
		// poll still syncs, and the next sync re-arms it.
		folderWatchers.delete(folder);
	});
	folderWatchers.set(folder, watcher);
}

// Load the persisted list, arm every watcher, and start the safety-net poll.
function startWatchedFolderWatchers() {
	loadWatchedFolders();
	for (const folder of watchedFolders) watchFolder(folder);
	watchPollTimer = setInterval(
		() => void syncWatchedFolders(),
		WATCH_POLL_INTERVAL_MS,
	);
}

function stopWatchedFolderWatchers() {
	if (watchPollTimer) {
		clearInterval(watchPollTimer);
		watchPollTimer = null;
	}
	for (const timer of watchDebounceTimers.values()) clearTimeout(timer);
	watchDebounceTimers.clear();
	for (const watcher of folderWatchers.values()) {
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
	}
	folderWatchers.clear();
}

// The watched folders the renderer's panel lists. `exists` tells the UI a
// folder has vanished (unmounted/renamed) so it can say so instead of
// implying it is still being scanned.
function watchedFolderList() {
	return watchedFolders.map((p) => ({ path: p, exists: fs.existsSync(p) }));
}

// The on-disk path "Reveal in Finder" should reveal for a watched folder:
// only folders on the watch list that still exist. The renderer supplies
// the path; this guard keeps an arbitrary string from opening a location of
// the renderer's choosing (same contract as resolveRevealTarget for tiles).
function watchedFolderRevealTarget(folder) {
	if (typeof folder !== "string" || !folder) return null;
	if (!watchedFolders.includes(folder) || !fs.existsSync(folder)) return null;
	return folder;
}

// Stop watching a folder: drop it from the list, close its watcher, cancel
// any pending debounce, and persist. Photos already imported stay in the
// library — only future auto-imports stop. Returns false when the folder
// wasn't watched.
function removeWatchedFolder(dir) {
	const i = watchedFolders.indexOf(dir);
	if (i === -1) return false;
	watchedFolders.splice(i, 1);
	saveWatchedFolders();
	const watcher = folderWatchers.get(dir);
	if (watcher) {
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
		folderWatchers.delete(dir);
	}
	const timer = watchDebounceTimers.get(dir);
	if (timer) {
		clearTimeout(timer);
		watchDebounceTimers.delete(dir);
	}
	watchFailedFolders.delete(dir);
	return true;
}

// Extract a representative frame from an imported video into POSTERS_DIR,
// named after the video's basename (posterFor()). The tile renders this
// instead of the raw video, so nothing else needs to change.
// ---------------------------------------------------------------------------
// Scene-segment enrichment queue (Phase 1 of scene search).
//
// New videos are enriched in the BACKGROUND after their import batch ends —
// never on the import critical path. Dispatch is paced and gated: nothing
// runs while an import or migration is in flight or a query IPC is pending,
// so search and import latency are unaffected by construction (see
// DESIGN-SCENE-SEARCH.md §3). Chunks are ≤ SEGMENTS_PER_CHUNK segments, and
// the worker's priority lane lets queries preempt between chunks.
// ---------------------------------------------------------------------------

// Chunk size lives in indexer/segment-store-utils.js (SEGMENTS_PER_CHUNK);
// main.js never chunks directly — the worker's priority lane lets queries
// preempt between chunks.
const ENRICH_GAP_MS = 250;
// Retry delay between chunk attempts for the same video (backoff base).
const ENRICH_RETRY_DELAY_MS = 2000;

let enrichQueue = []; // [{ filename, path, off, retries, lastError }]
let enrichInFlight = false;
let enrichPendingQuery = false;
let enrichTimer = null;
let lastEnrichStart = 0;
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
// Per-file tombstones: filenames whose queued/in-flight work was cancelled
// by delete/purge/reset (dropQueuedJobsFor, purgeBackgroundWork). Every
// pump's commit path checks this alongside libraryHasRow/purgeEpoch and,
// on hit, discards the reply, drops the job, and deletes the entry — so
// the set stays bounded: an entry lives only until its orphan settles.
// Purge/reset clear it wholesale after draining (stale entries would
// otherwise discard legitimate re-queued work).
const deadJobs = new Set();
// True when this file's work was cancelled mid-flight (delete/purge).
// Consumes the entry on hit so tombstones never outlive their orphan —
// call it only on the discard path, never speculatively.
function isJobDead(filename) {
	if (!deadJobs.has(filename)) return false;
	deadJobs.delete(filename);
	return true;
}

// Phase 4: live progress for the renderer's enrichment tray. The worker's
// `enrich-progress` messages (deliberately id-less, so they can't trip the
// pending-request map) land in lastEnrichProgress; enrichEventsObserved backs
// the E2E's assertion that progress actually flows.
let lastEnrichProgress = null;
let lastEnrichHeartbeatAt = 0;
let lastEnrichDetail = null; // { gi, t, step } of the current segment
let enrichEventsObserved = 0;
// Videos queued since the last drain, for the hidden-window completion
// notification (incremented in enqueueEnrichment, consumed at the drain).
let enrichNotifyCount = 0;
// Per-phase progress counters + violation flag: backing the Phase-4 deep
// test (detect pct must stay in [0,1]; embed done must be 1..total).
let enrichPhaseCounts = { detect: 0, embed: 0 };
let enrichProgressViolations = 0;

function broadcastEnrichEvent(extra) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "enrich", ...extra });
	}
	// Menu-bar tray icon follows background work (no-op when the mode is off).
	updateTrayState();
}

// Current background-enrichment snapshot (Phase 4 tray). Served by the
// enrich-state IPC and replayed on did-finish-load so the tray is correct
// even when broadcasts raced the renderer's subscription.
//
// Stale-clear (long-film fix): progress is keyed by filename — a leftover
// tick from a finished/dropped video must never render as the NEXT job's
// done/total (the old code showed a stale 16/1024 after a drop). When the
// in-flight job doesn't match the last tick's filename, the snapshot reports
// the job with zeroed progress instead of someone else's numbers.
function enrichSnapshot() {
	const job = enrichInFlight ? enrichQueue[0] : null;
	const raw = lastEnrichProgress;
	const prog = job && raw && raw.filename === job.filename ? raw : null;
	const heartbeatAgeMs =
		job && lastEnrichHeartbeatAt > 0
			? Date.now() - lastEnrichHeartbeatAt
			: null;
	return {
		type: "enrich",
		paused: backgroundPaused,
		phase: job ? (prog?.phase === "embed" ? "embed" : "detect") : "queued",
		filename: job ? job.filename : null,
		pct: job && prog ? (prog.pct ?? null) : null,
		done: job && prog ? (prog.done ?? 0) : 0,
		total: job && prog ? (prog.total ?? 0) : 0,
		pending: enrichQueue.length - (job ? 1 : 0),
		active: Boolean(job),
		// Liveness detail for the tray/debug: which segment is decoding, in
		// which step (ffmpeg vs clip), and how long since the last heartbeat.
		gi:
			prog && Number.isFinite(prog.gi)
				? prog.gi
				: (lastEnrichDetail?.gi ?? null),
		t: prog && Number.isFinite(prog.t) ? prog.t : (lastEnrichDetail?.t ?? null),
		step: prog?.step ?? lastEnrichDetail?.step ?? null,
		heartbeatAgeMs,
		stalled:
			heartbeatAgeMs !== null && heartbeatAgeMs > ENRICH_STALL_TIMEOUT_MS,
	};
}

// Drop a stale progress tick that belongs to a finished/dropped video so it
// can never render as another job's numbers.
function clearEnrichProgressFor(filename) {
	if (lastEnrichProgress && lastEnrichProgress.filename === filename) {
		lastEnrichProgress = null;
		lastEnrichDetail = null;
		lastEnrichHeartbeatAt = 0;
	}
}

// Phase 4 backfill: videos that predate scene enrichment (or whose sidecar
// never landed) are enqueued on launch — one at a time, under the same idle
// gates as import-time enrichment — so a big library catches up without ever
// touching search or import latency. Videos whose plan was empty are
// recorded with an empty segment list, so they are not retried on every
// launch (enqueueEnrichment's dedupe guards this too).
function backfillEnrichment() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	const covered = loadSegments(l.modelId).videos;
	const missing = [];
	for (const name of l.filenames) {
		if (!isVideo(name)) continue;
		if (covered && covered.has(name)) continue;
		missing.push({ filename: name, path: path.join(PHOTOS_DIR, name) });
	}
	if (missing.length > 0) {
		console.log(
			`[memories] backfill: ${missing.length} video(s) missing scene data`,
		);
		enqueueEnrichment(missing);
	}
}

function enqueueEnrichment(files) {
	if (!Array.isArray(files)) return;
	let added = 0;
	for (const f of files) {
		if (
			f &&
			f.filename &&
			f.path &&
			!enrichQueue.some((q) => q.filename === f.filename)
		) {
			enrichQueue.push({ filename: f.filename, path: f.path, off: 0 });
			added++;
		}
	}
	if (added > 0) {
		// Counted for the drain notification (reset when it fires below).
		enrichNotifyCount += added;
		// Tray: a fresh batch queued (import or launch backfill).
		broadcastEnrichEvent({ phase: "queued", pending: enrichQueue.length });
	}
	scheduleEnrichment();
}

function scheduleEnrichment() {
	if (enrichTimer) return;
	enrichTimer = setTimeout(() => {
		enrichTimer = null;
		void pumpEnrichment();
	}, ENRICH_GAP_MS);
}

function enrichAllowed() {
	return (
		!backgroundPaused &&
		!enrichInFlight &&
		!importInFlight &&
		!migrationState &&
		!enrichPendingQuery &&
		!transcribePendingQuery &&
		enrichQueue.length > 0 &&
		Date.now() - lastEnrichStart >= ENRICH_GAP_MS
	);
}

async function pumpEnrichment() {
	if (!enrichAllowed()) {
		// While user-paused nothing will change until resume (which kicks
		// explicitly) — don't spin the gap timer for it.
		if (enrichQueue.length > 0 && !backgroundPaused) scheduleEnrichment();
		return;
	}
	const job = enrichQueue[0];
	// Row deleted while queued — drop without work, retry, or tray noise.
	if (job && !libraryHasRow(job.filename)) {
		console.log(
			`[memories] enriched ${job.filename}: row deleted while queued — dropping job`,
		);
		enrichQueue.shift();
		clearEnrichProgressFor(job.filename);
		broadcastEnrichEvent({
			phase: enrichQueue.length === 0 ? "idle" : "done",
			filename: job.filename,
			pending: enrichQueue.length,
		});
		scheduleEnrichment();
		return;
	}
	if (typeof job.retries !== "number") job.retries = 0;
	job.purgeEpoch = purgeEpoch;
	enrichInFlight = true;
	lastEnrichStart = Date.now();
	// Heartbeat baseline for THIS chunk: the worker's per-segment + interval
	// ticks refresh lastEnrichHeartbeatAt; silence past ENRICH_STALL_TIMEOUT_MS
	// means the chunk is wedged, not merely slow.
	lastEnrichHeartbeatAt = Date.now();
	try {
		const modelId = loadLibrary().modelId;
		const reply = await askPrimaryIndexer(
			{
				type: "enrich-video",
				path: job.path,
				fromIndex: job.off || 0,
				filename: job.filename,
				// The worker persists each segment's midpoint frame here so the
				// renderer can swap the card thumbnail to the best-scene poster.
				postersDir: POSTERS_DIR,
				// Scene density for the user's Settings → Video search preset
				// (resolved per job so a preset switch takes effect without a
				// worker restart; the worker keys its cached plan on it).
				budget: videoBudgetForCurrentQuality(),
			},
			ENRICH_CHUNK_TIMEOUT_MS,
		);
		const c = loadSegments(modelId);
		// Row deleted — or purged — while this chunk ran: committing would
		// resurrect sidecar entries (for a row that no longer exists) or
		// land partial fragments the backfill skips as "covered". Discard
		// the reply and drop the job (same finish shape as the tail below;
		// finally still clears the in-flight flag).
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!libraryHasRow(job.filename) ||
			job.purgeEpoch !== purgeEpoch
		) {
			console.log(
				`[memories] enriched ${job.filename}: row deleted or purged mid-flight — discarding chunk`,
			);
			enrichQueue.shift();
			clearEnrichProgressFor(job.filename);
			broadcastEnrichEvent({
				phase: enrichQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: enrichQueue.length,
			});
			scheduleEnrichment();
			return;
		}
		// One corrupt GOP must not kill a 1024-seg film: the worker returns
		// parallel arrays (segments[i] ↔ vecs[i], null = skipped) and still
		// advances fromIndex past failures. Partition here and persist only
		// the successful rows; skipped segments simply leave a searchable gap.
		const { okSegments, okVecs, skipped } = partitionChunkReply(
			reply.segments,
			reply.vecs,
		);
		// Segment rows share the index's model dim; persist it so the
		// renderer's header validation (header[1] === meta.dim) passes. The
		// cache starts dim-less (fresh, no prior file) — the index is the
		// authoritative source, the first SUCCESSFUL vector length the backup
		// (a fully-skipped chunk carries no usable dim).
		if (c.dim === 0) {
			const firstVec = okVecs.length > 0 ? okVecs[0] : null;
			c.dim = loadLibrary().dim || (firstVec ? firstVec.length : 0);
		}
		if (reply.ok && okVecs.length > 0) {
			// Append this chunk's rows and stamp the file's segment offsets
			// (poster = the segment's scene-poster index). mergeChunkSegments
			// ACCUMULATES into the file's list because the worker returns
			// only the slice it embedded THIS call — replacing the entry
			// here used to leave only the LAST chunk's segments in the
			// sidecar, making a long film searchable only in its final
			// minutes (pinned by test/pump-enrichment.test.js and the
			// phase-4 multi-chunk check).
			const segments = mergeChunkSegments(
				c.videos.get(job.filename) || [],
				okSegments,
				c.rows.length,
				SEGMENT_ROW_PER,
			);
			c.rows.push(...okVecs.map((v) => new Float32Array(v)));
			c.videos.set(job.filename, segments);
			c.loaded = true;
			saveSegments();
			job.retries = 0;
			job.okTotal = (job.okTotal || 0) + okVecs.length;
			job.skipTotal = (job.skipTotal || 0) + skipped;
			console.log(
				`[memories] enriched ${job.filename}: ${reply.fromIndex}/${reply.total} segments` +
					(skipped > 0 ? ` (${skipped} skipped)` : ""),
			);
		} else if (reply.ok && reply.total === 0) {
			// Nothing detectable (failed probe / too short) — record an empty
			// entry so the file is not retried on every launch.
			c.videos.set(job.filename, []);
			c.loaded = true;
			saveSegments();
			console.log(
				`[memories] enriched ${job.filename}: 0 segments (plan empty)`,
			);
		} else if (reply.ok && skipped > 0 && okVecs.length === 0) {
			// Whole chunk skipped (e.g. a run of corrupt GOPs): still advance
			// past it — dropping the film here would discard the 16 good
			// segments before it and freeze the tray at the chunk boundary.
			job.retries = 0;
			job.skipTotal = (job.skipTotal || 0) + skipped;
			console.warn(
				`[memories] enriched ${job.filename}: ${reply.fromIndex}/${reply.total} segments (all ${skipped} skipped in this chunk, continuing)`,
			);
		} else {
			console.warn(
				`[memories] enrichment returned no segments for ${job.filename}: ${reply.error || "unknown"}`,
			);
		}
		if (reply.ok && !reply.done) {
			job.off = reply.fromIndex || 0;
			scheduleEnrichment();
			return;
		}
		if (
			shouldParkEnrichment({
				done: reply.done,
				ok: reply.ok,
				okTotal: job.okTotal,
				skippedTotal: job.skipTotal,
				alreadyCovered: c.videos.has(job.filename),
			})
		) {
			// Poison pill: every segment skipped across every chunk (undecodable
			// frames, 2026-09-26: parseRawFrameSize missing the SAR-less
			// `WxH, q=` form). Without an entry, backfillEnrichment re-queues
			// this file on every launch and every model switch forever and the
			// tray never goes idle. Park it like the empty-plan path — an empty
			// entry means "no scene data, don't retry". A re-imported copy
			// arrives under removeLibraryRow/dropQueuedJobsFor cleanup, so a
			// genuinely fixed file gets another chance on re-import.
			c.videos.set(job.filename, []);
			c.loaded = true;
			saveSegments();
			console.warn(
				`[memories] enriched ${job.filename}: 0/${reply.total} segments (all ${job.skipTotal} skipped across every chunk — parking, will not retry until re-import)`,
			);
		}
	} catch (err) {
		// Row deleted — or purged — mid-chunk: the missing file (or the
		// purge) explains the failure — retrying would burn the whole
		// budget on it. Drop instead.
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!libraryHasRow(job.filename) ||
			job.purgeEpoch !== purgeEpoch
		) {
			console.log(
				`[memories] enrichment chunk for ${job.filename} failed after the row was deleted or purged — dropping job`,
			);
			enrichQueue.shift();
			clearEnrichProgressFor(job.filename);
			broadcastEnrichEvent({
				phase: enrichQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: enrichQueue.length,
			});
			scheduleEnrichment();
			return;
		}
		// Never-stall retry (long-film fix): a chunk timeout/error keeps the
		// job at its current offset and retries with backoff instead of
		// dropping a 2–3 h film for one slow segment. The timed-out worker
		// may still be grinding the orphaned chunk (its queue stays busy —
		// the 16/1024-forever signature), so restart the primary to drop the
		// zombie ffmpeg work with it. After ENRICH_MAX_RETRIES the video is
		// dropped for this session (backfill retries it); enrichment failure
		// never touches imports or search.
		job.retries = (job.retries || 0) + 1;
		job.lastError = err.message;
		if (job.retries <= ENRICH_MAX_RETRIES) {
			console.warn(
				`[memories] enrichment chunk ${job.off || 0} for ${job.filename} failed ` +
					`(attempt ${job.retries}/${ENRICH_MAX_RETRIES}): ${err.message} — retrying`,
			);
			if (err.code === "INDEXER_TIMEOUT") {
				restartPrimaryIndexer(`chunk timeout after ${err.timeoutMs}ms`);
			}
			enrichInFlight = false;
			if (enrichTimer) clearTimeout(enrichTimer);
			enrichTimer = setTimeout(() => {
				enrichTimer = null;
				void pumpEnrichment();
			}, ENRICH_RETRY_DELAY_MS * job.retries);
			return;
		}
		console.warn(
			`[memories] enrichment failed for ${job.filename} after ${job.retries} attempts: ${err.message} (dropping for this session)`,
		);
		if (err.code === "INDEXER_TIMEOUT") {
			restartPrimaryIndexer(`final chunk timeout for ${job.filename}`);
		}
		// Timeout-poison parking (2026-09-28 orphan-loop fix): a film whose
		// chunk 0 never completes (e.g. 2 h HEVC whose full-rate detect alone
		// exceeds the chunk timeout) was dropped "for this session" but
		// backfillEnrichment re-queued it on EVERY launch — leaking a fresh
		// 500%-CPU ffmpeg each time while the tray claimed idle. When the job
		// made zero progress across all retries, park it like the empty-plan
		// path (empty segment list = covered, never retried until re-import).
		try {
			const noProgress = !job.off && !job.okTotal && !job.skipTotal;
			if (noProgress && job.filename) {
				const parkModelId = loadLibrary().modelId;
				const sc = loadSegments(parkModelId);
				if (sc && !sc.videos.has(job.filename)) {
					sc.videos.set(job.filename, []);
					sc.loaded = true;
					saveSegments();
					console.warn(
						`[memories] parked ${job.filename} after ${job.retries} timeouts with zero progress (will not retry until re-import)`,
					);
				}
			}
		} catch {
			/* parking is best-effort — the drop below still applies */
		}
		clearEnrichProgressFor(job.filename);
	} finally {
		enrichInFlight = false;
	}
	const finished = enrichQueue.shift();
	// The finished video's last tick must not leak into the next job's
	// snapshot (stale 16/1024 after a drop) — enrichSnapshot also guards by
	// filename, this clears the stored tick itself.
	if (finished) clearEnrichProgressFor(finished.filename);
	// Tray: this video finished (or failed) — the next job's progress takes
	// over, or the queue drained into "idle".
	broadcastEnrichEvent({
		phase: enrichQueue.length === 0 ? "idle" : "done",
		filename: job.filename,
		pending: enrichQueue.length,
	});
	if (enrichQueue.length === 0 && enrichNotifyCount > 0) {
		const n = enrichNotifyCount;
		enrichNotifyCount = 0;
		maybeNotify(
			"Scene analysis complete",
			`${n} video${n === 1 ? "" : "s"} analyzed — scene search is up to date.`,
		);
	}
	scheduleEnrichment();
}

async function generatePoster(videoPath) {
	const videoUtils = require("./indexer/video-utils.js");
	const ffmpeg = videoUtils.resolveFfmpeg();
	fs.mkdirSync(POSTERS_DIR, { recursive: true });
	const poster = posterFor(path.basename(videoPath));
	await videoUtils.extractPoster(ffmpeg, videoPath, poster, 480);
	return poster;
}

// ---------------------------------------------------------------------------
// In-app preview proxies for searchable-only videos (mkv/hevc/...).
//
// Chromium cannot demux MKV (and Electron 43 cannot reliably decode HEVC
// 10-bit), so the lightbox shows a poster + "Playback not supported" notice
// for those files. A preview is a short mp4/h264 clip transcoded on demand
// around the matched scene timestamp — playable in Chromium, seekable,
// cheap (30 s at 720p, cached on disk under a deterministic name so repeat
// views never re-transcode).
//
// The transcode runs in the MAIN process through the tracked video-utils
// spawner (same orphan-proof registry as the workers — nunca raw spawn, so
// the ffmpeg-CPU fix covers previews too) with its own timeout. Failures
// resolve to an error (the lightbox falls back to the poster); they never
// throw into the protocol handler.
// ---------------------------------------------------------------------------

function previewFileFor(filename, t) {
	const stem = path.basename(filename, path.extname(filename));
	const at = Math.max(0, Math.round(Number(t) || 0));
	return `${stem}-t${at}-30s.mp4`;
}

// Best-effort LRU prune: drop previews older than a week, then oldest-first
// past the size cap. Never throws; a full disk must not break playback of
// the originals.
function prunePreviews() {
	try {
		if (!fs.existsSync(PREVIEWS_DIR)) return;
		const now = Date.now();
		const entries = [];
		for (const name of fs.readdirSync(PREVIEWS_DIR)) {
			if (!name.endsWith(".mp4")) continue;
			const full = path.join(PREVIEWS_DIR, name);
			try {
				const st = fs.statSync(full);
				if (now - st.mtimeMs > PREVIEW_MAX_AGE_MS) {
					try {
						fs.unlinkSync(full);
					} catch {
						/* best-effort */
					}
					continue;
				}
				entries.push({ full, size: st.size, mtimeMs: st.mtimeMs });
			} catch {
				/* vanished mid-prune */
			}
		}
		let total = entries.reduce((a, e) => a + e.size, 0);
		if (total <= PREVIEW_MAX_BYTES) return;
		entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const e of entries) {
			if (total <= PREVIEW_MAX_BYTES) break;
			try {
				fs.unlinkSync(e.full);
				total -= e.size;
			} catch {
				/* best-effort */
			}
		}
	} catch {
		/* pruning must never break playback */
	}
}

function ensurePreview(filename, t) {
	const previewName = previewFileFor(filename, t);
	const cached = previewPending.get(previewName);
	if (cached) return cached;
	const job = (async () => {
		const videoUtils = require("./indexer/video-utils.js");
		if (!libraryHasRow(filename)) {
			return { ok: false, error: "unknown file" };
		}
		const src = path.join(PHOTOS_DIR, path.basename(filename));
		if (!fs.existsSync(src)) {
			return { ok: false, error: "file missing" };
		}
		fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
		const dest = path.join(PREVIEWS_DIR, previewName);
		try {
			const st = fs.statSync(dest);
			if (st.size > 0) {
				prunePreviews();
				return { ok: true, path: dest };
			}
		} catch {
			/* not cached — transcode below */
		}
		let ffmpeg;
		try {
			ffmpeg = videoUtils.resolveFfmpeg();
		} catch (err) {
			return { ok: false, error: err.message };
		}
		const start = Math.max(0, (Number(t) || 0) - PREVIEW_LEAD_SECONDS);
		const args = [
			"-y",
			"-ss",
			String(start),
			"-i",
			src,
			"-t",
			String(PREVIEW_SECONDS),
			"-vf",
			"scale=-2:720",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"23",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			dest,
		];
		try {
			await new Promise((resolve, reject) => {
				const child = videoUtils.spawnFfmpeg(ffmpeg, args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* best-effort */
					}
					reject(
						new Error(`preview transcode timed out: ${stderr.slice(-300)}`),
					);
				}, PREVIEW_TIMEOUT_MS);
				child.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else
						reject(
							new Error(
								`preview transcode exited ${code}: ${stderr.slice(-300)}`,
							),
						);
				});
			});
		} catch (err) {
			try {
				fs.unlinkSync(dest);
			} catch {
				/* partial output must not poison the cache */
			}
			console.warn(
				`[memories] preview failed for ${filename} at ${start}s: ${err.message}`,
			);
			return { ok: false, error: err.message };
		}
		try {
			const st = fs.statSync(dest);
			if (!st.size) {
				try {
					fs.unlinkSync(dest);
				} catch {
					/* best-effort */
				}
				return { ok: false, error: "empty preview" };
			}
		} catch {
			return { ok: false, error: "preview missing" };
		}
		prunePreviews();
		console.log(
			`[memories] preview ready for ${filename} at ${start}s (${previewName})`,
		);
		return { ok: true, path: dest };
	})();
	previewPending.set(previewName, job);
	job.finally(() => {
		previewPending.delete(previewName);
	});
	return job;
}

// ---------------------------------------------------------------------------
// Speech transcription queue (transcript sidecar for scene search).
//
// New videos are transcribed in the BACKGROUND after visual enrichment —
// never on the import critical path, never in parallel with it on 8 GB M1
// (enrich first for posters/grid, transcribe second). Dispatch is paced and
// gated like enrichment + OCR: nothing runs while an import/migration is in
// flight or a query IPC is pending. Each job uses a DEDICATED
// transcribe-worker utilityProcess (whisper.cpp, CPU-heavy, unrelated to
// onnxruntime), then embeds chunk texts through the PRIMARY indexer worker
// (same text tower + centering as queries). Results land in the per-model
// transcript sidecar; empty chunk lists are valid (silent film) and never
// retried. Transcription failure never touches imports or search.
// ---------------------------------------------------------------------------

const TRANSCRIBE_GAP_MS = 250;
const TRANSCRIBE_RETRY_DELAY_MS = 2000;

let transcribeQueue = []; // [{ filename, path, off, retries, lastError, hadProgress }]
let transcribeInFlight = false;
let transcribePendingQuery = false;
let transcribeTimer = null;
let lastTranscribeStart = 0;
let lastTranscribeProgress = null;
let lastTranscribeHeartbeatAt = 0;
let lastTranscribeModel = null;
let transcribeWorker = null;
let transcribeWorkerDead = false;
let transcribePending = new Map();
let transcribeRequestId = 0;

function broadcastTranscribeEvent(extra) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "transcribe", ...extra });
	}
	updateTrayState();
}

function transcribeSnapshot() {
	const job = transcribeInFlight ? transcribeQueue[0] : null;
	const raw = lastTranscribeProgress;
	const prog = job && raw && raw.filename === job.filename ? raw : null;
	return {
		type: "transcribe",
		paused: backgroundPaused,
		phase: job ? "transcribe" : transcribeQueue.length > 0 ? "queued" : "idle",
		filename: job ? job.filename : null,
		done: job && prog ? (prog.done ?? 0) : 0,
		total: job && prog ? (prog.total ?? 0) : 0,
		pending: transcribeQueue.length - (job ? 1 : 0),
		active: Boolean(job),
	};
}

function clearTranscribeProgressFor(filename) {
	if (lastTranscribeProgress && lastTranscribeProgress.filename === filename) {
		lastTranscribeProgress = null;
		lastTranscribeHeartbeatAt = 0;
	}
}

function backfillTranscription() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	let videos;
	let progress = {};
	try {
		const c = loadTranscripts(l.modelId);
		videos = c.videos;
		progress = c.progress || {};
	} catch {
		videos = null;
	}
	// Prune progress for rows no longer in the library (deleted videos).
	let pruned = false;
	for (const name of Object.keys(progress)) {
		if (!l.filenames.includes(name)) {
			delete progress[name];
			pruned = true;
		}
	}
	// Missing entries start at 0; entries with partial progress (crash or
	// drop mid-film) resume where they stalled. Complete entries skip.
	const videosOnly = l.filenames.filter((name) => isVideo(name));
	const jobs = transcribeBackfillList(videosOnly, videos, progress).map(
		(j) => ({
			filename: j.filename,
			path: path.join(PHOTOS_DIR, j.filename),
			off: j.off,
		}),
	);
	if (pruned) saveTranscripts();
	if (jobs.length > 0) {
		const resumed = jobs.filter((j) => j.off > 0).length;
		console.log(
			`[memories] backfill: ${jobs.length} video(s) missing transcript data` +
				(resumed > 0 ? ` (${resumed} resuming mid-film)` : ""),
		);
		enqueueTranscription(jobs);
	}
}

function enqueueTranscription(files) {
	if (!Array.isArray(files)) return;
	let added = 0;
	for (const f of files) {
		if (
			f &&
			f.filename &&
			f.path &&
			!transcribeQueue.some((q) => q.filename === f.filename)
		) {
			// off carries resume offsets (crash mid-film); fresh jobs start 0.
			const off = Number.isInteger(f.off) && f.off > 0 ? f.off : 0;
			transcribeQueue.push({ filename: f.filename, path: f.path, off });
			added++;
		}
	}
	if (added > 0) {
		broadcastTranscribeEvent({
			phase: "queued",
			pending: transcribeQueue.length,
		});
	}
	scheduleTranscription();
}

function scheduleTranscription() {
	if (transcribeTimer) return;
	transcribeTimer = setTimeout(() => {
		transcribeTimer = null;
		void pumpTranscription();
	}, TRANSCRIBE_GAP_MS);
}

function transcribeAllowed() {
	return (
		!backgroundPaused &&
		!transcribeInFlight &&
		!importInFlight &&
		!migrationState &&
		!transcribePendingQuery &&
		!enrichPendingQuery &&
		!ocrPendingQuery &&
		// Serialize with visual enrichment on 8 GB M1: posters/grid first.
		!enrichInFlight &&
		enrichQueue.length === 0 &&
		transcribeQueue.length > 0 &&
		Date.now() - lastTranscribeStart >= TRANSCRIBE_GAP_MS
	);
}

function ensureTranscribeWorker() {
	if (transcribeWorker && !transcribeWorkerDead) return transcribeWorker;
	transcribeWorkerDead = false;
	const worker = { process: null, dead: false };
	worker.process = utilityProcess.fork(
		path.join(__dirname, "indexer", "transcribe-worker.js"),
		[],
		{
			// Shared model cache + ffmpeg resolution, exactly like the
			// indexer pool (whisper weights land beside the CLIP weights in
			// ~/Library/Application Support/scm/models, never in the asar).
			env: indexerEnv(),
			serviceName: "transcribe-worker",
		},
	);
	worker.process.on("message", (event) => {
		const msg = event && event.data !== undefined ? event.data : event;
		if (!msg) return;
		if (msg.type === "ffmpeg-spawn") {
			trackFfmpegSpawn(transcribeFfmpegPids, msg.pid, msg.label);
			return;
		}
		if (msg.type === "ffmpeg-exit") {
			untrackFfmpegExit(transcribeFfmpegPids, msg.pid);
			return;
		}
		if (msg.type === "ffmpeg-killed") return;
		if (msg.type === "transcribe-progress") {
			lastTranscribeProgress = msg;
			lastTranscribeHeartbeatAt = Date.now();
			if (typeof msg.model === "string" && msg.model)
				lastTranscribeModel = msg.model;
			// Mark load-vs-decode attribution for the active job: a
			// transcribe-phase tick proves decode started; model-phase ticks
			// (or silence) mean a later exit was a load-phase crash.
			if (
				msg.phase === "transcribe" &&
				transcribeQueue.length > 0 &&
				msg.filename === transcribeQueue[0].filename
			) {
				transcribeQueue[0].hadProgress = true;
			}
			return;
		}
		if (!msg.id) return;
		const req = transcribePending.get(msg.id);
		if (!req) return;
		transcribePending.delete(msg.id);
		clearTimeout(req.timer);
		if (msg.ok) req.resolve(msg);
		else req.reject(new Error(msg.error || "Transcribe failed"));
	});
	worker.process.on("exit", (code, signal) => {
		worker.dead = true;
		transcribeWorkerDead = true;
		transcribeWorker = null;
		// Diagnose, don't mask: the old handler discarded code/signal, so
		// every OOM kill and every clean crash read identically as
		// "Transcribe worker exited". The exit label (with a SIGKILL→OOM
		// hint) rides both the log line and the rejection, so the pump's
		// retry/drop lines can attribute load-vs-decode.
		const label = transcribeExitLabel(code, signal);
		const active = transcribeQueue.length > 0 ? transcribeQueue[0] : null;
		const hbAge =
			lastTranscribeHeartbeatAt > 0
				? Date.now() - lastTranscribeHeartbeatAt
				: null;
		console.warn(
			`[memories] transcribe worker ${label}` +
				(active
					? ` (job ${active.filename} off ${active.off || 0})`
					: " (idle)") +
				(lastTranscribeModel ? ` model ${lastTranscribeModel}` : "") +
				(hbAge !== null
					? `, last heartbeat ${Math.round(hbAge / 1000)}s ago`
					: ", no heartbeat yet"),
		);
		for (const [, req] of transcribePending) {
			clearTimeout(req.timer);
			const err = new Error(`Transcribe worker ${label}`);
			err.code = "TRANSCRIBE_EXIT";
			err.exitCode = code;
			err.signal = signal;
			req.reject(err);
		}
		transcribePending = new Map();
	});
	transcribeWorker = worker;
	return worker;
}

function askTranscribe(message, timeoutMs = TRANSCRIBE_CHUNK_TIMEOUT_MS) {
	const worker = ensureTranscribeWorker();
	return new Promise((resolve, reject) => {
		const id = `t${++transcribeRequestId}`;
		const timer = setTimeout(() => {
			transcribePending.delete(id);
			const err = new Error("Transcribe request timed out");
			err.code = "TRANSCRIBE_TIMEOUT";
			err.timeoutMs = timeoutMs;
			reject(err);
		}, timeoutMs);
		transcribePending.set(id, { resolve, reject, timer });
		worker.process.postMessage({ ...message, id });
	});
}

async function pumpTranscription() {
	if (!transcribeAllowed()) {
		if (transcribeQueue.length > 0 && !backgroundPaused)
			scheduleTranscription();
		return;
	}
	const job = transcribeQueue[0];
	// Row deleted while queued — drop without work, retry, or tray noise.
	if (job && !libraryHasRow(job.filename)) {
		console.log(
			`[memories] transcribed ${job.filename}: row deleted while queued — dropping job`,
		);
		transcribeQueue.shift();
		clearTranscribeProgressFor(job.filename);
		broadcastTranscribeEvent({
			phase: transcribeQueue.length === 0 ? "idle" : "done",
			filename: job.filename,
			pending: transcribeQueue.length,
		});
		scheduleTranscription();
		return;
	}
	if (typeof job.retries !== "number") job.retries = 0;
	job.purgeEpoch = purgeEpoch;
	transcribeInFlight = true;
	lastTranscribeStart = Date.now();
	lastTranscribeHeartbeatAt = Date.now();
	// Announce the active job immediately so the tray pill appears even
	// before the worker's first per-slice progress tick (model load can take
	// a while on first run).
	broadcastTranscribeEvent({
		phase: "transcribe",
		filename: job.filename,
		done: 0,
		total: 0,
		pending: transcribeQueue.length - 1,
		active: true,
	});
	try {
		const modelId = loadLibrary().modelId;
		const whisperModel = readWhisperModel();
		const timeouts = transcribeTimeoutsFor(whisperModel);
		const reply = await askTranscribe(
			{
				type: "transcribe-video",
				path: job.path,
				filename: job.filename,
				fromIndex: job.off || 0,
				modelId: whisperModel,
			},
			timeouts.chunkTimeoutMs,
		);
		const replyModel = parseWhisperModel(reply.model || whisperModel);
		// Cancelled (deleted/purged) outranks stale-model: re-running a
		// dead job under the new model would burn a chunk on a file that
		// is gone. isJobDead runs FIRST because it consumes the tombstone
		// — short-circuiting on a row/epoch hit first would leak the entry
		// (a later re-import of the same filename would then discard one
		// live chunk).
		if (
			isJobDead(job.filename) ||
			!libraryHasRow(job.filename) ||
			job.purgeEpoch !== purgeEpoch
		) {
			console.log(
				`[memories] transcribed ${job.filename}: row deleted or purged mid-flight (stale-model reply) — discarding chunk`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		if (replyModel !== whisperModel) {
			// Settings switched mid-flight: drop this stale-model reply
			// (no commit, no progress write) and re-run the same offset
			// under the new model. The early return keeps job[0] queued.
			console.log(
				`[memories] speech model changed mid-flight (${whisperModel} → ${replyModel}) — re-running ${job.filename} from offset ${job.off || 0}`,
			);
			scheduleTranscription();
			return;
		}
		const c = loadTranscripts(modelId);
		// Row deleted — or purged — while this chunk ran: committing would
		// resurrect sidecar entries or land partial fragments the backfill
		// skips as "covered". Discard the reply and drop the job (finally
		// still clears the in-flight flag).
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!libraryHasRow(job.filename) ||
			job.purgeEpoch !== purgeEpoch
		) {
			console.log(
				`[memories] transcribed ${job.filename}: row deleted or purged mid-flight — discarding chunk`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		if (c.dim === 0) {
			c.dim = loadLibrary().dim || 0;
		}
		// Stamp the engine that produced these rows (a Settings switch
		// invalidates; pre-stamp sidecars read back as tiny.en).
		c.whisperModel = replyModel;
		if (reply.ok && reply.chunks && reply.chunks.length > 0) {
			// Embed chunk texts through the primary indexer (same text tower
			// + centering as queries) before committing rows.
			let vecs = [];
			try {
				spawnIndexer();
				await indexerReady;
				const emb = await askPrimaryIndexer(
					{ type: "embed-texts", texts: reply.chunks.map((ch) => ch.text) },
					180000,
				);
				vecs = emb.vecs || [];
			} catch (embErr) {
				console.warn(
					`[memories] transcript embed failed for ${job.filename}: ${embErr.message} — retrying`,
				);
				throw embErr;
			}
			// Accumulate utterance-level full-text rows (exact-search index)
			// alongside the embedded chunks — same accumulation contract,
			// validated lines only, persisted by saveTranscripts.
			if (Array.isArray(reply.utterances) && reply.utterances.length > 0) {
				if (!(c.utterances instanceof Map)) c.utterances = new Map();
				const prev = c.utterances.get(job.filename) || [];
				const seen = new Set(
					prev.map((u) => `${u.t0.toFixed(2)}:${u.t1.toFixed(2)}:${u.text}`),
				);
				for (const u of reply.utterances) {
					if (
						!u ||
						!Number.isFinite(u.t0) ||
						!Number.isFinite(u.t1) ||
						u.t1 <= u.t0
					)
						continue;
					if (typeof u.text !== "string" || u.text.trim().length === 0)
						continue;
					const line = { t0: u.t0, t1: u.t1, text: String(u.text) };
					const key = `${line.t0.toFixed(2)}:${line.t1.toFixed(2)}:${line.text}`;
					if (seen.has(key)) continue;
					seen.add(key);
					prev.push(line);
				}
				prev.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
				c.utterances.set(job.filename, prev);
			}
			const { okChunks, okVecs, skipped } = partitionTranscriptReply(
				reply.chunks,
				vecs,
			);
			if (c.dim === 0 && okVecs.length > 0) {
				c.dim = okVecs[0].length || loadLibrary().dim || 0;
			}
			if (okVecs.length > 0) {
				// Production commit path, extracted pure as
				// applyTranscriptReply (unit-tested in
				// test/transcript-fusion.test.js): accumulate + stamp
				// offsets at rows.length BEFORE pushing.
				const applied = applyTranscriptReply(
					c.videos,
					c.rows,
					job.filename,
					okChunks,
					okVecs,
					TRANSCRIPT_ROW_PER,
				);
				c.videos = applied.videos;
				c.rows = applied.rows;
				c.loaded = true;
				saveTranscripts();
				job.retries = 0;
				console.log(
					`[memories] transcribed ${job.filename}: ${reply.fromIndex}/${reply.total} chunks` +
						(skipped > 0 ? ` (${skipped} skipped)` : ""),
				);
			} else if (skipped > 0) {
				job.retries = 0;
				console.warn(
					`[memories] transcribed ${job.filename}: ${reply.fromIndex}/${reply.total} chunks (all ${skipped} skipped in this chunk, continuing)`,
				);
			}
		} else if (
			reply.ok &&
			(reply.total === 0 || (reply.chunks || []).length === 0)
		) {
			// Silent / no-audio / no-engine: valid empty entry, never retried.
			c.videos.set(job.filename, []);
			if (c.utterances instanceof Map) c.utterances.delete(job.filename);
			if (c.progress && typeof c.progress === "object")
				delete c.progress[job.filename];
			c.loaded = true;
			saveTranscripts();
			console.log(
				`[memories] transcribed ${job.filename}: 0 chunks (silent or no engine)`,
			);
		} else {
			console.warn(
				`[memories] transcription returned no chunks for ${job.filename}: ${reply.error || "unknown"}`,
			);
		}
		if (reply.ok && !reply.done) {
			job.off = reply.fromIndex || 0;
			// Persist the resume point: a crash/exit mid-film re-queues
			// from here instead of abandoning the partial sidecar forever.
			if (!c.progress || typeof c.progress !== "object") c.progress = {};
			c.progress[job.filename] = {
				done: reply.fromIndex || 0,
				total: reply.total || 0,
			};
			saveTranscripts();
			scheduleTranscription();
			return;
		}
		if (reply.ok && reply.done) {
			// Film complete: clear any resume point (silent films cleared it
			// above; transcribed films clear it here).
			if (c.progress && typeof c.progress === "object")
				delete c.progress[job.filename];
			saveTranscripts();
		}
	} catch (err) {
		// Row deleted — or purged — mid-chunk: the missing file (or the
		// purge) explains the failure — retrying would burn the whole
		// budget on it. Drop instead.
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!libraryHasRow(job.filename) ||
			job.purgeEpoch !== purgeEpoch
		) {
			console.log(
				`[memories] transcription chunk for ${job.filename} failed after the row was deleted or purged — dropping job`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		job.retries = (job.retries || 0) + 1;
		job.lastError = err.message;
		// Attribute the failure: model (last tick's stamp, else current
		// setting), load-vs-decode phase (any transcribe-phase tick for this
		// job proves decode started), exit cause, and heartbeat silence.
		// The old line logged only err.message, so four identical
		// "Transcribe worker exited" retries were indistinguishable from
		// four different transient slices.
		const matchingProg =
			lastTranscribeProgress && lastTranscribeProgress.filename === job.filename
				? lastTranscribeProgress
				: null;
		const modelForLabel =
			(matchingProg && matchingProg.model) ||
			lastTranscribeModel ||
			readWhisperModel();
		const phaseForLabel = job.hadProgress
			? "transcribe"
			: matchingProg
				? matchingProg.phase || null
				: null;
		const loadPhase = isLoadPhaseCrash({
			hadProgress: job.hadProgress,
			phase: phaseForLabel,
		});
		const hbAge =
			lastTranscribeHeartbeatAt > 0
				? Date.now() - lastTranscribeHeartbeatAt
				: null;
		let sizeLabel = null;
		try {
			const st = fs.statSync(job.path);
			if (st && Number.isFinite(st.size))
				sizeLabel = `${(st.size / 1048576).toFixed(1)}MB`;
		} catch {
			sizeLabel = "size unknown";
		}
		const detail = transcribeFailureLabel({
			model: modelForLabel,
			phase: loadPhase ? "load" : "decode",
			code: err.exitCode,
			signal: err.signal,
			heartbeatAgeMs: hbAge,
		});
		// Load-phase crashes are systematic (same weights, same death): one
		// retry, not three full model reloads. Decode-phase keeps the budget.
		const maxForJob = loadPhase
			? TRANSCRIBE_LOAD_MAX_RETRIES
			: TRANSCRIBE_MAX_RETRIES;
		if (job.retries <= maxForJob) {
			console.warn(
				`[memories] transcription chunk ${job.off || 0} for ${job.filename} failed ` +
					`(attempt ${job.retries}/${maxForJob}${loadPhase ? ", load-phase" : ""}) [${detail}]` +
					(sizeLabel ? ` [${sizeLabel}]` : "") +
					`: ${err.message} — retrying`,
			);
			transcribeInFlight = false;
			if (transcribeTimer) clearTimeout(transcribeTimer);
			transcribeTimer = setTimeout(() => {
				transcribeTimer = null;
				void pumpTranscription();
			}, TRANSCRIBE_RETRY_DELAY_MS * job.retries);
			return;
		}
		console.warn(
			`[memories] transcription failed for ${job.filename} after ${job.retries} attempts [${detail}]` +
				(sizeLabel ? ` [${sizeLabel}]` : "") +
				`: ${err.message} (dropping for this session; backfill retries next launch)`,
		);
		clearTranscribeProgressFor(job.filename);
	} finally {
		transcribeInFlight = false;
	}
	const finished = transcribeQueue.shift();
	if (finished) clearTranscribeProgressFor(finished.filename);
	broadcastTranscribeEvent({
		phase: transcribeQueue.length === 0 ? "idle" : "done",
		filename: job.filename,
		pending: transcribeQueue.length,
	});
	scheduleTranscription();
}

// ---------------------------------------------------------------------------
// OCR text extraction queue.
//
// New photos (and launch-backfill photos that predate OCR) are recognized in
// the BACKGROUND after their import batch ends — never on the import critical
// path. Dispatch is paced and gated exactly like scene enrichment: nothing
// runs while an import or migration is in flight or a query IPC is pending,
// so search and import latency are unaffected. Each job forks (or reuses) a
// DEDICATED ocr-worker utilityProcess — tesseract is CPU-heavy and unrelated
// to the CLIP model, so it must never share the indexer worker's serialized
// inference queue. Results land in library.ocr[i] (parallel to filenames;
// "" = OCR'd but no text found, null = not yet OCR'd) and persist with the
// index on the next save.
// ---------------------------------------------------------------------------

const OCR_GAP_MS = 250;
// Persist OCR results every N photos so a crash doesn't lose hours of
// progress.  saveLibrary writes ~18MB of bin files in <20ms on SSD,
// so every 50 photos adds negligible overhead (~60 saves for 3000).
const OCR_CHECKPOINT_INTERVAL = 50;
let ocrQueue = []; // filenames (photos only — videos are scene-searchable)

let ocrInFlight = false;
// Purge generation captured for the in-flight photo — mirrors
// job.purgeEpoch on the enrich/transcribe pumps (OCR jobs are bare
// strings, so the epoch rides alongside the flag instead of the job).
let ocrInFlightEpoch = 0;
let ocrPendingQuery = false;
let ocrTimer = null;
let lastOcrStart = 0;
let ocrSinceCheckpoint = 0;
// One OCR worker at a time (tesseract holds a ~100MB traineddata + wasm
// core; a pool would multiply memory for zero throughput gain — a single
// worker saturates the CPU it runs on). Forked lazily on the first job of a
// drain, killed when the queue empties.
let ocrWorker = null;
let ocrWorkerDead = false;
let ocrRequestId = 0;
let ocrPending = new Map(); // id → { resolve, reject, timer }
// Bumped by every deliberate worker kill (purge, language-change requeue,
// drain). The in-flight photo captures it at arm time; a reject that lands
// after a generation change is a kill, not a recognition failure, so the
// catch skips the drain-summary failure count (the re-queued attempt, if
// any, produces the real verdict).
let ocrWorkerGeneration = 0;

// OCR progress bookkeeping for the renderer tray (mirrors enrichSnapshot).
let ocrDoneCount = 0;
let ocrTotalCount = 0;
// Failed recognitions in the current drain (worker crash, timeout, model
// download failure). Failed rows keep their prior text and are reported in
// the drain summary — and they block the upgrade marker so the next launch
// retries them instead of stamping them as migrated.
let ocrFailedCount = 0;
let ocrFailedFiles = [];
let lastOcrFile = null;

function ocrDataDir() {
	return path.join(app.getPath("userData"), "ocr-data");
}

function broadcastOcrEvent(extra) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "ocr", ...extra });
	}
	// Menu-bar tray icon follows background work (no-op when the mode is off).
	updateTrayState();
}

function ocrSnapshot() {
	const job = ocrInFlight ? ocrQueue[0] : null;
	return {
		type: "ocr",
		paused: backgroundPaused,
		phase: job ? "ocr" : "queued",
		filename: job ? job : lastOcrFile,
		done: ocrDoneCount,
		total: ocrTotalCount,
		pending: ocrQueue.length - (job ? 1 : 0),
		active: Boolean(job),
	};
}

// Content hashes (rename-duplicate dedupe) are stored per row at import;
// libraries that predate the feature have none, so a rename wouldn't be
// recognized as a duplicate. Hash every library file once in the background
// (rows keep their hash across launches, so a big library resumes where it
// stopped). Pure file I/O — no model, no indexer needed.
async function backfillHashes() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	if (!l.hashes) l.hashes = [];
	let changed = false;
	for (let i = 0; i < l.filenames.length; i++) {
		if (l.hashes[i]) continue;
		const p = path.join(PHOTOS_DIR, l.filenames[i]);
		if (!fs.existsSync(p)) {
			l.hashes[i] = null;
			continue;
		}
		try {
			l.hashes[i] = await hashFile(p);
			changed = true;
		} catch {
			l.hashes[i] = null;
		}
	}
	if (changed) {
		await saveLibrary();
		console.log(`[memories] hash backfill: ${l.filenames.length} rows hashed`);
	}
}

// Screenshot-hint backfill: rows that predate the metadata probe (or whose
// probe slot is still null) get one bounded read of their app-managed copy —
// byte-identical to the original at import time, so no source lookup is
// needed and the hint works even after the original was moved or deleted.
// Rows keep their hint across launches, so a big library resumes where it
// stopped. Pure file I/O — no model, no indexer needed.
async function backfillScreenshotHints() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	if (!l.screenshotHints) l.screenshotHints = [];
	let changed = false;
	let probed = 0;
	for (let i = 0; i < l.filenames.length; i++) {
		if (l.screenshotHints[i] === true || l.screenshotHints[i] === false)
			continue;
		if (isVideo(l.filenames[i])) {
			l.screenshotHints[i] = false;
			changed = true;
			continue;
		}
		try {
			l.screenshotHints[i] = await probeScreenshotMetadata(
				path.join(PHOTOS_DIR, l.filenames[i]),
			);
			probed++;
			changed = true;
		} catch {
			// Leave null — retried on the next launch (bounded: pruneStale
			// removes rows whose copy is gone, so nulls drain to zero).
		}
	}
	if (l.screenshotHints.length > l.filenames.length) {
		l.screenshotHints.length = l.filenames.length;
		changed = true;
	}
	if (changed) {
		await saveLibrary();
		console.log(`[memories] screenshot-hint backfill: probed ${probed} row(s)`);
	}
}

// Photos that never got an OCR pass (pre-OCR imports, or rows whose slot is
// still null after a failed pass) are enqueued on launch, one at a time,
// under the same idle gates as import-time OCR. Videos are skipped — their
// content is scene-searchable; OCR targets the text-heavy stills. A language
// stamp mismatch (library OCR'd under different langs than settings) also
// re-queues EVERY photo: old rows are stale, not just missing.
function backfillOcr() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	let currentLangs = null;
	try {
		currentLangs = resolveOcrLangString();
	} catch {
		/* backfill covers missing rows even without a stamp */
	}
	// One-time upgrade migration: rows that predate the CJK rollout were all
	// recognized eng-only (no shipped version ever produced CJK rows), so the
	// first launch that sees photo rows without the migration marker
	// force-re-queues the whole library once under the current language set.
	// The stamp alone can't prove freshness (pre-migration builds stamped
	// without re-queuing), so only the marker gates this — and only a
	// zero-failure drain sets it (see pumpOcr).
	let ocrMigrated = false;
	try {
		ocrMigrated = readOcrLangsMigrated();
	} catch {
		/* missing settings → not migrated */
	}
	let ocrPhotoCount = 0;
	for (const name of l.filenames) {
		if (!isVideo(name)) ocrPhotoCount++;
	}
	if (
		currentLangs &&
		shouldMigrateOcrLangs({ photoCount: ocrPhotoCount, migrated: ocrMigrated })
	) {
		console.log(
			`[memories] OCR upgrade migration: re-queuing ${ocrPhotoCount} photo(s) under ${currentLangs} (pre-multilang rows were eng-only)`,
		);
		l.ocrLangs = currentLangs;
		void saveLibrary();
		requeueAllPhotosForOcr("upgrade");
		return;
	}
	// Language change across launches: stamp the new set and re-OCR all.
	if (currentLangs && l.ocrLangs && l.ocrLangs !== currentLangs) {
		console.log(
			`[memories] OCR language change ${l.ocrLangs} → ${currentLangs}: re-queuing library`,
		);
		l.ocrLangs = currentLangs;
		void saveLibrary();
		requeueAllPhotosForOcr("language-change");
		return;
	}
	// First stamp: adopt the current setting without re-queuing (fresh or
	// pre-stamp libraries keep their eng-only rows until the user changes
	// languages — the set-langs IPC path handles the full re-OCR then).
	if (currentLangs && !l.ocrLangs && l.filenames.length > 0) {
		l.ocrLangs = currentLangs;
		void saveLibrary();
	}
	const missing = [];
	for (let i = 0; i < l.filenames.length; i++) {
		if (isVideo(l.filenames[i])) continue;
		const words = l.ocrWords ? l.ocrWords[i] : null;
		if (words === null) {
			// Never OCR'd with geometry (pre-geometry row, failed pass).
			missing.push(l.filenames[i]);
			continue;
		}
		// INCONSISTENT row: searchable text exists but no word geometry
		// stands behind it. This is the raw-fallback signature — an older
		// pass hit tesseract's no-blocks path, whose cleanText branch keeps
		// UNFILTERED text while normalizeWords returns []. Such rows rank
		// in the OCR tab but can never draw a highlight box. Re-OCR them;
		// genuinely-empty rows (no text AND no words) stay skipped, so a
		// text-free photo is never retried forever.
		if (
			words.length === 0 &&
			typeof l.ocr[i] === "string" &&
			l.ocr[i].length > 0
		) {
			missing.push(l.filenames[i]);
		}
	}
	if (missing.length > 0) {
		console.log(
			`[memories] OCR backfill: ${missing.length} photo(s) missing word geometry`,
		);
		enqueueOcr(missing);
	}
}

function enqueueOcr(files, options) {
	if (!Array.isArray(files)) return;
	const force = Boolean(options && options.force);
	const l = loadLibrary();
	let added = 0;
	for (const name of files) {
		const idx = l.filenames.indexOf(name);
		// Unknown row, already queued, or already OCR'd with geometry AND
		// consistent text (a repeat import must not revisit a healthy row;
		// text-but-no-geometry rows are re-enqueued deliberately by the
		// backfill's inconsistency pass). force:true (language change)
		// bypasses the healthy-row skip — old rows are stale by definition.
		if (idx === -1) continue;
		if (ocrQueue.includes(name)) continue;
		if (!force) {
			const words = l.ocrWords ? l.ocrWords[idx] : null;
			if (words !== null && words.length > 0) continue;
			if (
				words !== null &&
				words.length === 0 &&
				!(typeof l.ocr[idx] === "string" && l.ocr[idx].length > 0)
			) {
				// Empty geometry on a genuinely text-free row — nothing to fix.
				continue;
			}
		}
		ocrQueue.push(name);
		added++;
	}
	if (added > 0) {
		ocrTotalCount = ocrQueue.length;
		broadcastOcrEvent({ phase: "queued", pending: ocrQueue.length });
	}
	scheduleOcr();
	return added;
}

// Re-queue every photo for OCR (language change): old text stays visible
// until each row's re-OCR lands — rows are overwritten in place by pumpOcr,
// never cleared. Returns the queued count for the settings toast.
function requeueAllPhotosForOcr(reason) {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return 0;
	const photos = l.filenames.filter((name) => !isVideo(name));
	// A language change restarts the worker so the next job loads the new
	// traineddata set. The kill rejects the in-flight photo's pending
	// request; its catch sees the generation change and skips the failure
	// count, and the force re-queue below retries it under the new worker.
	killOcrWorker();
	const added = enqueueOcr(photos, { force: true }) || 0;
	if (added > 0) {
		console.log(
			`[memories] OCR re-queue (${reason || "manual"}): ${added} photo(s)`,
		);
	}
	return added;
}

function scheduleOcr() {
	if (ocrTimer) return;
	ocrTimer = setTimeout(() => {
		ocrTimer = null;
		void pumpOcr();
	}, OCR_GAP_MS);
}

function ocrAllowed() {
	return (
		!backgroundPaused &&
		!ocrInFlight &&
		!importInFlight &&
		!migrationState &&
		!ocrPendingQuery &&
		!enrichPendingQuery &&
		!transcribePendingQuery &&
		ocrQueue.length > 0 &&
		Date.now() - lastOcrStart >= OCR_GAP_MS
	);
}

// Fork the OCR worker if it isn't alive. Returns the worker object.
function ensureOcrWorker() {
	if (ocrWorker && !ocrWorkerDead) return ocrWorker;
	ocrWorkerDead = false;
	const worker = {
		process: null,
		dead: false,
	};
	// Language set comes from settings.json (eng always on + CJK toggles);
	// each *.traineddata downloads once into ocr-data/ and is reused offline.
	let ocrLangs = "eng+chi_sim+chi_tra+jpn+kor";
	try {
		ocrLangs = resolveOcrLangString();
	} catch {
		/* default above */
	}
	worker.process = utilityProcess.fork(
		path.join(__dirname, "indexer", "ocr-worker.js"),
		[],
		{
			env: {
				...process.env,
				// *.traineddata (~17MB for the full default set, downloaded
				// once from the tesseract CDN on the first OCR ever) lands
				// here and is reused offline.
				OCR_DATA_DIR: ocrDataDir(),
				OCR_LANGS: ocrLangs,
			},
			serviceName: "ocr-worker",
		},
	);
	worker.process.on("message", (event) => {
		const msg = event && event.data !== undefined ? event.data : event;
		if (!msg || !msg.id) return;
		const req = ocrPending.get(msg.id);
		if (!req) return;
		ocrPending.delete(msg.id);
		clearTimeout(req.timer);
		if (msg.ok) req.resolve(msg);
		else req.reject(new Error(msg.error || "OCR failed"));
	});
	worker.process.on("exit", () => {
		worker.dead = true;
		ocrWorkerDead = true;
		ocrWorker = null;
		for (const [, req] of ocrPending) {
			clearTimeout(req.timer);
			req.reject(new Error("OCR worker exited"));
		}
		ocrPending = new Map();
	});
	ocrWorker = worker;
	return worker;
}

function askOcr(filename) {
	const worker = ensureOcrWorker();
	return new Promise((resolve, reject) => {
		const id = `o${++ocrRequestId}`;
		const timer = setTimeout(() => {
			ocrPending.delete(id);
			reject(new Error("OCR request timed out"));
		}, 120000);
		ocrPending.set(id, { resolve, reject, timer });
		worker.process.postMessage({
			type: "ocr-photo",
			id,
			path: path.join(PHOTOS_DIR, filename),
		});
	});
}

async function pumpOcr() {
	if (!ocrAllowed()) {
		if (ocrQueue.length > 0 && !backgroundPaused) scheduleOcr();
		return;
	}
	const filename = ocrQueue[0];
	// Row deleted while queued — drop without a tesseract run or a failed
	// entry in the drain summary.
	if (!libraryHasRow(filename)) {
		console.log(
			`[memories] OCR ${filename}: row deleted while queued — dropping job`,
		);
		ocrQueue.shift();
		broadcastOcrEvent({
			phase: ocrQueue.length === 0 ? "idle" : "ocr",
			filename: lastOcrFile,
			done: ocrDoneCount,
			total: ocrTotalCount,
			pending: ocrQueue.length,
			failed: ocrFailedCount,
		});
		scheduleOcr();
		return;
	}
	ocrInFlight = true;
	ocrInFlightEpoch = purgeEpoch;
	const ocrGen = ocrWorkerGeneration;
	lastOcrStart = Date.now();
	lastOcrFile = filename;
	try {
		const reply = await askOcr(filename);
		// Rows can shift while OCR runs (a delete, import, or purge can
		// land mid-photo); resolve by filename so the text lands on the
		// right entry — a vanished, purged, or tombstoned file is skipped.
		// The tombstone is consumed unconditionally (never inside the
		// commit condition) so a leaked entry can't discard a future
		// re-queued job for the same filename.
		const cancelled = isJobDead(filename);
		const l = loadLibrary();
		const idx = l.filenames.indexOf(filename);
		if (
			idx !== -1 &&
			reply.ok &&
			typeof reply.text === "string" &&
			ocrInFlightEpoch === purgeEpoch &&
			!cancelled
		) {
			if (!l.ocr) l.ocr = [];
			if (!l.ocrWords) l.ocrWords = [];
			l.ocr[idx] = reply.text;
			l.ocrWords[idx] = Array.isArray(reply.words) ? reply.words : [];
			l.ocrRevision = (l.ocrRevision || 0) + 1;
			// Adopt the language stamp on first OCR (fresh installs have no
			// stamp yet — backfillOcr stamps at launch, the set-langs IPC
			// stamps on change; this covers rows OCR'd before either ran).
			if (!l.ocrLangs) {
				try {
					l.ocrLangs = resolveOcrLangString();
				} catch {
					/* stamp optional — backfill covers it */
				}
			}
			ocrDoneCount++;
			console.log(
				`[memories] OCR ${filename}: ${reply.text.length > 0 ? JSON.stringify(reply.text.slice(0, 60)) + "…" : "(no text)"}`,
			);
			// Incremental checkpoint: persist every N photos so a crash
			// doesn't lose all OCR progress.
			if (++ocrSinceCheckpoint >= OCR_CHECKPOINT_INTERVAL) {
				ocrSinceCheckpoint = 0;
				await saveLibrary();
				// Progressive refresh: a full backfill (first launch on an
				// existing library, or a big import batch) can run for tens of
				// minutes, and this broadcast used to wait for the ENTIRE queue
				// to drain — the whole time, tiles showed no query highlights
				// and the OCR tab found nothing, so the feature read as broken.
				// Each checkpoint bumps ocrRevision, which is part of the
				// renderer's index fingerprint, so it reloads the refreshed
				// metadata without touching the unchanged embedding bins.
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", { type: "library-updated" });
				}
			}
		} else if (cancelled || ocrInFlightEpoch !== purgeEpoch) {
			// Purged or deleted mid-photo: the reply belongs to cancelled
			// work, not to a vanished row (that case stays silent as
			// before). The tail shift below drops the job either way.
			console.log(
				`[memories] OCR ${filename}: purged or deleted mid-flight — discarding reply`,
			);
		}
	} catch (err) {
		// A failed OCR leaves a never-OCR'd slot null so a later backfill
		// retries it; a previously-healthy row keeps its prior text. Either
		// way the failure counts toward the drain summary and blocks the
		// upgrade marker, so failed rows retry on the next launch instead of
		// being stamped as migrated. OCR failure never touches imports or
		// search. A job dropped by purge/delete/reset is none of that —
		// it is no longer queued, so skip it quietly instead of polluting
		// the drain summary with a file that is gone or was cancelled.
		if (!ocrQueue.includes(filename)) {
			console.log(
				`[memories] OCR ${filename}: job dropped while running — skipping`,
			);
		} else if (ocrGen !== ocrWorkerGeneration) {
			// Deliberate kill (language-change restart, drain kill) landed
			// mid-photo — not a recognition failure. The re-queued attempt
			// carries on, so don't pollute the drain summary.
			console.log(
				`[memories] OCR ${filename}: worker restarted mid-photo — skipping failure count`,
			);
		} else {
			ocrFailedCount++;
			if (ocrFailedFiles.length < 5) ocrFailedFiles.push(filename);
			console.warn(`[memories] OCR failed for ${filename}: ${err.message}`);
		}
	} finally {
		ocrInFlight = false;
	}
	ocrQueue.shift();
	// Tray: this photo finished — the next job's progress takes over, or the
	// queue drained into "idle".
	broadcastOcrEvent({
		phase: ocrQueue.length === 0 ? "idle" : "ocr",
		filename: lastOcrFile,
		done: ocrDoneCount,
		total: ocrTotalCount,
		pending: ocrQueue.length,
		failed: ocrFailedCount,
	});
	if (ocrQueue.length === 0) {
		// Queue drained: persist the OCR text (saveLibrary writes the whole
		// index trio, so the renderer's next /memories-index.json fetch sees
		// it), free the tesseract process, and tell the renderer to reload.
		await saveLibrary();
		killOcrWorker();
		if (ocrFailedCount > 0) {
			const names = ocrFailedFiles.join(", ");
			const more =
				ocrFailedCount > ocrFailedFiles.length
					? `, +${ocrFailedCount - ocrFailedFiles.length} more`
					: "";
			console.warn(
				`[memories] OCR drain finished: ${ocrDoneCount} recognized, ${ocrFailedCount} failed (${names}${more}) — failed rows keep prior text and retry on next launch (first CJK run downloads ~17MB of traineddata: check network if every row fails)`,
			);
		} else {
			console.log(
				`[memories] OCR drain finished: ${ocrDoneCount} recognized, 0 failed`,
			);
			// A zero-failure drain proves every row is current-language: record
			// the upgrade marker so later launches skip the migration. Failed
			// drains deliberately leave it unset (see readOcrLangsMigrated).
			try {
				if (!readOcrLangsMigrated()) writeSettings({ ocrLangsMigrated: true });
			} catch (err) {
				console.warn(
					`[memories] OCR migration marker write skipped: ${err.message}`,
				);
			}
		}
		ocrDoneCount = 0;
		ocrTotalCount = 0;
		ocrFailedCount = 0;
		ocrFailedFiles = [];
		ocrSinceCheckpoint = 0;
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		return;
	}
	scheduleOcr();
}

function killOcrWorker() {
	if (ocrWorker && !ocrWorker.dead) {
		try {
			ocrWorker.process.kill();
		} catch {
			/* already gone */
		}
	}
	ocrWorker = null;
	ocrWorkerDead = true;
	ocrWorkerGeneration++;
}

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

const thumbJobs = new Map(); // filename → Promise<path>
const thumbSlots = Array.from({ length: THUMB_CONCURRENCY }, () =>
	Promise.resolve(),
);
let thumbSlotIndex = 0;

async function ensureThumb(filename) {
	const out = thumbFor(filename);
	try {
		await fs.promises.access(out);
		return out;
	} catch {
		/* not generated yet */
	}
	const existing = thumbJobs.get(filename);
	if (existing) return existing;
	const slot = thumbSlotIndex++ % THUMB_CONCURRENCY;
	const job = thumbSlots[slot]
		.then(async () => {
			try {
				await fs.promises.access(out);
				return out;
			} catch {
				/* generate below */
			}
			fs.mkdirSync(THUMBS_DIR, { recursive: true });
			const sharp = (await import("sharp")).default;
			// First page only (animated GIFs collapse to their first frame),
			// EXIF-rotated, downscaled, quality-tuned JPEG.
			await sharp(path.join(PHOTOS_DIR, filename))
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

async function resolveRenderer(p) {
	if (p === "/" || p === "") p = "/index.html";
	const filePath = path.normalize(path.join(RENDERER_DIR, p));
	if (
		!filePath.startsWith(RENDERER_DIR + path.sep) &&
		filePath !== RENDERER_DIR
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
function openFileStreamRange(filePath, start, end) {
	return fs.promises.open(filePath, "r").then((handle) => {
		const nodeStream = fs.createReadStream(null, {
			fd: handle.fd,
			start,
			end,
			autoClose: false,
		});
		const release = () => handle.close().catch(() => {});
		nodeStream.on("error", release);
		nodeStream.on("end", release);
		nodeStream.on("close", release);
		return Readable.toWeb(nodeStream);
	});
}

async function handleAppRequest(request) {
	const urlPath = safeDecode(new URL(request.url).pathname);
	const headers = new Headers();
	const respond = (status, body, contentType, extra = {}) => {
		if (contentType) headers.set("Content-Type", contentType);
		for (const [k, v] of Object.entries(extra)) headers.set(k, v);
		return new Response(body, { status, headers });
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
			IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())
		) {
			try {
				const body = await fs.promises.readFile(await ensureThumb(filename));
				return respond(200, body, "image/jpeg", {
					"Cache-Control": "public, max-age=31536000, immutable",
				});
			} catch (err) {
				console.warn(
					`[memories] thumbnail failed for ${filename}: ${err.message}`,
				);
				/* fall through to the original-file route below */
			}
		}
	}

	// Posters (generated video thumbnails; never part of the index)
	if (urlPath.startsWith("/images/posters/")) {
		const filePath = posterFor(path.basename(urlPath)); // never allow traversal
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
		const result = await ensurePreview(filename, t);
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
		const filePath = path.join(PHOTOS_DIR, filename);
		// Content-Type from the BYTES, not the extension: mislabeled files
		// (WebP bytes under a .png name) must not route into the wrong
		// Chromium image decoder, and unrecognized bytes must not inherit
		// ANY image/* claim (see imageContentType — the Sep-2026 trap).
		const extMime = MIME_TYPES[path.extname(filename).toLowerCase()];
		const mime = isVideo(filename)
			? extMime || "application/octet-stream"
			: imageContentType({
					sniffed: sniffImageMime(filePath),
					extMime,
				});
		try {
			const stat = await fs.promises.stat(filePath);
			const range = request.headers.get("range");
			if (range && isVideo(filename)) {
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
			const extra = isVideo(filename)
				? { "Accept-Ranges": "bytes", "Cache-Control": "no-store" }
				: { "Cache-Control": "no-store" };
			// Videos stream from disk (they can be gigabytes); photos are
			// small enough to buffer.
			const body =
				isVideo(filename) && stat.size > 0
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
			await fs.promises.readFile(path.join(RENDERER_DIR, "index.html")),
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

function safeDecode(p) {
	try {
		return decodeURIComponent(p);
	} catch {
		return p;
	}
}

// ---------------------------------------------------------------------------
// Settings (persisted shortcut, etc.)
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readSettings live in main-lib/settings.js (required at top).

// C-01 Wave 2 (S1): writeSettings live in main-lib/settings.js (required at top).

// ---------------------------------------------------------------------------
// Video search quality (Settings → Video search): the scene-segment density
// preset for background enrichment. Stored in settings.json so the main
// process (which queues enrichment) and the renderer (which displays it)
// share one source of truth; the worker receives the resolved (target, min,
// max) triple per enrich-video message. Only affects enrichment planned
// AFTER the change — existing sidecars keep their old density until the
// user runs "Re-analyze videos".
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readVideoQuality live in main-lib/settings.js (required at top).

// C-01 Wave 2 (S1): videoBudgetForCurrentQuality live in main-lib/settings.js (required at top).

// ---------------------------------------------------------------------------
// Speech model (Settings → Video search → Speech model): the whisper engine
// for background transcription. Stored in settings.json (same validated-
// fallback pattern as video quality); the resolved id rides each
// transcribe-video message and the sidecar is stamped with it — a switch
// invalidates the sidecar (transcripts are model-quality-dependent) and
// re-queues every video. Default tiny.en = today's behavior.
// ---------------------------------------------------------------------------

// C-01 Wave 2 (S1): readWhisperModel live in main-lib/settings.js (required at top).

// One-time migration off the removed small.en rung (OOM on 8GB Macs):
// stored settings + sidecar stamps carrying "small.en" resolve to base.en
// via parseWhisperModel, but a small-stamped sidecar would then look like a
// valid base.en sidecar and never re-transcribe. So when the raw stored
// value (or the raw sidecar stamp) is still "small.en", rewrite settings to
// base.en and invalidate the speech sidecar once — the launch backfill
// re-queues every video under base.en. Idempotent: no-ops when nothing
// still names small.en. Also sweeps the orphaned ~1GB small.en weight cache.
function migrateRemovedWhisperModel() {
	let migratedSettings = false;
	try {
		const raw = readSettings().whisperModel;
		if (raw === "small.en") {
			writeSettings({ whisperModel: "base.en" });
			migratedSettings = true;
			console.log(
				"[memories] speech model small.en removed — settings migrated to base.en",
			);
		}
	} catch (err) {
		console.warn(
			`[memories] whisper migration settings check skipped: ${err.message}`,
		);
	}
	// Sidecar stamp check (raw JSON, before parseWhisperModel aliases it).
	try {
		const l = loadLibrary();
		const metaFile = transcriptsMetaFileFor(l.modelId);
		const rawStamp = JSON.parse(fs.readFileSync(metaFile, "utf8")).whisperModel;
		if (rawStamp === "small.en") {
			const c = loadTranscripts(l.modelId);
			c.videos = new Map();
			c.rows = [];
			c.utterances = new Map();
			c.progress = {};
			c.whisperModel = "base.en";
			c.loaded = true;
			saveTranscripts();
			console.log(
				"[memories] speech sidecar stamped small.en — invalidated for base.en re-transcription",
			);
		} else if (migratedSettings) {
			// Settings named small.en but the sidecar stamp does not (fresh
			// install mid-download, deleted sidecar): still force a clean
			// base.en stamp so the next commit is unambiguous.
			try {
				const c = loadTranscripts(l.modelId);
				if (c.loaded) {
					c.whisperModel = "base.en";
					saveTranscripts();
				}
			} catch {
				/* sidecar optional — backfill covers it */
			}
		}
	} catch {
		/* no sidecar yet — nothing to invalidate */
	}
	cleanupRemovedWhisperWeights();
}

// C-01 Wave 2 (S1): cleanupRemovedWhisperWeights live in main-lib/settings.js (required at top).

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------

function buildApplicationMenu() {
	const template = [
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

async function pickAndImport() {
	const win = BrowserWindow.getAllWindows()[0];
	const result = await dialog.showOpenDialog(win, {
		title: "Import Photos or Folder",
		buttonLabel: "Import",
		// openDirectory lets the user pick a whole folder (recursively imported
		// by importPaths); on macOS files and folders are both selectable in the
		// same native panel.
		properties: ["openFile", "openDirectory", "multiSelections"],
		filters: [
			{
				name: "Images & Videos",
				extensions: [
					"jpg",
					"jpeg",
					"png",
					"gif",
					"webp",
					"heic",
					"heif",
					"mp4",
					"mov",
					"m4v",
					"webm",
					"mkv",
					"avi",
					"ts",
					"m2ts",
					"mts",
					"mpg",
					"mpeg",
					"wmv",
					"flv",
					"3gp",
				],
			},
		],
	});
	if (result.canceled) return null;
	return importPaths(result.filePaths);
}

// Renderer sandbox: contextIsolation + sandbox isolate the renderer from
// Node/the main process so a renderer compromise can't reach the OS. The
// preload requires only "electron" (sandbox-compatible), so sandbox:true is
// a drop-in. Exposed as a const so tests can assert on it (M-01).
const WEB_PREFERENCES = {
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
	preload: path.join(__dirname, "preload.js"),
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

function createWindow({ showOnReady = true } = {}) {
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
		icon: APP_ICON || undefined,
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
	});
	// Model status can resolve before the renderer subscribes (cached model
	// download, or a fast load on a warm cache); replay the latest state so
	// the UI always knows whether the AI engine is up.
	win.webContents.on("did-finish-load", () => {
		if (modelStatus) {
			win.webContents.send("memories:status", modelStatus);
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
		if (!isQuitting && menuBarOnlyEnabled) {
			event.preventDefault();
			win.hide();
		}
	});
	return win;
}

// ---------------------------------------------------------------------------
// Search ranking — O(N × dim) cosine scan. Pure scoring lives in
// main-lib/rank-search.js (shared with the rank utilityProcess). The
// renderer's main thread is never blocked by search math: production IPC
// (`memories:rank`) scores in a dedicated utilityProcess; this in-process
// path remains for tests, internal callers, and worker-failure fallback.
// ---------------------------------------------------------------------------

// Rank utilityProcess — owns its own library-store copy (disk-backed,
// generation-synced). Forked on first production rank; CTO/tests keep the
// injected in-process rankSearch and never touch this.
let rankWorker = null;
let rankWorkerDead = false;
const rankPending = new Map();
let rankRequestId = 0;
const RANK_TIMEOUT_MS = 15000;

function ensureRankWorker() {
	if (rankWorker && !rankWorkerDead) return rankWorker;
	rankWorkerDead = false;
	const worker = { process: null, dead: false };
	worker.process = utilityProcess.fork(
		path.join(__dirname, "main-lib", "rank-worker.js"),
		[],
		{
			env: {
				...indexerEnv(),
				SCM_USER_DATA_DIR: app.getPath("userData"),
			},
			serviceName: "rank-worker",
		},
	);
	worker.process.on("message", (event) => {
		const msg = event && event.data !== undefined ? event.data : event;
		if (!msg) return;
		if (msg.type === "rank-ready") return;
		if (!msg.id) return;
		const req = rankPending.get(msg.id);
		if (!req) return;
		rankPending.delete(msg.id);
		clearTimeout(req.timer);
		if (msg.ok) req.resolve(msg.results);
		else req.reject(new Error(msg.error || "Rank failed"));
	});
	worker.process.on("exit", (code, signal) => {
		worker.dead = true;
		rankWorkerDead = true;
		rankWorker = null;
		const label =
			code !== null && code !== undefined
				? `exit ${code}`
				: signal
					? `signal ${signal}`
					: "exit";
		for (const [, req] of rankPending) {
			clearTimeout(req.timer);
			const err = new Error(`Rank worker ${label}`);
			err.code = "RANK_EXIT";
			req.reject(err);
		}
		rankPending.clear();
	});
	rankWorker = worker;
	return worker;
}

function askRankWorker(message) {
	const worker = ensureRankWorker();
	return new Promise((resolve, reject) => {
		const id = `k${++rankRequestId}`;
		const timer = setTimeout(() => {
			rankPending.delete(id);
			const err = new Error("Rank request timed out");
			err.code = "RANK_TIMEOUT";
			reject(err);
		}, RANK_TIMEOUT_MS);
		rankPending.set(id, { resolve, reject, timer });
		worker.process.postMessage({
			...message,
			id,
			gen: libraryGenerationNumber(),
		});
	});
}

function stopRankWorker() {
	if (rankWorker && rankWorker.process) {
		try {
			rankWorker.process.postMessage({ type: "shutdown" });
		} catch {
			/* already gone */
		}
		try {
			rankWorker.process.kill();
		} catch {
			/* already gone */
		}
	}
	rankWorker = null;
	rankWorkerDead = false;
	for (const [, req] of rankPending) {
		clearTimeout(req.timer);
		req.reject(new Error("Rank worker stopped"));
	}
	rankPending.clear();
}

// Embed the query through the indexer (unless a caller supplied qVec).
// Returns Float32Array or null (model down / migration / embed failure).
async function embedRankQuery(trimmed, dim) {
	try {
		spawnIndexer();
		await indexerReady;
	} catch {
		return null;
	}
	if (migrationState) return null;
	try {
		const reply = await askIndexer({ type: "embed-query", text: trimmed });
		if (reply.vec && reply.vec.length === dim) {
			return new Float32Array(reply.vec);
		}
	} catch {
		return null;
	}
	return null;
}

// Score against the in-process library (tests / fallback). qVecOverride
// skips the worker embed so ranking can be exercised without a model.
async function rankSearch(queryText, topK, qVecOverride) {
	const trimmed = (queryText || "").trim();
	if (!trimmed) return [];
	const l = loadLibrary();
	if (!l.filenames.length || !l.embeddings.length) return [];
	if (l.embeddings.length !== l.filenames.length) return [];

	let qVec = qVecOverride || null;
	if (!qVec) {
		qVec = await embedRankQuery(trimmed, l.dim);
		if (!qVec) return [];
	}
	if (!qVec || qVec.length !== l.dim) return [];

	const thresholds = thresholdsFor(l.modelId) || {};
	const norms = libraryNorms();
	return scoreLibrary(l, trimmed, qVec, topK, thresholds, norms);
}

// Single-round-trip variant (M-11): the centered query vector rides ALONGSIDE
// the results so scene/transcript fusion never re-embeds. The return is
// ALWAYS an array (backward compatible with every existing consumer: perf
// battery, search-matrix diagnostics, older renderers) with an extra
// `queryVec` property attached (a JSON-safe Array, or null when ranking fell
// back / model down). Structured clone preserves own props on arrays, so
// `Array.isArray()` stays true everywhere while new callers read `.queryVec`.
// Production scoring runs in the rank utilityProcess (Phase 0.4); on worker
// failure this falls back to the in-process rankSearch path.
async function rankSearchWithVec(queryText, topK, qVecOverride) {
	const withVec = (results, queryVec) => attachQueryVec(results, queryVec);
	const trimmed = (queryText || "").trim();
	if (!trimmed) return withVec([], null);
	const l = loadLibrary();
	if (!l.filenames.length || !l.embeddings.length) return withVec([], null);
	if (l.embeddings.length !== l.filenames.length) return withVec([], null);
	let qVec = qVecOverride || null;
	if (!qVec) {
		qVec = await embedRankQuery(trimmed, l.dim);
		if (!qVec) return withVec([], null);
	}
	if (!qVec || qVec.length !== l.dim) return withVec([], null);

	let results;
	try {
		// Off-main O(N×dim) scan: structured-clone the query vector into the
		// rank utilityProcess (embeddings stay put — gen tracks disk reloads).
		results = await askRankWorker({
			type: "rank",
			query: trimmed,
			topK: topK || 96,
			qVec,
		});
	} catch {
		// Worker down / timeout / crash — score in-process so search still works.
		try {
			results = await rankSearch(trimmed, topK || 96, qVec);
		} catch {
			results = [];
		}
	}
	return withVec(results || [], Array.from(qVec));
}

ipcMain.handle("memories:rank", async (_event, query, topK) => {
	try {
		return await rankSearchWithVec(query, topK || 96);
	} catch {
		return [];
	}
});

// ---------------------------------------------------------------------------
// Moment ranking: Scenes (pure visual) and Dialogue (pure transcript) are
// SEPARATE surfaces sharing one timeline math helper — never fused. Both
// run on main (N-01: off the renderer) against ONE centered query vector
// and return [{filename, score, t, dur, poster, why, snippet}].
//
// Scenes is legacy-exact visual ranking (weight 1.0, no hit caps): the same
// cosine/cutoff/gate/cap-3/topK the renderer used before, so previous
// results are preserved bit-for-bit. Dialogue ranks transcript rows only
// (weight recorded as text evidence, snippet always attached).
// ---------------------------------------------------------------------------

const {
	FUSION_SLOT_SECONDS,
	FUSION_SCENES_PER_VIDEO,
	FUSION_NOISE_FRACTION,
	fuseVisualTextMoments,
} = require("./indexer/transcript-store-utils.js");

// One centered query embed shared by both moment rankers (null on model
// down / migration / empty query — callers return [] then).
async function embedMomentQuery(queryText, qVecOverride) {
	const trimmed = (queryText || "").trim();
	const l = loadLibrary();
	if (!trimmed || !l.filenames.length) return null;
	let qVec = qVecOverride || null;
	if (!qVec) {
		try {
			spawnIndexer();
			await indexerReady;
		} catch {
			return null;
		}
		if (migrationState) return null;
		try {
			const reply = await askIndexer({ type: "embed-query", text: trimmed });
			if (reply.vec && reply.vec.length === l.dim)
				qVec = new Float32Array(reply.vec);
		} catch {
			return null;
		}
	}
	if (!qVec || qVec.length !== l.dim) return null;
	return qVec;
}

function momentThresholds() {
	const l = loadLibrary();
	const thresholds = thresholdsFor(l.modelId) || {};
	return {
		minScore: thresholds.minSemanticScore ?? RANK_MIN_SCORE,
		relativeKeep: thresholds.relativeKeep ?? RANK_RELATIVE_KEEP,
	};
}

function loadMomentSidecars() {
	const l = loadLibrary();
	let seg;
	let tra;
	try {
		seg = loadSegments(l.modelId);
	} catch {
		seg = null;
	}
	try {
		tra = loadTranscripts(l.modelId);
	} catch {
		tra = null;
	}
	return {
		segVideos: seg && seg.loaded ? seg.videos : new Map(),
		segRows: seg && seg.loaded ? seg.rows : [],
		segDim: seg && seg.loaded ? seg.dim : 0,
		traVideos: tra && tra.loaded ? tra.videos : new Map(),
		traRows: tra && tra.loaded ? tra.rows : [],
		traDim: tra && tra.loaded ? tra.dim : 0,
		traUtterances:
			tra && tra.loaded && tra.utterances instanceof Map
				? tra.utterances
				: new Map(),
	};
}

// Pure-visual scene moments, legacy-exact: raw segment cosines, NO hit caps
// (the old renderer path scored every row), weight 1.0 so cutoff and noise
// gate run in raw cosine space exactly as before.
async function rankVisualScenes(queryText, topK, qVecOverride) {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const qVec = await embedMomentQuery(queryText, qVecOverride);
	if (!qVec) return [];
	const { minScore, relativeKeep } = momentThresholds();
	const { segVideos, segRows, segDim } = loadMomentSidecars();
	if (segVideos.size === 0 || segDim !== qVec.length) return [];
	const visualHits = []; // {filename, t, dur, poster, score}
	let visualTotal = 0;
	for (const [filename, segments] of segVideos) {
		for (const s of segments) {
			const row = segRows[s.off];
			if (!row || row.length !== segDim) continue;
			visualTotal++;
			const sc = cosineSim(qVec, row);
			if (sc >= minScore) {
				visualHits.push({
					filename,
					t: s.t,
					dur: s.dur,
					poster: s.poster,
					score: sc,
				});
			}
		}
	}
	visualHits.sort((a, b) => b.score - a.score);
	if (visualHits.length === 0) return [];
	return fuseVisualTextMoments({
		visualHits,
		textHits: [],
		segVideos,
		visualTotal,
		textTotal: 0,
		minScore,
		relativeKeep,
		topK: k,
		wVisual: 1,
		wText: 0,
		slotSeconds: FUSION_SLOT_SECONDS,
		scenesPerVideo: FUSION_SCENES_PER_VIDEO,
		noiseFraction: FUSION_NOISE_FRACTION,
	});
}

// Exact dialogue moments (v3): literal spoken-word retrieval — no vectors,
// no thresholds, no model (works with CLIP down or mid-migration). Utterance
// lines when present (precise seek), else chunk rows (coarse seek). The old
// cosine + literal-boost path (rankDialogueMoments) is retired for dialogue —
// text-text cosine cannot separate "said it" from "about it". Scenes path
// untouched.
async function rankTranscriptMoments(queryText, topK) {
	const trimmed = (queryText || "").trim();
	if (!trimmed) return [];
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const { segVideos, traVideos, traUtterances } = loadMomentSidecars();
	const docs = [];
	const hasUtterances =
		traUtterances instanceof Map &&
		[...traUtterances.values()].some((l) => l.length > 0);
	if (hasUtterances) {
		for (const [filename, lines] of traUtterances) {
			for (const u of lines || []) {
				docs.push({ filename, t0: u.t0, t1: u.t1, text: u.text });
			}
		}
	} else {
		for (const [filename, chunks] of traVideos) {
			for (const c of chunks || []) {
				docs.push({ filename, t0: c.t0, t1: c.t1, text: c.text });
			}
		}
	}
	if (docs.length === 0) return [];
	return exactDialogueSearch({ query: trimmed, docs, segVideos, topK: k });
}

ipcMain.handle("memories:rank-scenes", async (_event, query, topK) => {
	try {
		return await rankVisualScenes(query, topK || 24);
	} catch {
		return [];
	}
});

ipcMain.handle("memories:rank-dialogue", async (_event, query, topK) => {
	try {
		return await rankTranscriptMoments(query, topK || 24);
	} catch {
		return [];
	}
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("memories:embed-query", async (_event, text) => {
	if (typeof text !== "string" || !text.trim()) return null;
	// The pool runs the TARGET model during a migration; ranking the
	// still-old library against it would produce garbage scores. Search
	// falls back to keyword matching until the flip lands.
	if (migrationState) return null;
	// A query in flight blocks a new enrichment chunk AND a new OCR job
	// from starting (the worker's priority lane handles a query that lands
	// mid-chunk; OCR paces itself between photos).
	enrichPendingQuery = true;
	ocrPendingQuery = true;
	transcribePendingQuery = true;
	// Tell the tray why its progress bar stalled (Phase 4) — only when
	// there's actually something to pause, so idle searches don't spam the
	// status channel.
	if (enrichQueue.length > 0 || enrichInFlight) {
		broadcastEnrichEvent({
			phase: "paused",
			active: enrichInFlight,
			pending: Math.max(0, enrichQueue.length - (enrichInFlight ? 1 : 0)),
		});
	}
	try {
		spawnIndexer();
		await indexerReady;
		const reply = await askIndexer({ type: "embed-query", text });
		return reply.vec ?? null;
	} catch {
		return null;
	} finally {
		enrichPendingQuery = false;
		ocrPendingQuery = false;
		transcribePendingQuery = false;
	}
});

ipcMain.handle("memories:enrich-state", () => enrichSnapshot());

ipcMain.handle("memories:transcribe-state", () => transcribeSnapshot());

ipcMain.handle("memories:ocr-state", () => ocrSnapshot());

ipcMain.handle("memories:import-paths", async (_event, paths) => {
	const list = Array.isArray(paths)
		? paths.filter((p) => typeof p === "string")
		: [];
	return importPaths(list);
});

ipcMain.handle("memories:pick", async () => pickAndImport());

ipcMain.handle("memories:get-watched-folders", () => watchedFolderList());

// N-06: renderer-visible app version (Settings footer). app.getVersion()
// reads package.json, the single version source — no mirror to drift.
ipcMain.handle("memories:get-version", () => app.getVersion());

ipcMain.handle("memories:reveal-watched-folder", (_event, folder) => {
	const target = watchedFolderRevealTarget(folder);
	if (!target) return { ok: false };
	shell.showItemInFolder(target);
	return { ok: true };
});

ipcMain.handle("memories:remove-watched-folder", (_event, folder) => {
	if (typeof folder !== "string" || !folder) return { ok: false };
	return { ok: removeWatchedFolder(folder) };
});

// Resolve the on-disk file that "Show in Finder" should reveal for a library
// filename: the recorded import source when it still exists, otherwise the
// app-managed copy in PHOTOS_DIR. Returns null when the filename is unknown
// or no file is on disk. Kept separate from the IPC handler so the headless
// smoke test can exercise the resolution logic without opening Finder.
function resolveRevealTarget(filename) {
	if (typeof filename !== "string" || !filename) return null;
	const l = loadLibrary();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return null;
	const source = l.sources && l.sources[idx];
	const target =
		source && fs.existsSync(source) ? source : path.join(PHOTOS_DIR, filename);
	return fs.existsSync(target) ? target : null;
}

// Reveal a library item in the OS file manager (Finder on macOS). The
// renderer only supplies a filename from its own grid; the real on-disk path
// is resolved via resolveRevealTarget from the recorded import sources, so an
// arbitrary string can never open a location of the renderer's choosing.
ipcMain.handle("memories:reveal-file", async (_event, filename) => {
	const target = resolveRevealTarget(filename);
	if (!target) return { ok: false };
	shell.showItemInFolder(target);
	return { ok: true };
});

// Open a library video in the OS default player (IINA/VLC/QuickTime). For
// searchable-only containers (mkv/hevc/...) Chromium cannot play them
// in-app, so the lightbox offers this as the full-file path alongside the
// 30 s in-app preview. Resolves the same guarded target as reveal-file —
// an arbitrary string can never open a path of the renderer's choosing —
// and returns { ok:false } when nothing is on disk.
ipcMain.handle("memories:open-external", async (_event, filename) => {
	const target = resolveRevealTarget(filename);
	if (!target) return { ok: false };
	try {
		const err = await shell.openPath(target);
		if (err) {
			console.warn(`[memories] open-external failed for ${filename}: ${err}`);
			return { ok: false, error: err };
		}
		return { ok: true };
	} catch (err) {
		console.warn(
			`[memories] open-external failed for ${filename}: ${err.message}`,
		);
		return { ok: false };
	}
});

// A row deleted mid-pipeline must stop being processed: without this, a
// deleted video's queued pump jobs keep running (burning the retry budget
// on a missing file), their late chunk replies resurrect sidecar entries
// for a row that no longer exists, and the tray keeps showing the deleted
// file. Queues hold {filename,...} jobs (enrich/transcribe) or bare
// filename strings (OCR).
function libraryHasRow(filename) {
	return loadLibrary().filenames.includes(filename);
}

function dropQueuedJobsFor(filename) {
	// Tombstone only when an in-flight chunk for this file survives below:
	// every pump's commit path consumes the entry on hit, so an entry with
	// no orphan behind it would linger and wrongly discard a future
	// re-queued job for the same filename. The head is left for the
	// orphan's own discard-shift — splicing it here would make that shift
	// evict a live successor, and the in-flight flags would misattribute
	// the tray to the next job until the orphan lands.
	const skipHead = (q, flag) => (flag && q.length > 0 ? 1 : 0);
	const headSurvives =
		(enrichInFlight && enrichQueue[0]?.filename === filename) ||
		(transcribeInFlight && transcribeQueue[0]?.filename === filename) ||
		(ocrInFlight && ocrQueue[0] === filename);
	if (headSurvives) deadJobs.add(filename);
	for (const [q, flag] of [
		[enrichQueue, enrichInFlight],
		[transcribeQueue, transcribeInFlight],
	]) {
		for (let i = q.length - 1; i >= skipHead(q, flag); i--) {
			if (q[i] && q[i].filename === filename) q.splice(i, 1);
		}
	}
	for (let i = ocrQueue.length - 1; i >= skipHead(ocrQueue, ocrInFlight); i--) {
		if (ocrQueue[i] === filename) ocrQueue.splice(i, 1);
	}
	clearEnrichProgressFor(filename);
	clearTranscribeProgressFor(filename);
	if (lastOcrFile === filename) lastOcrFile = null;
}

// Remove one library row: unlinks the app-managed copy in PHOTOS_DIR (plus
// the video poster/scene-poster/thumbnail sidecars, if any) and splices the
// parallel index arrays (filename, source, OCR, hash, embedding, phrase).
// The original imported file on disk is deliberately untouched — only the
// app's own copy is deleted, matching the renderer's "Delete" menu item.
// The filename must be a known library entry (the indexOf guard), so an
// arbitrary string can never unlink a file of the renderer's choosing.
// Callers decide when to saveLibrary() + broadcast. Returns true when a row
// was actually removed.
function removeLibraryRow(filename) {
	const l = loadLibrary();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return false;
	try {
		fs.unlinkSync(path.join(PHOTOS_DIR, filename));
	} catch {
		/* file already gone — the index row is what matters */
	}
	// Video posters are sidecars in POSTERS_DIR; sweep them too so no
	// orphaned thumbnail survives after the tile disappears.
	try {
		fs.unlinkSync(posterFor(filename));
	} catch {
		/* photo (no poster) or poster already gone */
	}
	// Scene posters (<stem>-scene-<i>.jpg) are sidecars of the same tile;
	// sweep them so no best-scene thumbnail outlives its video.
	try {
		const stem = path.basename(filename, path.extname(filename));
		for (const entry of fs.readdirSync(POSTERS_DIR)) {
			if (entry.startsWith(`${stem}-scene-`) && entry.endsWith(".jpg")) {
				fs.unlinkSync(path.join(POSTERS_DIR, entry));
			}
		}
	} catch {
		/* no posters dir or none matched */
	}
	// Splice every parallel array together so bins stay 1:1 with filenames.
	l.filenames.splice(idx, 1);
	l.sources.splice(idx, 1);
	if (l.sourceMtimes) l.sourceMtimes.splice(idx, 1);
	if (l.ocr) l.ocr.splice(idx, 1);
	if (l.ocrWords) l.ocrWords.splice(idx, 1);
	if (l.hashes) l.hashes.splice(idx, 1);
	if (l.screenshotHints) l.screenshotHints.splice(idx, 1);
	l.embeddings.splice(idx, 1);
	l.phrases.splice(idx, 1);
	// Scene segments + transcripts are keyed by filename — keep sidecars in
	// sync across ALL models (a film enriched under a previous model would
	// otherwise leave dead rows in that model's sidecar).
	removeSegmentsForAllModels(filename);
	removeTranscriptsForAllModels(filename);
	// Photo thumbnails are per-filename sidecars too; sweep the generated
	// JPEG so no orphaned thumbnail outlives its tile.
	try {
		fs.unlinkSync(thumbFor(filename));
	} catch {
		/* no thumbnail generated yet */
	}
	return true;
}

ipcMain.handle("memories:delete", async (_event, filename) => {
	if (typeof filename !== "string" || !filename) return { ok: false };
	if (!removeLibraryRow(filename)) return { ok: false };
	await saveLibrary();
	// Stop the pumps working on the deleted row (queued jobs, tray
	// progress) and push fresh tray snapshots — otherwise the pills keep
	// showing a file that no longer exists.
	dropQueuedJobsFor(filename);
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	broadcastEnrichEvent(enrichSnapshot());
	broadcastTranscribeEvent(transcribeSnapshot());
	broadcastOcrEvent(ocrSnapshot());
	return { ok: true };
});

// Current AI-engine status, so the renderer can ask on mount instead of
// hoping it didn't miss the broadcast window.
ipcMain.handle("memories:indexer-status", () => modelStatus);

// Switch the library's model: re-embed every row in the target model, then
// flip the index. Throws on unknown models and concurrent migrations; the
// renderer shows progress from the "migrate" status events.
ipcMain.handle("memories:set-model", async (_event, modelId) => {
	if (typeof modelId !== "string" || !getModel(modelId)) {
		throw new Error(`Unknown model: ${modelId}`);
	}
	return reembedToModel(modelId);
});

// Preload a model's weights without switching to it (the picker's per-model
// "Download" chip). Never touches the library or the active worker pool.
ipcMain.handle("memories:preload-model", (_event, modelId) =>
	preloadModelWeights(String(modelId)),
);

// "Download all models": fetch every model's weights so future switches are
// instant. Returns per-model results ({ modelId, downloaded, skipped?, error? }).
ipcMain.handle("memories:preload-all", () => preloadAllModels());

// ---------------------------------------------------------------------------
// Global shortcut to bring SCM to focus
// ---------------------------------------------------------------------------

let registeredShortcut = null;
let mainWindowRef = null;

function showAndFocusMain() {
	const win = liveMainWindow();
	if (!win) return;
	if (win.isMinimized()) win.restore();
	if (process.platform === "darwin") {
		// Dock-hidden apps need extra help to become key: parking the window
		// on all workspaces for a moment keeps show() from landing it
		// behind other apps' windows (or on another Space).
		try {
			win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		} catch {
			try {
				win.setVisibleOnAllWorkspaces(true);
			} catch {
				/* older Electron — show() alone will do */
			}
		}
	}
	// show() also unhides a window hidden to the menu bar (close-to-tray).
	win.show();
	try {
		if (win.isFullScreen()) win.setFullScreen(false);
	} catch {
		/* leaving fullscreen is best-effort */
	}
	win.focus();
	if (process.platform === "darwin") {
		try {
			win.moveTop();
		} catch {
			/* best effort */
		}
		try {
			win.setVisibleOnAllWorkspaces(false);
		} catch {
			/* best effort */
		}
		// Steal is legitimate here: this only ever runs from a user gesture
		// (tray click, global shortcut, second launch, Dock activate).
		try {
			app.focus({ steal: true });
		} catch {
			try {
				app.focus();
			} catch {
				/* best effort */
			}
		}
	}
}

// The main window if it still exists (mainWindowRef goes stale when the
// window is destroyed in normal quit-on-close mode).
function liveMainWindow() {
	if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef;
	mainWindowRef = null;
	return BrowserWindow.getAllWindows()[0] || null;
}

// Menu-bar click behavior: toggle the window. Focused → hide back to the
// tray; anything else (hidden, minimized, behind) → bring forward.
function toggleMainWindow() {
	const win = liveMainWindow();
	if (!win) return;
	let hidden;
	let minimized;
	try {
		hidden = !win.isVisible();
	} catch {
		hidden = true;
	}
	try {
		minimized = win.isMinimized();
	} catch {
		minimized = false;
	}
	if (hidden || minimized) {
		showAndFocusMain();
		return;
	}
	let focused;
	try {
		focused = win.isFocused();
	} catch {
		focused = false;
	}
	if (focused) {
		try {
			win.hide();
		} catch {
			/* best effort */
		}
	} else {
		showAndFocusMain();
	}
}

// Unregister the previously registered global shortcut (best-effort).
function unregisterCurrentShortcut() {
	if (!registeredShortcut) return;
	try {
		globalShortcut.unregister(registeredShortcut);
	} catch {
		/* already gone */
	}
	registeredShortcut = null;
}

// Try to register a global shortcut. Returns { ok, error? }.
// On success the accelerator is persisted to settings.
function tryRegisterShortcut(accelerator) {
	// Always clear the previous shortcut first.
	unregisterCurrentShortcut();
	if (!accelerator) {
		// Cleared — persist the empty state.
		writeSettings({ globalShortcut: null });
		console.log("[shortcut] cleared");
		return { ok: true };
	}
	try {
		const ok = globalShortcut.register(accelerator, showAndFocusMain);
		if (ok) {
			registeredShortcut = accelerator;
			writeSettings({ globalShortcut: accelerator });
			console.log(`[shortcut] registered: ${accelerator}`);
			return { ok: true };
		}
		// Registration failed — the shortcut is taken by the OS or another app.
		console.warn(
			`[shortcut] registration failed for "${accelerator}" — already in use by another app`,
		);
		return {
			ok: false,
			error: `"${accelerator}" is already in use by another app`,
		};
	} catch (err) {
		console.error(`[shortcut] registration threw for "${accelerator}":`, err);
		return { ok: false, error: err.message || "Failed to register shortcut" };
	}
}

ipcMain.handle("memories:get-shortcut", () => {
	const settings = readSettings();
	return settings.globalShortcut || null;
});

ipcMain.handle("memories:set-shortcut", (_event, accelerator) => {
	if (accelerator && typeof accelerator !== "string")
		return { ok: false, error: "Invalid shortcut" };
	// Validate the accelerator string (must contain at least one modifier + a key).
	if (accelerator) {
		const parts = accelerator.split("+");
		if (parts.length < 2)
			return {
				ok: false,
				error: "Shortcut needs a modifier (Ctrl/Alt/Cmd) and a key",
			};
	}
	return tryRegisterShortcut(accelerator || null);
});

// ---------------------------------------------------------------------------
// Menu-bar-only mode: hide the Dock icon and run from the macOS menu bar.
// Opt-in via Settings (settings.json `menuBarOnly`, default false). While
// enabled the app stays resident when the window closes (close hides to the
// menu bar; Quit happens from the tray menu), so background indexing,
// watched-folder syncs, and the global shortcut keep working with no Dock
// presence. The Dock concept is macOS-only, so dock hide/show is darwin-
// guarded; the tray itself is created wherever the mode is enabled.
// ---------------------------------------------------------------------------

let tray = null;
// True once a real quit is underway (tray Quit item, Cmd+Q, app-menu Quit):
// the window "close" handler hides instead of closing, so it must stand
// down while quitting or the app could never exit.
let isQuitting = false;
// Note: menuBarOnlyEnabled / pendingDockIcon / pendingDockIconId /
// currentAppIconId are defined near the top (before APP_ICON) to avoid TDZ
// with module-load APP_ICON init. trayIconBucket is the
// tray idle/busy bucket.
let trayIconBucket = "idle";

// C-01 Wave 2 (S1): readMenuBarOnly live in main-lib/settings.js (required at top).

// C-01 Wave 2 (S1): readNotifyOnDone live in main-lib/settings.js (required at top).

// C-01 Wave 2 (S1): readStartHidden live in main-lib/settings.js (required at top).

// Whether the main window is currently on screen (any window counts —
// exactly the condition where a notification would be redundant noise).
function mainWindowVisible() {
	try {
		return BrowserWindow.getAllWindows().some((w) => {
			try {
				return w.isVisible();
			} catch {
				return false;
			}
		});
	} catch {
		return true;
	}
}

function maybeNotify(title, body) {
	if (!readNotifyOnDone()) return;
	if (mainWindowVisible()) return;
	try {
		new Notification({ title, body }).show();
	} catch (err) {
		console.warn(`[menubar] notification failed: ${err.message}`);
	}
}

// Asar-safe tray icon: fs.readFileSync works inside app.asar while
// nativeImage.createFromPath does not (same reason APP_ICON loads through
// fs). 1x + 2x representations keep the icon crisp on Retina. Candidates
// cover the packaged layout (vite copies public/* into dist/) and the dev
// checkout (public/ directly).
function trayIconImage(variant) {
	const name = variant === "tray-busy" ? "tray-busy" : "tray";
	const empty = nativeImage.createEmpty();
	const candidates = [
		path.join(__dirname, "dist/images/tray"),
		path.join(__dirname, "public/images/tray"),
	];
	for (const dir of candidates) {
		try {
			const oneX = fs.readFileSync(path.join(dir, `${name}.png`));
			let twoX = null;
			try {
				twoX = fs.readFileSync(path.join(dir, `${name}@2x.png`));
			} catch {
				/* 1x alone is usable */
			}
			const img = nativeImage.createEmpty();
			img.addRepresentation({ scaleFactor: 1, buffer: oneX });
			if (twoX) img.addRepresentation({ scaleFactor: 2, buffer: twoX });
			if (!img.isEmpty()) return img;
		} catch {
			/* try the next candidate dir */
		}
	}
	return empty;
}

function setTrayIconBucket(bucket) {
	trayIconBucket = bucket;
	if (!tray) return;
	const icon = trayIconImage(bucket === "busy" ? "tray-busy" : "tray");
	if (icon.isEmpty()) return;
	try {
		tray.setImage(icon);
	} catch {
		/* best effort */
	}
}

// One-line status summaries for the dynamic tray menu, all from in-memory
// state the main process already holds (no disk, no worker round trip).
function trayStatusLines() {
	const lines = [];
	try {
		const count = loadLibrary().filenames.length;
		lines.push(`${count} photo${count === 1 ? "" : "s"} in library`);
	} catch {
		/* library not loaded yet */
	}
	if (modelStatus && modelStatus.type === "model") {
		if (modelStatus.phase === "loading") {
			lines.push(
				typeof modelStatus.progress === "number"
					? `AI engine loading — ${Math.round(modelStatus.progress)}%`
					: "AI engine loading…",
			);
		} else if (modelStatus.phase === "error") {
			lines.push("AI engine error");
		} else {
			lines.push("AI engine ready");
		}
	}
	try {
		const snap = enrichSnapshot();
		if (snap && (snap.active || snap.pending > 0)) {
			lines.push(
				snap.total > 0
					? `Analyzing scenes — ${snap.done}/${snap.total}`
					: `Analyzing scenes (${snap.pending} waiting)`,
			);
		}
	} catch {
		/* enrichment state not ready */
	}
	try {
		const snap = ocrSnapshot();
		if (snap && (snap.active || snap.pending > 0)) {
			lines.push(`Reading text (${snap.pending} waiting)`);
		}
	} catch {
		/* OCR state not ready */
	}
	return lines;
}

function buildTrayMenu() {
	const template = [
		{
			label: "Open SCM",
			click: () => showAndFocusMain(),
		},
		{
			label: "Import Photos…",
			click: () => {
				// Surface the window first: a file dialog parented to a
				// hidden window would open invisibly.
				showAndFocusMain();
				pickAndImport();
			},
		},
		{
			label: "Open Settings…",
			click: () => {
				showAndFocusMain();
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", { type: "open-settings" });
				}
			},
		},
		{ type: "separator" },
	];
	const statusLines = trayStatusLines();
	for (const line of statusLines) {
		template.push({ label: line, enabled: false });
	}
	if (statusLines.length > 0) template.push({ type: "separator" });
	template.push({
		label: "Quit SCM",
		click: () => {
			isQuitting = true;
			app.quit();
		},
	});
	return Menu.buildFromTemplate(template);
}

function createTray() {
	if (tray) return;
	const icon = trayIconImage(trayIconBucket === "busy" ? "tray-busy" : "tray");
	if (icon.isEmpty()) {
		console.warn("[menubar] no tray icon found; skipping tray creation");
		return;
	}
	tray = new Tray(icon);
	tray.setToolTip("SCM");
	// Deliberately NO setContextMenu: on macOS an attached menu hijacks
	// left-click. Left-click toggles the window; right-click pops a menu
	// built fresh at open time so the status lines are never stale.
	tray.on("click", () => toggleMainWindow());
	tray.on("right-click", () => {
		try {
			tray.popUpContextMenu(buildTrayMenu());
		} catch {
			/* best effort */
		}
	});
}

function destroyTray() {
	if (!tray) return;
	try {
		tray.destroy();
	} catch {
		/* already gone */
	}
	tray = null;
}

// Busy while the AI engine loads (or errored — needs attention), an import
// runs, or scene/OCR background work is queued or active.
function trayIsBusy() {
	if (typeof importInFlight !== "undefined" && importInFlight) return true;
	if (
		modelStatus &&
		modelStatus.type === "model" &&
		modelStatus.phase !== "ready"
	) {
		return true;
	}
	try {
		const snap = enrichSnapshot();
		if (snap && (snap.active || snap.pending > 0)) return true;
	} catch {
		/* not ready */
	}
	try {
		const snap = ocrSnapshot();
		if (snap && (snap.active || snap.pending > 0)) return true;
	} catch {
		/* not ready */
	}
	return false;
}

// Re-evaluate the tray icon after any status change. Cheap and guarded:
// no tray (mode off) means no work at all.
function updateTrayState() {
	if (!tray) return;
	const bucket = trayIsBusy() ? "busy" : "idle";
	if (bucket !== trayIconBucket) setTrayIconBucket(bucket);
}

// Apply the mode live: hide/show the Dock icon and create/destroy the tray.
// Called once at startup and on every Settings toggle (no restart needed).
function applyMenuBarMode(enabled) {
	const nextEnabled = enabled === true;
	if (process.platform === "darwin") {
		if (nextEnabled) {
			// Stage the correct Dock icon BEFORE hiding. macOS drops any
			// setIcon made while the Dock is hidden, so an icon chosen while
			// hidden would otherwise revert to the bundled SCM.icns on the
			// next show(). Setting before hide ensures the hidden state starts
			// with the right image. pendingDockIcon (icon chosen while hidden)
			// wins over APP_ICON so a change made while hidden is not lost.
			try {
				const toStage =
					pendingDockIcon || APP_ICON || loadAppIconImage(readAppIcon());
				if (toStage && !toStage.isEmpty() && app.dock)
					app.dock.setIcon(toStage);
				if (toStage && !toStage.isEmpty()) APP_ICON = toStage;
				if (pendingDockIconId) currentAppIconId = pendingDockIconId;
				pendingDockIcon = null;
				pendingDockIconId = null;
			} catch {
				/* staging is best-effort */
			}
			menuBarOnlyEnabled = true;
			createTray();
			// Only hide the Dock when the tray actually exists — a missing
			// icon must never leave the app with no visible presence.
			if (tray) app.dock?.hide();
			else menuBarOnlyEnabled = false;
		} else {
			menuBarOnlyEnabled = false;
			destroyTray();
			app.dock?.show();
			// macOS can drop a custom dock icon set while hidden. Re-apply the
			// user's chosen icon so toggling menu-bar mode doesn't revert to the
			// bundled SCM.icns — the "switch didn't stick" report. pendingDockIcon
			// (icon chosen while hidden) wins over disk so a just-picked icon
			// appears immediately without waiting for a relaunch.
			try {
				const toApply = pendingDockIcon || loadAppIconImage(readAppIcon());
				const toApplyId = pendingDockIconId || readAppIcon();
				if (toApply && !toApply.isEmpty() && app.dock)
					app.dock.setIcon(toApply);
				if (toApply && !toApply.isEmpty()) {
					APP_ICON = toApply;
					currentAppIconId = parseAppIcon(toApplyId);
					for (const win of BrowserWindow.getAllWindows()) {
						try {
							win.setIcon(toApply);
						} catch {
							/* window icon set is best-effort */
						}
					}
				}
				pendingDockIcon = null;
				pendingDockIconId = null;
			} catch {
				/* re-apply is best-effort */
			}
		}
	} else if (nextEnabled) {
		menuBarOnlyEnabled = true;
		createTray();
	} else {
		menuBarOnlyEnabled = false;
		destroyTray();
	}
	console.log(
		`[menubar] menu-bar-only ${menuBarOnlyEnabled ? "enabled" : "disabled"}`,
	);
	return menuBarOnlyEnabled;
}

ipcMain.handle("memories:get-menu-bar-only", () => readMenuBarOnly());

// First-run CRT tour marker (settings.json `onboardingSeen`). The
// install-level "has the tour shown" flag — unlike the renderer's
// localStorage copy it survives profile/storage resets, so the intro
// shows exactly once per install. Only `true` counts as seen.
ipcMain.handle("memories:get-onboarding-seen", () => readOnboardingSeen());

ipcMain.handle("memories:set-onboarding-seen", (_event, seen) => {
	if (typeof seen !== "boolean")
		return { ok: false, error: "Expected true or false" };
	writeSettings({ onboardingSeen: seen });
	return { ok: true, onboardingSeen: seen };
});

ipcMain.handle("memories:set-menu-bar-only", (_event, enabled) => {
	if (typeof enabled !== "boolean")
		return { ok: false, error: "Expected true or false" };
	writeSettings({ menuBarOnly: enabled });
	const applied = applyMenuBarMode(enabled);
	if (applied && process.platform === "darwin") {
		// Hiding the Dock can drop activation to Finder, leaving our window
		// greyed-out behind the mode switch — reclaim it immediately.
		try {
			app.focus({ steal: true });
		} catch {
			try {
				app.focus();
			} catch {
				/* best effort */
			}
		}
		const win = liveMainWindow();
		if (win) {
			try {
				if (win.isVisible()) win.focus();
			} catch {
				/* best effort */
			}
		}
	}
	return { ok: true, enabled: applied };
});

// ---------------------------------------------------------------------------
// Tray companion settings: launch at login, start hidden, completion
// notifications. `openAtLogin` lives in the OS login items (applied
// immediately); `startHidden`/`notifyOnDone` persist in settings.json.
// ---------------------------------------------------------------------------

function readTraySettings() {
	let openAtLogin = false;
	try {
		openAtLogin = app.getLoginItemSettings().openAtLogin === true;
	} catch {
		/* unsupported platform — report false */
	}
	return {
		openAtLogin,
		startHidden: readStartHidden(),
		notifyOnDone: readNotifyOnDone(),
	};
}

ipcMain.handle("memories:get-tray-settings", () => readTraySettings());

ipcMain.handle("memories:set-tray-settings", (_event, patch) => {
	if (!patch || typeof patch !== "object")
		return { ok: false, error: "Expected an object" };
	if (typeof patch.openAtLogin === "boolean") {
		try {
			app.setLoginItemSettings({
				openAtLogin: patch.openAtLogin,
				openAsHidden: true,
			});
		} catch (err) {
			return { ok: false, error: err.message || "Could not change login item" };
		}
	}
	const settingsPatch = {};
	if (typeof patch.startHidden === "boolean")
		settingsPatch.startHidden = patch.startHidden;
	if (typeof patch.notifyOnDone === "boolean")
		settingsPatch.notifyOnDone = patch.notifyOnDone;
	if (Object.keys(settingsPatch).length > 0) writeSettings(settingsPatch);
	return { ok: true, settings: readTraySettings() };
});

// ---------------------------------------------------------------------------
// App icon (Settings → Appearance → App Icon): Dock + window icon picked
// from public/images/app-icons/*.png (1024×1024). Stored as settings.json
// `appIcon`, validated via parseAppIcon. Applies live via app.dock.setIcon
// + win.setIcon and persists for next launch via APP_ICON.
// ---------------------------------------------------------------------------

ipcMain.handle("memories:get-app-icon", () => {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).appIcon;
		if (typeof raw === "string" && APP_ICON_IDS.includes(raw)) return raw;
	} catch {
		/* fall through to pending/current fallback */
	}
	// File missing, corrupted, or no appIcon key — don't snap back to
	// scm-vhs while the Dock is hidden. The in-memory staged choice
	// (pending while hidden, otherwise last applied) is the truth.
	if (pendingDockIconId && APP_ICON_IDS.includes(pendingDockIconId))
		return pendingDockIconId;
	if (currentAppIconId && APP_ICON_IDS.includes(currentAppIconId))
		return currentAppIconId;
	return readAppIcon();
});

ipcMain.handle("memories:get-app-icon-debug", () => {
	try {
		const rawFile = fs.readFileSync(SETTINGS_FILE, "utf-8");
		let parsed = null;
		let fileAppIcon = null;
		try {
			parsed = JSON.parse(rawFile);
			fileAppIcon = parsed.appIcon;
		} catch (e) {
			parsed = { _parseError: e.message };
		}
		return {
			ok: true,
			settingsFile: SETTINGS_FILE,
			userData: app.getPath("userData"),
			dirname: __dirname,
			fileExists: true,
			fileRawSnippet: rawFile.slice(0, 500),
			fileAppIcon,
			parsedAppIcon: parseAppIcon(fileAppIcon),
			currentAppIconId,
			pendingDockIconId,
			menuBarOnlyEnabled,
			readAppIcon: readAppIcon(),
			appIconIsEmpty: APP_ICON ? APP_ICON.isEmpty() : null,
		};
	} catch (err) {
		return {
			ok: false,
			settingsFile: SETTINGS_FILE,
			userData: (() => {
				try {
					return app.getPath("userData");
				} catch (e) {
					return `getPath failed: ${e.message}`;
				}
			})(),
			error: err.message,
			currentAppIconId,
			pendingDockIconId,
			menuBarOnlyEnabled,
		};
	}
});

ipcMain.handle("memories:set-app-icon", (_event, id) => {
	if (typeof id !== "string" || !APP_ICON_IDS.includes(id)) {
		return {
			ok: false,
			error: `Unknown app icon (expected ${APP_ICON_IDS.join(", ")})`,
		};
	}
	// Validate the image exists before persisting: a missing file (stale
	// DMG, bad build) previously wrote settings but left the Dock unchanged
	// with a silent {ok:true} — the "didn't change" bug.
	const img = loadAppIconImage(id);
	if (!img || img.isEmpty()) {
		console.warn(`[app-icon] missing image for ${id} — refusing to persist`);
		return {
			ok: false,
			error: `Icon image not found for "${id}" (rebuild or reinstall)`,
		};
	}
	writeSettings({ appIcon: id });
	// Keep APP_ICON/currentAppIconId and window icons in sync immediately so
	// newly created windows and any visible window chrome pick up the change
	// even while the Dock is hidden. The Dock itself is handled below. This
	// also ensures getAppIcon fallback (pending/current) stays truthful even
	// if the settings file is momentarily unreadable.
	APP_ICON = img;
	currentAppIconId = id;
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.setIcon(img);
		} catch {
			/* window icon set is best-effort */
		}
	}
	if (process.platform === "darwin" && app.dock) {
		if (menuBarOnlyEnabled) {
			// Dock is hidden in menu-bar-only mode: macOS drops setIcon()
			// calls made while hidden ("didn't change" while hidden). Don't
			// call setIcon while hidden — it is silently ignored. Stage the
			// image for the next show(). The next applyMenuBarMode(false)
			// (user disables the mode) and the next launch (icon-before-hide)
			// will apply it, so the change is never lost without flashing the
			// Dock with a show/set/hide cycle.
			pendingDockIcon = img;
			pendingDockIconId = id;
			console.log(
				`[app-icon] ${id} staged while Dock hidden (menu-bar-only) — will re-apply on Dock show`,
			);
			// Immediate menu-bar feedback: the Dock is invisible, so update
			// the tray icon to a tiny version of the chosen app icon. This
			// gives the user something visibly new in the menu bar without
			// waiting to disable the mode. The next tray bucket update
			// (busy/idle) or mode toggle will restore the normal tray image,
			// but the Dock icon remains correctly staged via pendingDockIcon.
			try {
				if (tray && img && !img.isEmpty()) {
					const small = img.resize({ width: 18, height: 18 });
					tray.setImage(small);
				}
			} catch {
				/* tray update is best-effort immediate feedback */
			}
		} else {
			try {
				app.dock.setIcon(img);
				pendingDockIcon = null;
				pendingDockIconId = null;
			} catch {
				/* dock not available */
			}
		}
	}
	// Notify renderers so the Settings UI can show a toast or refresh the
	// tray tooltip if it cares. The menu-bar hint already explains the
	// hidden-Dock case, but this event lets the UI be explicit.
	try {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "app-icon-changed",
				appIcon: id,
			});
		}
	} catch {
		/* best effort */
	}
	return { ok: true, appIcon: id };
});

// ---------------------------------------------------------------------------
// Video search quality IPC + re-analysis (Settings → Video search)
// ---------------------------------------------------------------------------

ipcMain.handle("memories:get-video-quality", () => readVideoQuality());

ipcMain.handle("memories:set-video-quality", (_event, quality) => {
	const vu = require("./indexer/video-utils.js");
	if (typeof quality !== "string" || !vu.VIDEO_QUALITY_IDS.includes(quality)) {
		return {
			ok: false,
			error:
				"Unknown video quality (expected eco, balanced, detailed, ultra, or ultraPro)",
		};
	}
	writeSettings({ videoQuality: quality });
	return { ok: true, quality };
});

// Per-video scene-coverage durations for the Settings → Video search cost
// line (MDs/Ultra-Pro-Plan.md §4.3): the renderer needs the user's own
// library footprint (footage hours, per-video lengths) to state the real
// time/disk bill before they commit to an expensive preset. Measured from
// each video's segment sidecar — the last row's coverage end
// (t + dur/2, same math as the bin header) approximates the duration at
// every preset density, since segment plans span the film end to end.
// Videos without scene data have no measured length yet: counted in
// unknownCount, excluded from `durations` (their bill lands at first
// analysis). Pure sidecar metadata — no ffmpeg spawns, safe whenever the
// Settings sheet opens.
ipcMain.handle("memories:videos-cost-estimate", () => {
	try {
		const l = loadLibrary();
		const videos = l.filenames.filter((name) => isVideo(name));
		const c = loadSegments(l.modelId);
		const durations = [];
		for (const name of videos) {
			const segs = c.videos.get(name);
			const last = segs && segs.length > 0 ? segs[segs.length - 1] : null;
			const end = last ? last.t + last.dur / 2 : null;
			if (Number.isFinite(end) && end > 0) durations.push(end);
		}
		return {
			ok: true,
			videoCount: videos.length,
			knownSeconds: durations.reduce((sum, s) => sum + s, 0),
			unknownCount: videos.length - durations.length,
			durations,
		};
	} catch (err) {
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
});

// ---------------------------------------------------------------------------
// Speech model IPC (Settings → Video search → Speech model)
// ---------------------------------------------------------------------------

ipcMain.handle("memories:get-whisper-model", () => readWhisperModel());

// Switch the whisper engine: transcripts are model-quality-dependent, so the
// whole speech sidecar (chunks + utterance lines + progress + bin rows) is
// invalidated and every library video re-queues from 0. In-flight replies
// from the old model are dropped by the pump's race check. Returns the
// re-queued count so the renderer can notify.
ipcMain.handle("memories:set-whisper-model", (_event, model) => {
	let requested = typeof model === "string" ? model : "";
	// Legacy alias: small.en was removed (OOM on 8GB) — treat a stale
	// selection as base.en so old renderers/clients migrate forward.
	if (requested === "small.en") {
		console.log(
			"[memories] speech model small.en removed — migrating request to base.en",
		);
		requested = "base.en";
	}
	const parsed = parseWhisperModel(requested);
	if (typeof model !== "string" || parsed !== requested) {
		return {
			ok: false,
			error: "Unknown speech model (expected tiny.en or base.en)",
		};
	}
	const prev = readWhisperModel();
	writeSettings({ whisperModel: parsed });
	if (parsed === prev) return { ok: true, model: parsed, queued: 0 };
	const l = loadLibrary();
	const c = loadTranscripts(l.modelId);
	c.videos = new Map();
	c.rows = [];
	c.utterances = new Map();
	c.progress = {};
	c.whisperModel = parsed;
	c.loaded = true;
	saveTranscripts();
	const videos = l.filenames.filter((name) => isVideo(name));
	if (videos.length > 0) {
		enqueueTranscription(
			videos.map((name) => ({
				filename: name,
				path: path.join(PHOTOS_DIR, name),
				off: 0,
			})),
		);
	}
	console.log(
		`[memories] speech model ${prev} → ${parsed}: sidecar invalidated, ${videos.length} video(s) re-queued`,
	);
	return { ok: true, model: parsed, queued: videos.length };
});

// ---------------------------------------------------------------------------
// OCR text languages IPC (Settings → Photo Search → Text languages)
// ---------------------------------------------------------------------------

ipcMain.handle("memories:get-ocr-langs", () => readOcrLangs());

// Switch the OCR language set: stored OCR text is language-dependent, so
// every library photo re-queues from 0 under the new traineddata set (old
// text stays visible until each row's re-OCR lands). The worker is restarted
// so the next job loads the new models. Returns the re-queued count so the
// renderer can notify. eng is always on — only the four CJK toggles are set.
ipcMain.handle("memories:set-ocr-langs", (_event, langs) => {
	const { parseOcrLangs: parseLangs } = require("./main-lib/settings.js");
	const parsed = parseLangs(langs);
	if (!Array.isArray(langs)) {
		return {
			ok: false,
			error: "Unknown OCR languages (expected an array of language ids)",
		};
	}
	// Reject unknown ids (but accept any subset, including [] = eng-only).
	// The allowlist is the shared table (indexer/ocr-lang-list.js), not a
	// hardcoded copy — new languages become settable without touching IPC.
	const {
		OCR_LANG_IDS: OCR_IPC_LANG_IDS,
	} = require("./indexer/ocr-lang-list.js");
	const allowed = new Set(OCR_IPC_LANG_IDS);
	for (const entry of langs) {
		if (!allowed.has(entry)) {
			return {
				ok: false,
				error: "Unknown OCR languages (expected an array of language ids)",
			};
		}
	}
	const prev = readOcrLangs();
	const prevStr = resolveOcrLangString(prev);
	const nextStr = resolveOcrLangString(parsed);
	writeSettings({ ocrLangs: parsed });
	const l = loadLibrary();
	l.ocrLangs = nextStr;
	if (prevStr === nextStr) {
		void saveLibrary();
		return { ok: true, langs: parsed, queued: 0 };
	}
	void saveLibrary();
	const queued = requeueAllPhotosForOcr(`langs ${prevStr} → ${nextStr}`);
	console.log(
		`[memories] OCR langs ${prevStr} → ${nextStr}: ${queued} photo(s) re-queued`,
	);
	return { ok: true, langs: parsed, queued };
});

// Re-read every library photo under the CURRENT language set
// (Settings → Photo Search → "Re-read all photos"). Manual counterpart to
// the one-time upgrade migration: re-queues with force:true (healthy rows
// included — their text may predate the current langs or a failed drain).
// Old text stays visible until each row's re-OCR lands. Returns the queued
// count so the renderer can notify; per-row failures surface in the drain
// summary log and retry on the next launch.
ipcMain.handle("memories:reocr-photos", () => {
	try {
		const queued = requeueAllPhotosForOcr("manual");
		return { ok: true, queued };
	} catch (err) {
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
});

// Re-analyze every library video under the CURRENT quality preset: drop each
// video's scene-segment sidecar (segment rows + scene posters) and re-queue
// it for background enrichment. New imports are unaffected (they already use
// the current preset); photos are untouched. Progress streams through the
// existing enrich tray; the launch backfill will also pick up anything left
// unprocessed.
async function reanalyzeVideos() {
	const l = loadLibrary();
	const videos = l.filenames.filter((name) => isVideo(name));
	if (videos.length === 0) return { ok: true, queued: 0 };
	const c = loadSegments(l.modelId);
	// Drop every library video's segment entry, then compact the row space
	// once (same rebuild as removeSegmentsFor, but bulk).
	for (const name of videos) c.videos.delete(name);
	const keep = [];
	for (const segs of c.videos.values()) {
		for (const seg of segs) keep.push(c.rows[seg.off]);
	}
	c.rows = keep;
	let off = 0;
	for (const segs of c.videos.values()) {
		for (const seg of segs) seg.off = off++;
	}
	c.loaded = true;
	saveSegments();
	// Sweep scene posters (<stem>-scene-<i>.jpg) for library videos so no
	// best-scene thumbnail outlives its re-analysis (same sweep as
	// removeLibraryRow, but bulk).
	try {
		const stems = new Set(videos.map((n) => path.basename(n, path.extname(n))));
		for (const entry of fs.readdirSync(POSTERS_DIR)) {
			if (!entry.endsWith(".jpg")) continue;
			for (const stem of stems) {
				if (entry.startsWith(`${stem}-scene-`)) {
					try {
						fs.unlinkSync(path.join(POSTERS_DIR, entry));
					} catch {
						/* already gone */
					}
					break;
				}
			}
		}
	} catch {
		/* no posters dir yet */
	}
	// Restart queued jobs from segment 0 so the worker rebuilds each plan
	// under the new budget (its cached plan is keyed on path + budget).
	for (const q of enrichQueue) q.off = 0;
	enqueueEnrichment(
		videos.map((name) => ({
			filename: name,
			path: path.join(PHOTOS_DIR, name),
		})),
	);
	// Transcripts: drop + re-queue both sidecars together so visual and
	// speech coverage stay in sync after a preset/model change.
	try {
		const tc = loadTranscripts(l.modelId);
		for (const name of videos) tc.videos.delete(name);
		const tkeep = [];
		for (const chunks of tc.videos.values()) {
			for (const ch of chunks) tkeep.push(tc.rows[ch.off]);
		}
		tc.rows = tkeep;
		let toff = 0;
		for (const chunks of tc.videos.values()) {
			for (const ch of chunks) ch.off = toff++;
		}
		// Fresh re-analysis restarts every film from slice 0: drop stale
		// resume points so nothing resumes mid-film under a new plan.
		if (tc.progress && typeof tc.progress === "object") {
			for (const name of videos) delete tc.progress[name];
		}
		tc.loaded = true;
		saveTranscripts();
	} catch {
		/* transcript sidecar optional */
	}
	try {
		for (const q of transcribeQueue) q.off = 0;
		enqueueTranscription(
			videos.map((name) => ({
				filename: name,
				path: path.join(PHOTOS_DIR, name),
			})),
		);
	} catch {
		/* transcribe queue initializes below */
	}
	return { ok: true, queued: videos.length };
}

ipcMain.handle("memories:reanalyze-videos", async () => reanalyzeVideos());

// Sidecars built before the chunk-accumulation fix (pumpEnrichment used to
// REPLACE a file's segment list with the last chunk) are truncated to the
// film's final minutes. Detect them from the current model's sidecar alone —
// no ffmpeg, no disk probing: the signature is a multi-chunk plan (planned >
// SEGMENTS_PER_CHUNK under the current preset) whose surviving segments
// cluster in the tail (span < half the estimated duration). The renderer
// surfaces the count in Settings → Video search and points at the existing
// "Re-analyze existing videos" repair.
ipcMain.handle("memories:suspected-truncated", () =>
	suspectedTruncatedVideos(),
);

function suspectedTruncatedVideos() {
	const l = loadLibrary();
	const c = loadSegments(l.modelId);
	if (!c.loaded || c.videos.size === 0)
		return { ok: true, count: 0, videos: [] };
	const flagged = suspectedTruncated(c.videos, videoBudgetForCurrentQuality());
	// Skip rows whose app copy is gone from disk (hand-deleted outside the
	// app between boot-prunes): they are ghosts, not repair candidates —
	// the boot prune owns removing them, and counting them keeps a stale
	// banner alive for videos the user already deleted.
	const live = flagged.filter((f) => {
		try {
			return fs.existsSync(path.join(PHOTOS_DIR, f.filename));
		} catch {
			return true;
		}
	});
	return {
		ok: true,
		count: live.length,
		videos: live.map((f) => ({
			filename: f.filename,
			planned: f.planned,
			actual: f.actual,
		})),
	};
}

// ---------------------------------------------------------------------------
// Named embedding versions (Settings → Library): snapshots of the
// searchable state across every model, restorable with auto-backup.
// ---------------------------------------------------------------------------

// A version must capture a QUIESCED library: an import or migration
// rewrites the index shape mid-copy, and an active pump mutates the very
// sidecars being snapshotted. Name the blocker so the UI can say it.
function versionsBusy() {
	if (importInFlight)
		return "An import is in progress — try again when it finishes.";
	if (migrationState)
		return "A model migration is running — try again when it finishes.";
	// A chunk already running must land before snapshotting/restoring
	// (it writes the very sidecars involved) — but only the chunk: queued
	// work behind a user pause is inert and safe to proceed past. A chunk
	// that never lands is what Settings → Video search → "Stop background
	// work" is for. (Library delete purges first and never hits this.)
	if (enrichInFlight)
		return "Scene analysis is finishing its current video — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (transcribeInFlight)
		return "Transcription is finishing its current video — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (ocrInFlight)
		return "Text extraction is finishing its current photo — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (!backgroundPaused) {
		if (enrichQueue.length > 0)
			return "Scene analysis is running — pause it from its tray, or try again when the tray is idle.";
		if (transcribeQueue.length > 0)
			return "Transcription is running — pause it from its tray, or try again when the tray is idle.";
		if (ocrQueue.length > 0)
			return "Text extraction is running — pause it from its tray, or try again when the tray is idle.";
	}
	return null;
}

ipcMain.handle("memories:set-background-paused", (_event, paused) => {
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
});

// Flush every pending persist so a create snapshots coherent on-disk
// state (the pumps write through the same FIFO queue).
async function versionsFlush() {
	await saveLibrary();
	await saveSegments();
	await saveTranscripts();
	await enqueuePersist(() => {});
}

// Drain every save queued so far (same FIFO). Awaiting the returned
// promise guarantees all saves enqueued BEFORE the call have landed;
// the cap keeps a stuck fsync from hanging quit/CI forever.
async function drainPersistQueue(timeoutMs) {
	await Promise.race([
		(async () => {
			await saveLibrary();
			await saveSegments();
			await saveTranscripts();
			await enqueuePersist(() => {});
		})(),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("persist drain timeout")), timeoutMs),
		),
	]);
}

function versionsSettingsSummary() {
	let videoQuality = null;
	let whisperModel = null;
	let ocrLangs = null;
	try {
		videoQuality = readVideoQuality();
	} catch {
		/* display-only — omit on failure */
	}
	try {
		whisperModel = readWhisperModel();
	} catch {
		/* display-only — omit on failure */
	}
	try {
		ocrLangs = readOcrLangs();
	} catch {
		/* display-only — omit on failure */
	}
	return { videoQuality, whisperModel, ocrLangs };
}

ipcMain.handle("memories:versions-list", () => ({
	ok: true,
	versions: listVersions(),
}));

ipcMain.handle("memories:versions-create", async (_event, name) => {
	const busy = versionsBusy();
	if (busy) return { ok: false, error: busy };
	await versionsFlush();
	return createVersion({
		name,
		appVersion: app.getVersion(),
		settings: versionsSettingsSummary(),
		index: libraryIndex(),
	});
});

ipcMain.handle("memories:versions-rename", (_event, slug, name) => {
	if (typeof slug !== "string" || !slug) return { ok: false };
	return renameVersion(slug, name);
});

ipcMain.handle("memories:versions-delete", (_event, slug) => {
	if (typeof slug !== "string" || !slug) return { ok: false };
	return deleteVersion(slug);
});

ipcMain.handle("memories:versions-restore", async (_event, slug) => {
	if (typeof slug !== "string" || !slug) return { ok: false };
	const busy = versionsBusy();
	if (busy) return { ok: false, error: busy };
	// Auto-backup first: restoring overwrites live state, so the current
	// state is snapshotted under a timestamped name — nothing is ever lost.
	// A same-second collision retries with a counter suffix.
	const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	let backup = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		const name =
			attempt === 0
				? `auto-backup-${stamp}`
				: `auto-backup-${stamp}-${attempt + 1}`;
		await versionsFlush();
		backup = createVersion({
			name,
			appVersion: app.getVersion(),
			settings: versionsSettingsSummary(),
			index: libraryIndex(),
		});
		if (backup.ok) break;
	}
	if (!backup || !backup.ok) {
		return {
			ok: false,
			error: backup?.error || "Could not back up the current state.",
		};
	}
	const restored = restoreVersion(slug, PHOTOS_DIR);
	if (!restored.ok) return restored;
	// Reload everything from the restored files: drop all in-memory caches
	// (index, bins, norms, sidecars, threshold calibrations) so the next
	// access rebuilds from disk. If the restored index names a different
	// active model, park the worker pool instead of respawning it here —
	// the next import/query re-forks for the actual model (the same shape
	// the migration-failure path uses).
	resetLibraryCaches();
	resetModelStateCache();
	const l = loadLibrary();
	if (l.modelId !== workerModelId) {
		stopIndexerPool();
		workerModelId = null;
	}
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	return {
		ok: true,
		backupSlug: backup.slug,
		restored: restored.manifest?.name || slug,
		missing: restored.missing || [],
	};
});

// ---------------------------------------------------------------------------
// Fresh start (Settings → Library → danger zone): delete the entire photo
// index and every derived artifact — rows, bins, scene/speech sidecars,
// app-managed copies, posters, thumbnails, overrides, failure history —
// and stop all watched folders so nothing re-imports on its own. Original
// files are untouched (only the app's copies go); settings, model weights,
// thresholds, saved searches, and embedding versions are kept.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Purge background work (Settings → Video search → maintenance, and the
// tray pills' Pause): one lick clean. Drops every queued pump unit,
// clears tray progress, prunes sidecar entries for rows that no longer
// exist (all models), drops partial sidecars of purged films so the next
// launch backfills them fresh, and restarts the indexer pool + kills the
// OCR/transcribe workers to drop zombie ffmpeg/tesseract work. Queued work
// for VALID rows is safe to drop: the launch backfills re-queue anything
// missing scene/speech/text data. Refused only during import/migration
// (they own the pipeline) — busy pumps are the point, not a blocker.
// In-flight chunks land or fail on their own; the row-gone guards keep
// them from resurrecting anything.
function pruneOrphanSidecars() {
	const rows = new Set(loadLibrary().filenames || []);
	const activeId = loadLibrary().modelId;
	let pruned = 0;
	for (const modelId of Object.keys(MODELS)) {
		const sc = loadSegments(modelId);
		if (sc.loaded) {
			let dropped = false;
			for (const name of [...sc.videos.keys()]) {
				if (!rows.has(name)) {
					sc.videos.delete(name);
					dropped = true;
					pruned++;
				}
			}
			if (dropped) {
				const keep = [];
				for (const segs of sc.videos.values()) {
					for (const seg of segs) keep.push(sc.rows[seg.off]);
				}
				sc.rows = keep;
				let off = 0;
				for (const segs of sc.videos.values()) {
					for (const seg of segs) seg.off = off++;
				}
				saveSegments();
			}
		}
		const tc = loadTranscripts(modelId);
		if (tc.loaded) {
			let dropped = false;
			for (const name of [...tc.videos.keys()]) {
				if (!rows.has(name)) {
					tc.videos.delete(name);
					if (tc.utterances instanceof Map) tc.utterances.delete(name);
					if (tc.progress && typeof tc.progress === "object")
						delete tc.progress[name];
					dropped = true;
					pruned++;
				}
			}
			if (dropped) {
				const keep = [];
				for (const chunks of tc.videos.values()) {
					for (const ch of chunks) keep.push(tc.rows[ch.off]);
				}
				tc.rows = keep;
				let off = 0;
				for (const chunks of tc.videos.values()) {
					for (const ch of chunks) ch.off = off++;
				}
				saveTranscripts();
			}
		}
	}
	// The loop leaves the caches parked on the last model — restore the
	// active pair so ranking serves the right vectors.
	loadSegments(activeId);
	loadTranscripts(activeId);
	return pruned;
}

// Shared core for memories:purge-background and memories:library-reset:
// stop every pump cold and leave the trays idle. Returns { queued, orphans }.
async function purgeBackgroundWork() {
	// Collect first: purged films lose their partial sidecars below so the
	// next launch backfills them fresh instead of stalling on fragments.
	const purged = new Set();
	for (const q of [enrichQueue, transcribeQueue]) {
		for (const job of q) if (job && job.filename) purged.add(job.filename);
	}
	for (const name of ocrQueue) if (typeof name === "string") purged.add(name);
	if (enrichInFlight && enrichQueue[0]?.filename)
		purged.add(enrichQueue[0].filename);
	if (transcribeInFlight && transcribeQueue[0]?.filename)
		purged.add(transcribeQueue[0].filename);
	if (ocrInFlight && typeof ocrQueue[0] === "string") purged.add(ocrQueue[0]);
	const queued = purged.size;
	// Invalidate in-flight chunks first: their late replies discard
	// instead of committing (see the purgeEpoch checks in the pumps).
	purgeEpoch++;
	enrichQueue.length = 0;
	transcribeQueue.length = 0;
	ocrQueue.length = 0;
	for (const t of [enrichTimer, transcribeTimer, ocrTimer]) {
		if (t) clearTimeout(t);
	}
	enrichTimer = transcribeTimer = ocrTimer = null;
	for (const name of purged) {
		clearEnrichProgressFor(name);
		clearTranscribeProgressFor(name);
		removeSegmentsForAllModels(name);
		removeTranscriptsForAllModels(name);
	}
	if (lastOcrFile && purged.has(lastOcrFile)) lastOcrFile = null;
	const orphans = pruneOrphanSidecars();
	// Drop zombie worker/ffmpeg work with the queues: the next pump (or
	// query) re-forks what it needs on demand. Orphan fix: ffmpeg children
	// are SIGKILLed before their Node workers (killing the worker alone
	// orphans ffmpeg to PID 1).
	restartPrimaryIndexer("user purge");
	killOcrWorker();
	stopRankWorker();
	try {
		if (transcribeWorker) {
			requestWorkerKillFfmpeg(
				transcribeWorker,
				transcribeFfmpegPids,
				"user purge",
			);
			try {
				if (transcribeWorker.process) transcribeWorker.process.kill();
			} catch {
				/* already gone */
			}
		} else {
			killTrackedFfmpegPids(transcribeFfmpegPids, "user purge-no-worker");
		}
	} catch {
		/* never forked */
	}
	transcribeWorkerDead = true;
	// The killed chunks' promises settle (or time out) on their own — clear
	// the in-flight flags NOW so gates open immediately instead of waiting
	// out a wedged ffmpeg. Late replies discard via purgeEpoch + row
	// checks, and the drained queues can't double-pump, so this is safe.
	enrichInFlight = false;
	transcribeInFlight = false;
	ocrInFlight = false;
	// The epoch bump above guards every orphan, so the tombstone set starts
	// fresh: stale entries would otherwise discard legitimate re-queued
	// work for the same filenames after the purge.
	deadJobs.clear();
	// Zero the tray counters with the queues — the pills report these
	// alongside queue length, and pre-purge totals against an empty queue
	// read as stuck work. (The next backfill recounts from zero.)
	enrichNotifyCount = 0;
	ocrTotalCount = 0;
	ocrDoneCount = 0;
	lastOcrFile = null;
	broadcastEnrichEvent(enrichSnapshot());
	broadcastTranscribeEvent(transcribeSnapshot());
	broadcastOcrEvent(ocrSnapshot());
	console.log(
		`[memories] background purged: ${queued} queued unit(s), ${orphans} orphan sidecar entr(ies) pruned`,
	);
	return { queued, orphans };
}

ipcMain.handle("memories:purge-background", async () => {
	if (importInFlight)
		return {
			ok: false,
			error: "An import is in progress — try again when it finishes.",
		};
	if (migrationState)
		return {
			ok: false,
			error: "A model migration is running — try again when it finishes.",
		};
	const { queued, orphans } = await purgeBackgroundWork();
	return { ok: true, queued, orphans };
});

ipcMain.handle("memories:library-reset", async () => {
	// Only import/migration block a wipe (they own the pipeline) — pump
	// activity, however wedged, is purged first instead of refusing: a
	// stuck chunk must never veto deleting the library.
	if (importInFlight)
		return {
			ok: false,
			error: "An import is in progress — try again when it finishes.",
		};
	if (migrationState)
		return {
			ok: false,
			error: "A model migration is running — try again when it finishes.",
		};
	// Stop every pump cold first (queues, in-flight flags, zombie workers,
	// orphan sidecars, tray counters) — even on an empty library: wedged
	// flags must not survive a fresh start that reports success. Queued
	// work is meaningless against an empty library, and the purge's epoch
	// guards the late replies.
	await purgeBackgroundWork();
	const rows = loadLibrary().filenames.length;
	if (rows === 0) return { ok: true, rows: 0, unwatched: 0, files: 0 };
	// Stop every watched folder (with proper watcher teardown) so the
	// empty library isn't re-imported behind the user's back.
	let unwatched = 0;
	for (const folder of [...watchedFolders]) {
		if (removeWatchedFolder(folder)) unwatched++;
	}
	// Delete library-state files + app-managed copies, posters, thumbs
	// (memory + disk for the failure/override histories are cleared just
	// below). Settings, weights, thresholds, and versions/ are untouched.
	const { files } = resetLibraryFiles();
	// Forget overrides + failure history (memory and disk).
	clearCategoryOverrides();
	clearFailedImports();
	// Rebuild empty in memory and persist the clean index, then tell the
	// renderer to refetch (grid lands on its empty state). Push idle tray
	// snapshots too — the queues were just drained, and with no further
	// pump ticks coming the pills would otherwise render stale jobs forever.
	resetLibraryCaches();
	await saveLibrary();
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	broadcastEnrichEvent(enrichSnapshot());
	broadcastTranscribeEvent(transcribeSnapshot());
	broadcastOcrEvent(ocrSnapshot());
	return { ok: true, rows, unwatched, files };
});

// ---------------------------------------------------------------------------
// AI Insights: what the AI sees in a photo
// ---------------------------------------------------------------------------

ipcMain.handle("memories:get-ai-insights", (_event, filename) => {
	if (typeof filename !== "string") return null;
	const l = loadLibrary();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return null;

	// 1. Filename-derived keywords.
	const phrase = buildFilenamePhrase(filename);
	const keywords = phrase ? phrase.split(/\s+/).filter(Boolean) : [];

	// 2. OCR text (if any).
	const ocrText = (l.ocr && l.ocr[idx]) || null;

	// 3. Which model processed this image.
	const modelId = l.modelId;
	const config = getModel(modelId) || getModel(DEFAULT_MODEL_ID);

	// 4. Visual concept tags: reverse-lookup which sample queries this
	//    image appears in (from the precomputed memory-queries.json).
	const queries = loadSampleQueries();
	const concepts = [];
	if (Array.isArray(queries.queries)) {
		for (const entry of queries.queries) {
			if (!entry || !entry.q || !Array.isArray(entry.top)) continue;
			const match = entry.top.find((t) => t && t.filename === filename);
			if (match && typeof match.score === "number") {
				concepts.push({ query: entry.q, score: match.score });
			}
		}
	}
	// Sort by score descending, take top 8.
	concepts.sort((a, b) => b.score - a.score);

	return {
		filename,
		keywords,
		ocrText,
		modelId,
		modelName: config?.label || modelId,
		concepts: concepts.slice(0, 8),
	};
});

// ---------------------------------------------------------------------------
// LLMs mode (MDs/Ask-Mode-Plan.md): embedded llama.cpp sidecar answering
// from OCR text + dialogue transcripts + filename evidence. The retrieval
// path is worker-free (no CLIP embed, no pending flags) and read-only.
// ---------------------------------------------------------------------------

function broadcastLlmStatus(payload) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", payload);
	}
}

// One download at a time — a second Settings click while the binary or a
// model streams joins the in-flight request instead of racing the same
// destination file.
// Per-target single-flight: clicking Download for a model while the engine
// still streams must START the model download (or at worst queue it), never
// silently join the engine's promise — on a slow link that join read as a
// dead button. Different targets download in parallel; the same target
// joins its own in-flight request.
const llmDownloadInflight = new Map();
function llmDownload(target) {
	const existing = llmDownloadInflight.get(target);
	if (existing) return existing;
	const run = (async () => {
		try {
			if (target === "binary") {
				if (!llmBinaryDownloaded()) await llmDownloadServerBinary();
			} else {
				await llmDownloadModelWeights(target);
			}
			return { ok: true };
		} catch (err) {
			broadcastLlmStatus({
				type: "llm",
				phase: "error",
				target,
				detail: String((err && err.message) || err),
			});
			return { ok: false, error: String((err && err.message) || err) };
		} finally {
			llmDownloadInflight.delete(target);
		}
	})();
	llmDownloadInflight.set(
		target,
		run.finally(() => llmDownloadInflight.delete(target)),
	);
	return run;
}

ipcMain.handle("memories:llm-status", () => {
	const cfg = readLlmConfig();
	return {
		enabled: cfg.enabled,
		chatModel: cfg.chatModel,
		models: llmModelInfos(llmModelDownloaded),
		server: llmServerSnapshot(),
	};
});

ipcMain.handle("memories:llm-set-config", (_event, patch) => {
	if (!patch || typeof patch !== "object") {
		return { ok: false, error: "Expected an object" };
	}
	const allowed = {};
	if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
	if (typeof patch.chatModel === "string") allowed.chatModel = patch.chatModel;
	try {
		const config = writeLlmConfig(allowed);
		// Config changes must reach every open surface immediately: the
		// grid's Ask toggle reads the flag through useAsk, which would
		// otherwise keep the toggle hidden until the next "llm" event or an
		// app restart (the "enabled it and nothing appeared" bug).
		broadcastLlmStatus({
			type: "llm",
			phase: "idle",
			detail: "config-changed",
		});
		return { ok: true, config };
	} catch (err) {
		return { ok: false, error: String((err && err.message) || err) };
	}
});

ipcMain.handle("memories:llm-download", (_event, target) => {
	if (target !== "binary" && typeof target !== "string") {
		return Promise.resolve({ ok: false, error: "Unknown download target" });
	}
	return llmDownload(target);
});

// The LLMs answer: evidence → prompt → sidecar. Never throws across IPC
// (the get-ai-insights shape): every outcome is {ok, reason?|error?, answer?,
// evidence[]}. Empty evidence short-circuits BEFORE the LLM — the model is
// never asked a question the library has no textual evidence for.
// In-flight Ask generations, keyed by the renderer's reqId: Stop wires
// through here — memories:ask-stop aborts the sidecar fetch mid-stream and
// the handler resolves with the partial text instead of vanishing it.
const askAborts = new Map();
const askStopFlags = new Set();

ipcMain.on("memories:ask-stop", (_event, payload) => {
	const reqId = payload && payload.reqId;
	const ctrl = askAborts.get(reqId);
	if (ctrl) {
		askStopFlags.add(reqId);
		try {
			ctrl.abort();
		} catch {
			/* already settled */
		}
	}
});

ipcMain.handle("memories:ask", async (event, payload) => {
	try {
		const cfg = readLlmConfig();
		if (!cfg.enabled) return { ok: false, reason: "disabled", evidence: [] };
		const query =
			payload && typeof payload.query === "string" ? payload.query.trim() : "";
		if (!query)
			return { ok: true, answer: null, reason: "empty", evidence: [] };
		const l = loadLibrary();
		const scoped = Array.isArray(payload && payload.filenames)
			? validateScopedFilenames(payload.filenames, l.filenames)
			: new Set(l.filenames);
		if (scoped.size === 0) {
			return { ok: true, answer: null, reason: "no-evidence", evidence: [] };
		}
		const askT0 = Date.now();
		const { photoRows, videoNames } = partitionScoped(scoped, isVideo);
		for (const row of photoRows) {
			const idx = l.filenames.indexOf(row.filename);
			row.ocr = idx >= 0 && Array.isArray(l.ocr) ? l.ocr[idx] || "" : "";
		}
		const transcripts = loadTranscripts(l.modelId);
		const segments = loadSegments(l.modelId);
		const evidence = buildAskEvidence({
			query,
			photoRows,
			videoNames,
			transcripts,
			segVideos: segments && segments.loaded ? segments.videos : new Map(),
		});
		if (evidence.all.length === 0) {
			return { ok: true, answer: null, reason: "no-evidence", evidence: [] };
		}
		// Process stats for the card's readout: retrieval cost is measured,
		// generation numbers arrive with the sidecar reply (or stay absent —
		// the card estimates live and prints exacts on completion).
		const retrievalMs = Date.now() - askT0;
		const evidenceStats = {
			filesScanned: scoped.size,
			dialogueHits: evidence.dialogue.length,
			ocrHits: evidence.ocr.length,
			keywordHits: evidence.keyword.length,
			tier: evidence.tier,
			retrievalMs,
		};
		if (!llmBinaryDownloaded() || !llmModelDownloaded(cfg.chatModel)) {
			return {
				ok: false,
				reason: "not-installed",
				missing: !llmBinaryDownloaded() ? "binary" : "model",
				evidence: evidence.all,
			};
		}
		const messages = buildAskMessages({ query, evidenceRows: evidence.all });
		// Streaming generation: the renderer passes a reqId, gets the
		// evidence first (chips + grid populate mid-answer), then token
		// deltas, then this invoke resolves with the full text. A caller
		// without reqId (tests, scripts) gets the same final answer with
		// nowhere for the events to go.
		const reqId = payload && Number.isFinite(payload.reqId) ? payload.reqId : 0;
		const sender = event.sender;
		const sendAsk = (channel, body) => {
			try {
				sender.send(channel, body);
			} catch {
				/* window gone mid-answer */
			}
		};
		if (reqId)
			sendAsk("memories:ask-evidence", {
				reqId,
				evidence: evidence.all,
				stats: evidenceStats,
			});
		// Cold start shows its own phase: a resident sidecar answers in
		// seconds, a fresh spawn takes seconds to mmap + warm up.
		const snap = llmServerSnapshot();
		const warm =
			snap.running === true && !!snap.modelId && snap.modelId === cfg.chatModel;
		const modelInfo =
			llmModelInfos(llmModelDownloaded).find((m) => m.id === cfg.chatModel) ||
			null;
		if (!warm && reqId) {
			sendAsk("memories:ask-phase", {
				reqId,
				phase: "spawning",
				modelLabel: modelInfo ? modelInfo.label : cfg.chatModel,
				sizeBytes: modelInfo ? modelInfo.sizeBytes : null,
			});
		}
		const finishStats = (elapsedMs, timings) => {
			const out = {
				...evidenceStats,
				coldStart: !warm,
				elapsedMs,
				modelLabel: modelInfo ? modelInfo.label : cfg.chatModel,
				ctxTokens: modelInfo ? modelInfo.ctxTokens : null,
				sizeBytes: modelInfo ? modelInfo.sizeBytes : null,
				threads: llmChatThreadCount(),
				accelerator: process.platform === "darwin" ? "Metal" : null,
			};
			if (timings) {
				out.promptTokens = timings.promptTokens;
				out.predictedTokens = timings.predictedTokens;
				if (
					timings.predictedMs &&
					timings.predictedTokens > 0 &&
					timings.predictedMs > 0
				) {
					out.tokensPerSec =
						Math.round(
							(timings.predictedTokens / (timings.predictedMs / 1000)) * 10,
						) / 10;
				}
			}
			return out;
		};
		const ctrl = new AbortController();
		if (reqId) askAborts.set(reqId, ctrl);
		const parts = [];
		const onToken = (delta) => {
			parts.push(delta);
			if (reqId) sendAsk("memories:ask-token", { reqId, delta });
		};
		const genT0 = Date.now();
		try {
			const reply = await llmChat({
				messages,
				modelId: cfg.chatModel,
				stream: true,
				signal: ctrl.signal,
				onToken,
			});
			return {
				ok: true,
				answer: parts.join(""),
				evidence: evidence.all,
				stats: finishStats(Date.now() - genT0, reply.timings || null),
			};
		} catch {
			if (reqId) {
				askAborts.delete(reqId);
				if (askStopFlags.delete(reqId)) {
					// User Stop: keep the partial text visible, marked stopped.
					return {
						ok: false,
						reason: "stopped",
						evidence: evidence.all,
						partial: parts.join("") || null,
						stats: finishStats(Date.now() - genT0, null),
					};
				}
			}
			// Stream failure (not a Stop): one legacy non-streaming retry
			// with the same evidence — a slow answer beats an error card.
			// Fresh controller: the stream's one may already be settled.
			const retryCtrl = new AbortController();
			if (reqId) askAborts.set(reqId, retryCtrl);
			try {
				const genT1 = Date.now();
				const reply = await llmChat({
					messages,
					modelId: cfg.chatModel,
					stream: false,
					signal: retryCtrl.signal,
				});
				return {
					ok: true,
					answer: reply.content,
					evidence: evidence.all,
					stats: finishStats(Date.now() - genT1, reply.timings || null),
				};
			} catch (err2) {
				if (reqId && askStopFlags.delete(reqId)) {
					return {
						ok: false,
						reason: "stopped",
						evidence: evidence.all,
						partial: parts.join("") || null,
						stats: finishStats(Date.now() - genT0, null),
					};
				}
				return {
					ok: false,
					reason: "error",
					error: String((err2 && err2.message) || err2),
					evidence: [],
				};
			}
		} finally {
			if (reqId) askAborts.delete(reqId);
		}
	} catch (err) {
		return {
			ok: false,
			reason: "error",
			error: String((err && err.message) || err),
			evidence: [],
		};
	}
});

// ---------------------------------------------------------------------------
// YouTube video agent (feat/youtube-agent): yt-dlp downloads -> importPaths.
// Downloads land in library/youtube-staging, then flow through the existing
// import pipeline (hash-dedupe, embeds, scenes, Whisper, OCR). Matching is
// renderer-side: saved searches with watch:true filter rank results to
// youtube.json filenames and jump to timecodes. Main only downloads,
// imports, and reports status.
// ---------------------------------------------------------------------------

const youtubeJobs = new Map(); // jobId -> { jobId, kind, url, label, status, error?, files? }
let youtubeQueue = []; // [{ jobId, kind, url, label }]
let youtubeInFlight = false;
let youtubePollTimer = null;

function youtubeBroadcast() {
	try {
		const payload = youtubeStatus();
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", payload);
		}
	} catch {
		/* broadcast is best-effort */
	}
}

function youtubeStatus() {
	let cfg;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		cfg = youtube.parseYoutubeConfig(null);
	}
	return {
		type: "youtube",
		phase: youtubeInFlight ? "downloading" : "idle",
		pending: youtubeQueue.length,
		active: youtubeInFlight,
		jobs: [...youtubeJobs.values()].slice(-20),
		channels: cfg.channels,
		quality: cfg.quality,
		enabled: cfg.enabled,
		maxPerChannel: cfg.maxPerChannel,
		pollHours: cfg.pollHours,
		storageCapGB: cfg.storageCapGB,
		binaryReady: youtubeBinaryReady(),
	};
}

function youtubeBinaryReady() {
	try {
		if (fs.existsSync(youtube.binPath())) return true;
	} catch {
		/* fall through to PATH check */
	}
	for (const p of ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"]) {
		try {
			if (fs.existsSync(p)) return true;
		} catch {
			/* next */
		}
	}
	return false;
}

function resolveYtDlpBinary() {
	// Prefer the app-managed pinned binary; fall back to a system yt-dlp
	// (Homebrew) so existing installs work before the first fetch.
	try {
		const managed = youtube.binPath();
		if (fs.existsSync(managed)) return managed;
	} catch {
		/* fall through */
	}
	for (const p of [
		"/opt/homebrew/bin/yt-dlp",
		"/usr/local/bin/yt-dlp",
		"yt-dlp",
	]) {
		try {
			if (p !== "yt-dlp" && fs.existsSync(p)) return p;
		} catch {
			/* next */
		}
	}
	return "yt-dlp"; // PATH lookup; spawn reports ENOENT cleanly when absent
}

// ffmpeg location for yt-dlp's --ffmpeg-location: without it a GUI launch
// (Finder PATH without Homebrew) downloads video-only .fXXX.mp4 + .m4a
// intermediates that never merge — importing silent videos with zero
// transcript chunks. Mirrors indexerEnv()'s packaged-ffmpeg preference,
// then ffmpeg-static (dev), then well-known system paths.
function resolveYtDlpFfmpegLocation() {
	try {
		if (
			process.resourcesPath &&
			fs.existsSync(path.join(process.resourcesPath, "ffmpeg"))
		) {
			return path.join(process.resourcesPath, "ffmpeg");
		}
	} catch {
		/* fall through */
	}
	try {
		const statik = require("ffmpeg-static");
		if (statik && fs.existsSync(statik)) return statik;
	} catch {
		/* fall through */
	}
	for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
		try {
			if (fs.existsSync(p)) return p;
		} catch {
			/* next */
		}
	}
	return null;
}

function downloadYtDlpBinary(version) {
	// Fetch-on-first-use: keeps the DMG small; mirrors the weights/OCR-pack
	// pattern. macOS universal asset; chmod +x on landing.
	const ver =
		typeof version === "string" && version
			? version
			: youtube.YTDLP_PINNED_VERSION;
	const asset = "yt-dlp_macos";
	const url = `${youtube.YTDLP_RELEASE_BASE}/${ver}/${asset}`;
	const dest = youtube.binPath();
	return new Promise((resolve) => {
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
		} catch {
			resolve({ ok: false, error: "mkdir failed" });
			return;
		}
		const tryGet = (u, redirects) => {
			try {
				const mod = u.startsWith("https:") ? require("https") : require("http");
				const req = mod.get(
					u,
					{ headers: { "User-Agent": "SCM-youtube-agent" } },
					(res) => {
						if (
							res.statusCode >= 300 &&
							res.statusCode < 400 &&
							res.headers.location &&
							redirects > 0
						) {
							res.resume();
							tryGet(res.headers.location, redirects - 1);
							return;
						}
						if (res.statusCode !== 200) {
							res.resume();
							resolve({ ok: false, error: `http ${res.statusCode}` });
							return;
						}
						const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
						const out = fs.createWriteStream(tmp, { mode: 0o755 });
						res.pipe(out);
						out.on("finish", () => {
							out.close(() => {
								try {
									fs.chmodSync(tmp, 0o755);
									fs.renameSync(tmp, dest);
									resolve({ ok: true, path: dest });
								} catch (err) {
									resolve({ ok: false, error: String(err.message || err) });
								}
							});
						});
						out.on("error", (err) => {
							resolve({ ok: false, error: String(err.message || err) });
						});
					},
				);
				req.on("error", (err) =>
					resolve({ ok: false, error: String(err.message || err) }),
				);
				req.setTimeout(120000, () => {
					try {
						req.destroy(new Error("timeout"));
					} catch {
						/* settled */
					}
				});
			} catch (err) {
				resolve({ ok: false, error: String(err.message || err) });
			}
		};
		tryGet(url, 5);
	});
}

function enqueueYoutubeJob(kind, url, label) {
	const jobId = `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const job = {
		jobId,
		kind,
		url,
		label: label || url,
		status: "queued",
		error: null,
		files: [],
	};
	youtubeJobs.set(jobId, job);
	youtubeQueue.push({ jobId, kind, url, label: job.label });
	pumpYoutubeQueue();
	youtubeBroadcast();
	return job;
}

function pumpYoutubeQueue() {
	if (youtubeInFlight) return;
	const next = youtubeQueue.shift();
	if (!next) return;
	youtubeInFlight = true;
	const job = youtubeJobs.get(next.jobId);
	if (job) job.status = "downloading";
	youtubeBroadcast();
	runYoutubeJob(next)
		.then((res) => {
			const j = youtubeJobs.get(next.jobId);
			if (j) {
				j.status = res.ok ? "done" : "error";
				j.error = res.ok ? null : res.error || "download failed";
				j.files = res.files || [];
			}
		})
		.catch((err) => {
			const j = youtubeJobs.get(next.jobId);
			if (j) {
				j.status = "error";
				j.error = String((err && err.message) || err);
			}
		})
		.finally(() => {
			youtubeInFlight = false;
			youtubeBroadcast();
			if (youtubeQueue.length > 0) pumpYoutubeQueue();
		});
}

function snapshotStagingFiles(dir) {
	const before = new Map();
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (!/\.(mp4|mkv|webm|mov|m4v)$/i.test(entry)) continue;
			try {
				before.set(entry, fs.statSync(path.join(dir, entry)).mtimeMs);
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* staging may not exist yet */
	}
	return before;
}

function newStagingFiles(dir, before) {
	const out = [];
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (!/\.(mp4|mkv|webm|mov|m4v)$/i.test(entry)) continue;
			const full = path.join(dir, entry);
			try {
				const st = fs.statSync(full);
				if (!before.has(entry) || st.mtimeMs > before.get(entry))
					out.push(full);
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	return out.sort();
}

// Merge yt-dlp pre-merge intermediates (video-only .fXXX.mp4 + audio .m4a)
// into a final merged .mp4 with audio, using the bundled ffmpeg. Returns
// the import list with intermediates replaced by their merged output.
// Groups by [videoId]: when a final merged file already exists for an id,
// its intermediates are dropped (yt-dlp leftovers, never imported as
// silent videos). When only intermediates exist, the largest video stream
// + the audio stream are merged to "<prefix> [id].mp4" (stream-copy video,
// AAC audio). Failures keep the original list — a silent import beats no
// import, and the failure is logged.
// Merge one video-only stream + one audio stream into a single mp4
// (video stream-copied, audio re-encoded to AAC). Resolves when the output
// exists and is non-empty; rejects with the ffmpeg tail otherwise. Shared
// by the download-time intermediate merge and the silent-import repair.
function mergeVideoAudio(ffmpegBin, videoPath, audioPath, outPath) {
	return new Promise((resolveMerge, rejectMerge) => {
		try {
			const { spawn } = require("child_process");
			const child = spawn(
				ffmpegBin,
				[
					"-y",
					"-i",
					videoPath,
					"-i",
					audioPath,
					"-c:v",
					"copy",
					"-c:a",
					"aac",
					"-shortest",
					outPath,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let errText = "";
			try {
				child.stderr.on("data", (d) => {
					errText += String(d);
					if (errText.length > 2000) errText = errText.slice(-2000);
				});
			} catch {
				/* ignore */
			}
			const timer = setTimeout(
				() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already exited */
					}
					rejectMerge(new Error("ffmpeg merge timed out"));
				},
				1000 * 60 * 20,
			);
			child.on("error", (err) => {
				clearTimeout(timer);
				rejectMerge(err);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					rejectMerge(new Error(`ffmpeg exit ${code}: ${errText.slice(-300)}`));
					return;
				}
				try {
					if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
						resolveMerge();
					} else {
						rejectMerge(new Error("merge produced no output"));
					}
				} catch (err) {
					rejectMerge(err);
				}
			});
		} catch (err) {
			rejectMerge(err);
		}
	});
}

async function mergeYoutubeIntermediates(destDir, files) {
	const byId = new Map();
	for (const f of files) {
		const id = youtube.videoIdFromFilename(f);
		if (!id) continue;
		if (!byId.has(id)) byId.set(id, []);
		byId.get(id).push(f);
	}
	if (byId.size === 0) return files;
	let ffmpeg;
	try {
		ffmpeg = resolveYtDlpFfmpegLocation();
		if (ffmpeg && !fs.existsSync(ffmpeg)) ffmpeg = null;
	} catch {
		ffmpeg = null;
	}
	const out = [];
	let mergedAny = false;
	for (const [id, group] of byId) {
		const finals = group.filter((f) => !youtube.isIntermediateStreamFile(f));
		if (finals.length > 0) {
			// Merged output exists — drop the intermediates for this id.
			out.push(...finals);
			continue;
		}
		// Only intermediates: pick the video + audio streams.
		const videos = group
			.filter((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f))
			.sort((a, b) => {
				try {
					return fs.statSync(b).size - fs.statSync(a).size;
				} catch {
					return 0;
				}
			});
		let audios = [];
		try {
			for (const entry of fs.readdirSync(destDir)) {
				if (!/\.(m4a|opus|mp3|aac|webm)$/i.test(entry)) continue;
				if (!entry.includes(`[${id}]`)) continue;
				const full = path.join(destDir, entry);
				try {
					if (fs.statSync(full).isFile()) audios.push(full);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* destDir unreadable */
		}
		audios = audios.sort((a, b) => {
			try {
				return fs.statSync(b).size - fs.statSync(a).size;
			} catch {
				return 0;
			}
		});
		const video = videos[0];
		const audio = audios[0];
		if (!video || !audio || !ffmpeg) {
			out.push(...group);
			continue;
		}
		const mergedName = path
			.basename(video)
			.replace(/\.f\d+[^.]*(\.[^.]+)$/, "$1");
		const finalName =
			mergedName === path.basename(video)
				? path.basename(video).replace(/\.[^.]+$/, ".mp4")
				: mergedName;
		const mergedPath = path.join(destDir, finalName);
		try {
			if (!fs.existsSync(mergedPath) || fs.statSync(mergedPath).size === 0) {
				await mergeVideoAudio(ffmpeg, video, audio, mergedPath);
				console.log(
					`[youtube] merged intermediates for [${id}] → ${finalName}`,
				);
			}
			out.push(mergedPath);
			mergedAny = true;
			// Remove the video-only intermediate so a later job never
			// imports the silent stream by mistake (audio + info stay).
			for (const f of group) {
				if (f === mergedPath) continue;
				if (/\.f\d+[^.]*\.(mp4|mkv|webm|mov|m4v)$/i.test(path.basename(f))) {
					try {
						fs.unlinkSync(f);
					} catch {
						/* best-effort */
					}
				}
			}
		} catch (err) {
			console.warn(`[youtube] merge failed for [${id}]: ${err.message}`);
			out.push(...group);
		}
	}
	// Files without a parsable [id] pass through untouched.
	for (const f of files) {
		if (!youtube.videoIdFromFilename(f)) out.push(f);
	}
	return mergedAny ? [...new Set(out)].sort() : files;
}

// Backfill youtube.json for videos downloaded before the metadata fix
// (or imported while the record step missed the .info.json sibling).
// Scans staging *.info.json files, matches each id against library
// filenames containing "[id]", and records { filename, channel, ... }.
// Runs at startup and lazily on youtube-files; returns the repair count.
function backfillYoutubeMeta() {
	let repaired = 0;
	try {
		const destDir = youtube.stagingDir();
		const meta = youtube.loadYoutubeMeta();
		const knownFilenames = new Set(
			Object.values(meta).map((v) => v && v.filename),
		);
		let infos = [];
		try {
			infos = fs.readdirSync(destDir).filter((e) => e.endsWith(".info.json"));
		} catch {
			return 0;
		}
		let lib = null;
		try {
			lib = loadLibrary();
		} catch {
			lib = null;
		}
		const libFilenames = (lib && lib.filenames) || [];
		for (const entry of infos) {
			let info = null;
			try {
				info = JSON.parse(fs.readFileSync(path.join(destDir, entry), "utf-8"));
			} catch {
				continue;
			}
			if (!info || !info.id) continue;
			const id = String(info.id);
			if (meta[id]) continue;
			const needle = `[${id}]`;
			const match =
				libFilenames.find((n) => String(n).includes(needle)) ||
				[...knownFilenames].find((n) => String(n).includes(needle));
			// Fall back to the merged output name even when the library row
			// still carries the old .fXXX intermediate filename.
			let filename = match || null;
			if (!filename) {
				try {
					const candidates = fs
						.readdirSync(destDir)
						.filter((e) => e.includes(needle));
					const merged = candidates.find(
						(e) =>
							/\.(mp4|mkv|webm|mov|m4v)$/i.test(e) &&
							!youtube.isIntermediateStreamFile(e),
					);
					if (merged) filename = merged;
				} catch {
					/* ignore */
				}
			}
			if (!filename) continue;
			// Only record rows that actually exist in the library (or are
			// the merged staging output waiting for import) — never ghosts.
			const inLibrary = libFilenames.includes(filename);
			let stagingExists = false;
			try {
				stagingExists = fs.existsSync(path.join(destDir, filename));
			} catch {
				/* ignore */
			}
			if (!inLibrary && !stagingExists) continue;
			youtube.recordYoutubeFile({
				videoId: id,
				filename,
				channel: info.uploader || info.channel || null,
				pageUrl: info.webpage_url || null,
				title: info.title || null,
			});
			repaired++;
		}
		if (repaired > 0) {
			console.log(
				`[youtube] backfilled ${repaired} video(s) into youtube.json`,
			);
		}
	} catch (err) {
		console.warn(`[youtube] backfill failed: ${err.message}`);
	}
	return repaired;
}

// Repair YouTube library rows imported as silent video-only files (the
// pre-fix downloads that never merged: .fXXX.mp4 with no audio stream, so
// transcription recorded zero chunks and dialogue search is empty for
// them). For each youtube.json row whose library file has no audio:
//   - staging audio present  → merge (stream-copy video + AAC) into a temp
//     file, verify it has audio, then replace the library file IN PLACE
//     (same filename, so index/embeddings/segments stay aligned) and drop
//     the empty transcript row so backfillTranscription re-queues it;
//   - staging audio gone     → clear the id from .yt-dlp-archive.txt so one
//     URL re-paste re-downloads fresh (merging correctly now).
// Only youtube.json rows are ever touched — user photos are out of scope —
// and any merge/verify failure keeps the original file. Idempotent: a
// repaired file has audio and is skipped on the next launch. Runs at
// startup after backfillYoutubeMeta, before backfillTranscription.
async function repairSilentYoutubeImports() {
	const result = { repaired: 0, clearedForRedownload: 0 };
	try {
		const destDir = youtube.stagingDir();
		const meta = youtube.loadYoutubeMeta();
		const ids = Object.keys(meta);
		if (ids.length === 0) return result;
		const lib = loadLibrary();
		const libSet = new Set(lib.filenames || []);
		let ffmpegBin = null;
		try {
			ffmpegBin = resolveYtDlpFfmpegLocation();
			if (ffmpegBin && !fs.existsSync(ffmpegBin)) ffmpegBin = null;
		} catch {
			ffmpegBin = null;
		}
		let probeHasAudio = null;
		try {
			probeHasAudio = require("./indexer/video-utils.js").probeHasAudio || null;
		} catch {
			probeHasAudio = null;
		}
		if (!ffmpegBin || !probeHasAudio) return result;
		for (const id of ids) {
			const row = meta[id];
			const filename =
				row && typeof row.filename === "string" ? row.filename : null;
			if (!filename || !libSet.has(filename)) continue;
			const libPath = path.join(PHOTOS_DIR, filename);
			let hasAudio = false;
			try {
				hasAudio = await probeHasAudio(ffmpegBin, libPath);
			} catch {
				continue;
			}
			if (hasAudio) continue;
			// Silent YouTube import — find the staging audio for this id.
			let audio = null;
			try {
				const candidates = [];
				for (const entry of fs.readdirSync(destDir)) {
					if (!/\.(m4a|opus|mp3|aac|webm)$/i.test(entry)) continue;
					if (!entry.includes(`[${id}]`)) continue;
					const full = path.join(destDir, entry);
					try {
						if (fs.statSync(full).isFile()) candidates.push(full);
					} catch {
						/* ignore */
					}
				}
				candidates.sort((a, b) => {
					try {
						return fs.statSync(b).size - fs.statSync(a).size;
					} catch {
						return 0;
					}
				});
				audio = candidates[0] || null;
			} catch {
				audio = null;
			}
			if (!audio) {
				// No audio left to merge with — clear the archive line so a
				// re-paste of the URL re-downloads instead of archive-skipping.
				try {
					const archiveFile = youtube.archiveFileFor(destDir);
					const raw = fs.readFileSync(archiveFile, "utf-8");
					const kept = raw
						.split("\n")
						.filter((line) => line.trim() !== "" && !line.includes(id));
					const dropped = raw.split("\n").length - kept.length;
					if (dropped > 0) {
						fs.writeFileSync(archiveFile, kept.join("\n") + "\n");
						result.clearedForRedownload++;
						console.log(
							`[youtube] no staging audio for [${id}] — archive cleared, re-paste the URL to re-download`,
						);
					}
				} catch {
					/* archive missing/unreadable — nothing to clear */
				}
				continue;
			}
			try {
				const tmpOut = path.join(destDir, `.repair-${id}-${Date.now()}.mp4`);
				await mergeVideoAudio(ffmpegBin, libPath, audio, tmpOut);
				let mergedHasAudio = false;
				try {
					mergedHasAudio = await probeHasAudio(ffmpegBin, tmpOut);
				} catch {
					mergedHasAudio = false;
				}
				if (!mergedHasAudio) {
					try {
						fs.unlinkSync(tmpOut);
					} catch {
						/* best-effort */
					}
					console.warn(
						`[youtube] repair merge for [${id}] has no audio — keeping original`,
					);
					continue;
				}
				fs.renameSync(tmpOut, libPath);
				// Drop the poisoned empty transcript row so the transcription
				// backfill re-queues this file (same boot, real audio now).
				try {
					const c = loadTranscripts(loadLibrary().modelId);
					if (c && c.videos instanceof Map) c.videos.delete(filename);
					if (c && c.utterances instanceof Map) c.utterances.delete(filename);
					if (c && c.progress && typeof c.progress === "object")
						delete c.progress[filename];
					saveTranscripts();
				} catch {
					/* transcript reset is best-effort; backfill still skips empty rows only when present */
				}
				result.repaired++;
				console.log(`[youtube] repaired silent import [${id}] → ${filename}`);
			} catch (err) {
				console.warn(`[youtube] repair failed for [${id}]: ${err.message}`);
			}
		}
		if (result.repaired > 0 || result.clearedForRedownload > 0) {
			console.log(
				`[youtube] silent-import repair: ${result.repaired} merged, ${result.clearedForRedownload} cleared for re-download`,
			);
		}
	} catch (err) {
		console.warn(`[youtube] silent-import repair failed: ${err.message}`);
	}
	return result;
}

function runYoutubeJob({ kind, url }) {
	return new Promise((resolve) => {
		let cfg;
		try {
			cfg = youtube.readYoutubeConfig(readSettings);
		} catch {
			cfg = youtube.parseYoutubeConfig(null);
		}
		let destDir = null;
		try {
			destDir = youtube.stagingDir();
			fs.mkdirSync(destDir, { recursive: true });
		} catch (err) {
			resolve({ ok: false, error: `staging mkdir: ${err.message}` });
			return;
		}
		const archiveFile = youtube.archiveFileFor(destDir);
		const ffmpegLocation = resolveYtDlpFfmpegLocation();
		// Channels and playlists are both multi-item feeds (list argv);
		// only single videos take the --no-playlist path.
		const args =
			kind === "video"
				? youtube.buildVideoArgs({
						url,
						destDir,
						quality: cfg.quality,
						archiveFile,
						ffmpegLocation,
					})
				: youtube.buildListArgs({
						url,
						destDir,
						quality: cfg.quality,
						archiveFile,
						max: cfg.maxPerChannel,
						ffmpegLocation,
					});
		const before = snapshotStagingFiles(destDir);
		const bin = resolveYtDlpBinary();
		let child = null;
		try {
			const { spawn } = require("child_process");
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({
				ok: false,
				error:
					err.code === "ENOENT"
						? "yt-dlp not installed"
						: String(err.message || err),
			});
			return;
		}
		let tail = "";
		const onData = (d) => {
			tail += String(d);
			if (tail.length > 8000) tail = tail.slice(-8000);
		};
		try {
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
		} catch {
			/* ignore */
		}
		const timer = setTimeout(
			() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already exited */
				}
			},
			1000 * 60 * 60,
		); // 1h hard cap per job
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				error:
					err.code === "ENOENT"
						? "yt-dlp not installed"
						: String(err.message || err),
			});
		});
		child.on("close", async (code) => {
			clearTimeout(timer);
			let files = newStagingFiles(destDir, before);
			if (code !== 0 && files.length === 0) {
				const hint = tail.trim().split("\n").slice(-3).join(" ").slice(0, 300);
				resolve({ ok: false, error: hint || `yt-dlp exit ${code}` });
				return;
			}
			if (files.length === 0) {
				// Archive-skipped (already downloaded) is a success with no files.
				resolve({ ok: true, files: [] });
				return;
			}
			// Merge fallback: if yt-dlp left unmerged .fXXX intermediates
			// (no ffmpeg at download time), merge each video+audio pair now
			// with the bundled ffmpeg before importing — otherwise the
			// library gets a silent video-only file with zero transcript.
			try {
				const merged = await mergeYoutubeIntermediates(destDir, files);
				if (merged && merged.length > 0) files = merged;
			} catch (err) {
				console.warn(`[youtube] intermediate merge failed: ${err.message}`);
			}
			try {
				const res = await importPaths(files);
				// Record videoId metadata from sibling .info.json files
				// (handles both merged and .fXXX intermediate shapes).
				for (const f of files) {
					try {
						const infoPath = youtube.findInfoJsonFor(f, destDir);
						if (!infoPath) continue;
						const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
						if (info && info.id) {
							const lib = loadLibrary();
							const idx = lib.sources
								? lib.sources.findIndex((s) => s === f)
								: -1;
							const filename = idx >= 0 ? lib.filenames[idx] : path.basename(f);
							youtube.recordYoutubeFile({
								videoId: String(info.id),
								filename,
								channel: info.uploader || info.channel || null,
								pageUrl: info.webpage_url || url,
								title: info.title || null,
							});
						}
					} catch {
						/* metadata is best-effort */
					}
				}
				resolve({ ok: true, files, imported: res });
			} catch (err) {
				resolve({ ok: false, error: String(err.message || err), files });
			}
		});
	});
}

function ensureYoutubePollTimer() {
	if (youtubePollTimer) return;
	let cfg;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		return;
	}
	if (!cfg.enabled || cfg.channels.length === 0) return;
	const ms = Math.max(1, cfg.pollHours) * 3600 * 1000;
	youtubePollTimer = setInterval(() => {
		try {
			const c = youtube.readYoutubeConfig(readSettings);
			if (!c.enabled) return;
			for (const ch of c.channels) {
				enqueueYoutubeJob(
					ch.kind === "playlist" ? "playlist" : "channel",
					ch.url,
					ch.label,
				);
			}
			const next = youtube.parseYoutubeConfig({ ...c });
			next.channels = c.channels.map((ch) => ({
				...ch,
				lastSync: new Date().toISOString(),
			}));
			writeSettings({ youtube: next });
		} catch {
			/* polling must never throw */
		}
	}, ms);
	if (youtubePollTimer.unref) youtubePollTimer.unref();
}

ipcMain.handle("memories:youtube-status", () => youtubeStatus());

ipcMain.handle("memories:youtube-ensure-binary", async () => {
	if (youtubeBinaryReady()) return { ok: true, skipped: true };
	let cfg;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		cfg = youtube.parseYoutubeConfig(null);
	}
	const res = await downloadYtDlpBinary(cfg.ytDlpVersion);
	youtubeBroadcast();
	return res;
});

ipcMain.handle("memories:youtube-add", async (_event, payload) => {
	const rawUrl =
		(payload && (payload.url || payload.channel || payload.input)) || payload;
	const parsed = youtube.parseYouTubeInput(
		typeof rawUrl === "string" ? rawUrl : "",
	);
	if (parsed.kind !== "channel" && parsed.kind !== "playlist") {
		return { ok: false, error: "not a channel or playlist URL" };
	}
	let cfg = youtube.readYoutubeConfig(readSettings);
	if (cfg.channels.some((c) => c.url === parsed.url)) {
		return { ok: true, skipped: true, channels: cfg.channels };
	}
	const label =
		payload && typeof payload.label === "string" && payload.label.trim()
			? payload.label.trim().slice(0, 120)
			: parsed.url;
	const next = youtube.parseYoutubeConfig({
		...cfg,
		channels: [
			...cfg.channels,
			{ url: parsed.url, kind: parsed.kind, label, lastSync: null },
		],
	});
	writeSettings({ youtube: next });
	enqueueYoutubeJob(parsed.kind, parsed.url, label);
	ensureYoutubePollTimer();
	return { ok: true, channels: next.channels };
});

ipcMain.handle("memories:youtube-remove", async (_event, url) => {
	const target = typeof url === "string" ? url : url && url.url;
	if (!target) return { ok: false };
	let cfg = youtube.readYoutubeConfig(readSettings);
	const next = youtube.parseYoutubeConfig({
		...cfg,
		channels: cfg.channels.filter((c) => c.url !== target),
	});
	writeSettings({ youtube: next });
	return { ok: true, channels: next.channels };
});

ipcMain.handle("memories:youtube-download", async (_event, payload) => {
	const rawUrl = (payload && (payload.url || payload.input)) || payload;
	const str = typeof rawUrl === "string" ? rawUrl : "";
	const parsed = youtube.parseYouTubeInput(str);
	if (parsed.kind !== "video") {
		// Channel/playlist URLs route to the subscription path (sync now).
		if (parsed.kind === "channel" || parsed.kind === "playlist") {
			const job = enqueueYoutubeJob(parsed.kind, parsed.url, parsed.url);
			return { ok: true, jobId: job.jobId };
		}
		return { ok: false, error: "not a YouTube video URL" };
	}
	const job = enqueueYoutubeJob("video", parsed.url, parsed.url);
	return { ok: true, jobId: job.jobId };
});

ipcMain.handle("memories:youtube-set-config", async (_event, patch) => {
	const cur = youtube.readYoutubeConfig(readSettings);
	const next = youtube.parseYoutubeConfig({
		...cur,
		...(patch && typeof patch === "object" ? patch : {}),
	});
	writeSettings({ youtube: next });
	ensureYoutubePollTimer();
	youtubeBroadcast();
	return { ok: true, config: next };
});

ipcMain.handle("memories:youtube-files", async () => {
	try {
		// Lazily repair youtube.json for downloads that landed before the
		// metadata fix — otherwise the YouTube tab filters to an empty set
		// even though the videos are indexed in the library.
		try {
			backfillYoutubeMeta();
		} catch {
			/* best-effort */
		}
		const meta = youtube.loadYoutubeMeta();
		return { ok: true, files: youtube.youtubeFilenames(), meta };
	} catch (err) {
		return { ok: false, error: String(err.message || err) };
	}
});

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
	function quitSmoke() {
		const code = process.exitCode ?? 0;
		void (async () => {
			try {
				await drainPersistQueue(60000);
			} catch {
				/* exit with the suite's code regardless */
			}
			app.exit(code);
		})();
	}
	app.whenReady().then(async () => {
		loadLibrary();
		// Remove library rows whose photo files no longer exist on disk
		// (manual deletion, crash mid-dedupe, unwatched folder). Runs
		// before backfills so ghost entries don't waste OCR/enrichment work.
		await pruneStaleLibraryEntries();
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
				await indexerReady;
				await migratePendingModel();
			} catch (err) {
				console.warn(
					`[memories] retired-model migration deferred: ${err.message}`,
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
				await indexerReady;
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
					`[memories] post-init maintenance skipped: ${err.message}`,
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
					await indexerReady;
					await syncWatchedFolders();
				} catch (err) {
					console.warn(
						`[memories] watched-folder sync skipped: ${err.message}`,
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
				await indexerReady;
				// Interrupted delta fill FIRST: a previous run may have quit
				// mid-tail, leaving zero rows under the active model. Resume
				// them before the scene backfills queue work against them.
				try {
					await maybeResumeDeltaFill();
				} catch (err) {
					console.warn(`[memories] delta fill resume skipped: ${err.message}`);
				}
				backfillEnrichment();
				// Removed-rung migration FIRST (before the stub-era repair):
				// settings/sidecars still naming small.en move to base.en and
				// the orphaned ~1GB weights are swept, so the backfill below
				// re-queues under a surviving engine.
				try {
					migrateRemovedWhisperModel();
				} catch (err) {
					console.warn(`[memories] whisper migration skipped: ${err.message}`);
				}
				// Stub-era repair FIRST: drops poisoned empty transcript
				// entries (recorded before whisper existed) for videos WITH
				// audio, so the backfill below actually re-queues them.
				try {
					await repairUntranscribedWithAudio();
				} catch (err) {
					console.warn(`[memories] transcript repair skipped: ${err.message}`);
				}
				backfillTranscription();
			} catch (err) {
				console.warn(`[memories] enrichment backfill skipped: ${err.message}`);
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
				console.warn(`[memories] OCR backfill skipped: ${err.message}`);
			}
		})();

		// Hash backfill: one-time background pass so pre-upgrade libraries
		// get content hashes (rename-duplicate detection).
		void (async () => {
			try {
				await backfillHashes();
			} catch (err) {
				console.warn(`[memories] hash backfill skipped: ${err.message}`);
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
					`[memories] screenshot-hint backfill skipped: ${err.message}`,
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

		// Headless smoke mode: ELECTRON_SMOKE=1 verifies boot + protocol +
		// renderer, then quits. With ELECTRON_SMOKE_E2E=1 it additionally
		// imports two generated test photos through the real import path and
		// checks that semantic queries rank the right one first.
		if (process.env.ELECTRON_SMOKE_REVEAL) {
			try {
				const { runRevealTest } = require("./scripts/e2e/reveal.js");
				await runRevealTest({ importPaths, resolveRevealTarget, PHOTOS_DIR });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_REIMPORT) {
			try {
				const { runReimportTest } = require("./scripts/e2e/reimport.js");
				await runReimportTest({ importPaths, loadLibrary });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_WATCHED) {
			try {
				const { runWatchedFoldersTest } = require("./scripts/e2e/watched.js");
				await runWatchedFoldersTest({
					importPaths,
					loadLibrary,
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
					isImportInFlight: () => importInFlight,
					setImportInFlight: (v) => {
						importInFlight = v;
					},
				});
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_FAILCACHE) {
			try {
				const { runFailureCacheTest } = require("./scripts/e2e/failcache.js");
				await runFailureCacheTest({
					importPaths,
					loadLibrary,
					stopWatchedFolderWatchers,
					FAILED_IMPORTS_FILE: failedImportsFile(),
				});
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_RENAMEDEDUPE) {
			try {
				const {
					runRenameDedupeTest,
				} = require("./scripts/e2e/renamededupe.js");
				await runRenameDedupeTest({
					importPaths,
					loadLibrary,
					stopWatchedFolderWatchers,
				});
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_YOUTUBE) {
			try {
				const { runYoutubeTest } = require("./scripts/e2e/youtube.js");
				await runYoutubeTest({
					importPaths,
					loadLibrary,
					youtube,
					mergeYoutubeIntermediates,
					backfillYoutubeMeta,
					repairSilentYoutubeImports,
					resolveYtDlpFfmpegLocation,
					runYoutubeJob,
					PHOTOS_DIR,
				});
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_OCR_HIGHLIGHT) {
			try {
				const {
					runOcrHighlightProbe,
				} = require("./scripts/e2e/ocr-highlight.js");
				await runOcrHighlightProbe({ win, app });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_UI_REVIEW) {
			try {
				const { runUiReview } = require("./scripts/e2e/ui-review.js");
				await runUiReview({ win, app, loadLibrary, resetLibraryCaches });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[ui-review] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_SEARCH_MATRIX) {
			try {
				const {
					runSearchMatrixProbe,
				} = require("./scripts/e2e/search-matrix.js");
				await runSearchMatrixProbe({ win });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_PERF) {
			try {
				console.log("[perf] starting");
				const { runPerfTest } = require("./test/perf-test.js");
				await runPerfTest({
					win,
					app,
					loadLibrary,
					importPaths,
					askIndexer,
					binInfo,
					loadSegments,
					thresholdsFor,
					calibrateThresholds,
				});
				console.log("[perf] OK");
			} catch (err) {
				console.error("[perf] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_GRID) {
			try {
				console.log("[grid] starting");
				const { runPerfGridTest } = require("./test/perf-grid.test.js");
				await runPerfGridTest({ win, app, loadLibrary });
				console.log("[grid] OK");
			} catch (err) {
				console.error("[grid] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_MIGRATE) {
			try {
				const { runMigrateTest } = require("./scripts/e2e/migrate.js");
				await runMigrateTest({
					getModel,
					app,
					importPaths,
					loadLibrary,
					askIndexer,
					cosine,
					reembedToModel,
					migrationSettled,
					binInfo,
					thresholdsFor,
					modelDownloaded,
					embedFileFor,
					preloadAllModels,
				});
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE_ASK) {
			try {
				console.log("[ask-e2e] starting");
				const { runAskTest } = require("./scripts/e2e/ask.js");
				await runAskTest({ win, app });
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[ask-e2e] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
			return;
		}

		if (process.env.ELECTRON_SMOKE === "1") {
			try {
				console.log("[smoke] step: title");
				const title = await win.webContents.executeJavaScript("document.title");
				console.log("[smoke] step: list");
				const list = await win.webContents.executeJavaScript(
					"fetch('/memories-index.json').then(r => r.json()).then(j => j.images.length)",
				);
				console.log("[smoke] step: photo");
				const photos = await win.webContents.executeJavaScript(
					"fetch('/images/projects/nope.jpg').then(r => r.status)",
				);
				console.log(
					`[smoke] title=${title} libraryImages=${list} missingPhotoStatus=${photos}`,
				);

				// Modes are mutually exclusive (each expects a specific library
				// state; PHASE4 assumes a drained enrichment queue at start).
				if (process.env.ELECTRON_SMOKE_E2E === "1") {
					console.log("[e2e] starting");
					const { runE2E } = require("./scripts/e2e/e2e.js");
					await runE2E({
						cold: process.env.ELECTRON_SMOKE_COLD === "1",
						app,
						BrowserWindow,
						importPaths,
						loadLibrary,
						askIndexer,
						cosine,
						VIDEO_EXTENSIONS,
						segmentsBinFileFor,
						segmentsMetaFileFor,
						getEnrichEventsObserved: () => enrichEventsObserved,
						getEnrichQueue: () => enrichQueue,
					});
				} else if (process.env.ELECTRON_SMOKE_PHASE4 === "1") {
					console.log("[phase4] starting");
					const { runPhase4DeepTest } = require("./scripts/e2e/phase4.js");
					await runPhase4DeepTest({
						app,
						BrowserWindow,
						importPaths,
						loadLibrary,
						loadSegments,
						readVideoQuality,
						writeSettings,
						removeLibraryRow,
						saveLibrary,
						backfillEnrichment,
						reembedToModel,
						migrationSettled,
						suspectedTruncatedVideos,
						segmentsBinFileFor,
						segmentsMetaFileFor,
						POSTERS_DIR,
						PHOTOS_DIR,
						enrichPhaseCounts,
						getEnrichQueue: () => enrichQueue,
						getEnrichEventsObserved: () => enrichEventsObserved,
						getEnrichProgressViolations: () => enrichProgressViolations,
					});
				} else if (process.env.ELECTRON_SMOKE_DEEP === "1") {
					console.log("[deep] starting");
					const { runDeepTest } = require("./test/deep-test.js");
					await runDeepTest({
						win,
						app,
						loadLibrary,
						importPaths,
						askIndexer,
						binInfo,
						thresholdsFor,
						calibrateThresholds,
						healPhraseBin,
						loadSegments,
						phraseFileFor,
						PHOTOS_DIR,
						POSTERS_DIR,
						getOcrState: () => ({
							queue: ocrQueue.length,
							inFlight: ocrInFlight,
						}),
						getEnrichQueue: () => enrichQueue.length,
					});
				} else if (process.env.ELECTRON_SMOKE_CTO === "1") {
					console.log("[cto] starting");
					const { runCtoFixesTest } = require("./test/cto-fixes-test.js");
					await runCtoFixesTest({
						win,
						app,
						fs,
						path,
						DEFAULT_MODEL_ID,
						loadLibrary,
						resetLibraryCache: resetLibraryCaches,
						pruneStaleLibraryEntries,
						readBin,
						saveLibrary,
						saveSegments,
						loadSegments,
						libraryIndex,
						rankSearch,
						embedFileFor,
						phraseFileFor,
						segmentsBinFileFor,
						segmentsMetaFileFor,
						PHOTOS_DIR,
						DATA_DIR,
						INDEX_FILE,
						getWebPreferences: () => WEB_PREFERENCES,
					});
				} else if (process.env.ELECTRON_SMOKE_SCENENOISE === "1") {
					console.log("[scenenoise] starting");
					const { runSceneNoiseTest } = require("./test/scene-noise-test.js");
					await runSceneNoiseTest({
						win,
						loadLibrary,
						importPaths,
						loadSegments,
						getEnrichQueue: () => enrichQueue.length,
					});
				}
				console.log("[smoke] OK");
			} catch (err) {
				console.error("[smoke] FAILED:", err);
				process.exitCode = 1;
			}
			quitSmoke();
		}

		app.on("activate", () => {
			const wins = BrowserWindow.getAllWindows();
			if (wins.length === 0) {
				mainWindowRef = createWindow();
				void mainWindowRef.loadURL(`${SCHEME}://localhost/`);
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
		if (transcribeWorker) {
			requestWorkerKillFfmpeg(
				transcribeWorker,
				transcribeFfmpegPids,
				"will-quit",
			);
		} else {
			killTrackedFfmpegPids(transcribeFfmpegPids, "will-quit-no-worker");
		}
		killTrackedFfmpegPids(indexerFfmpegPids, "will-quit-sweep");
		// Preview transcodes run in the MAIN process (tracked in this
		// process's own video-utils registry, not a worker's) — sweep them
		// here too so a quit mid-transcode cannot orphan ffmpeg either.
		try {
			require("./indexer/video-utils.js").killAllFfmpeg("will-quit-main");
		} catch {
			/* best-effort */
		}
		if (ocrWorker) {
			try {
				// OCR worker hosts tesseract, not ffmpeg — plain kill is enough.
				if (ocrWorker.process) ocrWorker.process.kill();
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
			if (transcribeWorker && transcribeWorker.process) {
				transcribeWorker.process.kill();
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
