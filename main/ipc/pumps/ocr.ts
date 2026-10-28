// Phase 1 (pumps/ocr): pure move from main.js (2026-10-10) — OCR text
// extraction queue (worker, gates, pump, backfill, requeue, progress).
// No behavior change: same pacing, checkpoints, language migration,
// drain summaries. Shared refs still owned by main.js arrive via
// main/context.js and are read AT CALL TIME: isBackgroundPaused /
// getPurgeEpoch / isImportInFlight / getMigrationState (existing slots),
// isEnrichPendingQuery / isTranscribePendingQuery (assigned by the enrich /
// transcribe modules), updateTrayState / libraryHasRow / isVideo / photosDir
// (existing slots). Own state is exported below for the stayers
// (import/tray/purge/drop/lang-switch/reanalyze/will-quit). This module
// never requires main.js (no cycle).
import fs from "node:fs";
import path from "node:path";
import { utilityProcess, BrowserWindow, app } from "electron";
import { handle } from "../../ipc-wrapper.ts";
import ctx from "../../context.ts";
import { isJobDead } from "./enrich.ts";
import { probeScreenshotMetadata } from "../../../screenshot-probe.ts";
import { loadLibrary, saveLibrary } from "../../../main-lib/library-store.ts";
import {
	resolveOcrLangString,
	readOcrLangsMigrated,
	shouldMigrateOcrLangs,
	writeSettings,
} from "../../../main-lib/settings.ts";
import type { OcrOutbound } from "../../../shared/worker-messages.ts";

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

// The dedicated OCR worker: `process` is the UtilityProcess, `dead` is set
// by the exit handler before the pump respawns.
interface OcrWorkerHandle {
	process: Electron.UtilityProcess | null;
	dead: boolean;
}
// One in-flight askOcr request; the timer rejects on timeout.
interface OcrPendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
	timer: NodeJS.Timeout;
}
// The reply shape pumpOcr consumes (validated there before commits).
interface OcrReply {
	ok?: boolean;
	text?: string;
	words?: Array<{ text?: unknown }>;
}

const ocrQueue: string[] = []; // filenames (photos only — videos are scene-searchable)

let ocrInFlight = false;
// Purge generation captured for the in-flight photo — mirrors
// job.purgeEpoch on the enrich/transcribe pumps (OCR jobs are bare
// strings, so the epoch rides alongside the flag instead of the job).
let ocrInFlightEpoch = 0;
let ocrPendingQuery = false;
let ocrTimer: NodeJS.Timeout | null = null;
let lastOcrStart = 0;
let ocrSinceCheckpoint = 0;
// One OCR worker at a time (tesseract holds a ~100MB traineddata + wasm
// core; a pool would multiply memory for zero throughput gain — a single
// worker saturates the CPU it runs on). Forked lazily on the first job of a
// drain, killed when the queue empties.
let ocrWorker: OcrWorkerHandle | null = null;
let ocrWorkerDead = false;
let ocrRequestId = 0;
let ocrPending = new Map<string, OcrPendingRequest>(); // id → { resolve, reject, timer }
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
let ocrFailedFiles: string[] = [];
let lastOcrFile: string | null = null;

function ocrDataDir() {
	return path.join(app.getPath("userData"), "ocr-data");
}

function broadcastOcrEvent(extra: {
	phase: string;
	filename?: string | null;
	done?: number;
	total?: number;
	pending?: number;
	failed?: number;
}) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "ocr", ...extra });
	}
	// Menu-bar tray icon follows background work (no-op when the mode is off).
	ctx.updateTrayState();
}

function ocrSnapshot() {
	const job = ocrInFlight ? ocrQueue[0] : null;
	return {
		type: "ocr",
		paused: ctx.isBackgroundPaused(),
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
		const p = path.join(ctx.photosDir, l.filenames[i] as string);
		if (!fs.existsSync(p)) {
			l.hashes[i] = null;
			continue;
		}
		try {
			l.hashes[i] = await ctx.hashFile(p);
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
		if (ctx.isVideo(l.filenames[i] as string)) {
			l.screenshotHints[i] = false;
			changed = true;
			continue;
		}
		try {
			l.screenshotHints[i] = await probeScreenshotMetadata(
				path.join(ctx.photosDir, l.filenames[i] as string),
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
	let currentLangs: string | null = null;
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
		if (!ctx.isVideo(name)) ocrPhotoCount++;
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
	const missing: string[] = [];
	for (let i = 0; i < l.filenames.length; i++) {
		if (ctx.isVideo(l.filenames[i] as string)) continue;
		const words = l.ocrWords ? l.ocrWords[i] : null;
		if (!words) {
			// Never OCR'd with geometry (pre-geometry row, failed pass).
			missing.push(l.filenames[i] as string);
			continue;
		}
		// INCONSISTENT row: searchable text exists but no word geometry
		// stands behind it. This is the raw-fallback signature — an older
		// pass hit tesseract's no-blocks path, whose cleanText branch keeps
		// UNFILTERED text while normalizeWords returns []. Such rows rank
		// in the OCR tab but can never draw a highlight box. Re-OCR them;
		// genuinely-empty rows (no text AND no words) stay skipped, so a
		// text-free photo is never retried forever.
		const text = l.ocr[i];
		if (words.length === 0 && typeof text === "string" && text.length > 0) {
			missing.push(l.filenames[i] as string);
		}
	}
	if (missing.length > 0) {
		console.log(
			`[memories] OCR backfill: ${missing.length} photo(s) missing word geometry`,
		);
		enqueueOcr(missing);
	}
}

function enqueueOcr(files: string[], options?: { force?: boolean }) {
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
			if (words && words.length > 0) continue;
			const text = l.ocr[idx];
			if (
				words &&
				words.length === 0 &&
				!(typeof text === "string" && text.length > 0)
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
function requeueAllPhotosForOcr(reason: string) {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return 0;
	const photos = l.filenames.filter((name) => !ctx.isVideo(name));
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
		!ctx.isBackgroundPaused() &&
		!ocrInFlight &&
		!ctx.isImportInFlight() &&
		!ctx.getMigrationState() &&
		!ocrPendingQuery &&
		!ctx.isEnrichPendingQuery() &&
		!ctx.isTranscribePendingQuery() &&
		ocrQueue.length > 0 &&
		Date.now() - lastOcrStart >= OCR_GAP_MS
	);
}

// Fork the OCR worker if it isn't alive. Returns the worker object.
function ensureOcrWorker() {
	if (ocrWorker && !ocrWorkerDead) return ocrWorker;
	ocrWorkerDead = false;
	const worker: OcrWorkerHandle = {
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
	// The traineddata cache dir must exist before the worker starts:
	// tesseract.js writes it with a bare fs.writeFile (no mkdir) and
	// swallows the failure behind our no-op logger, so a missing dir meant
	// every worker start silently re-downloaded ~17MB from the CDN and
	// offline OCR never worked.
	fs.mkdirSync(ocrDataDir(), { recursive: true });
	worker.process = utilityProcess.fork(
		path.join(__dirname, "..", "..", "..", "indexer", "ocr-worker.js"),
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
		const msg = (
			event && event.data !== undefined ? event.data : event
		) as OcrOutbound;
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

function askOcr(filename: string): Promise<unknown> {
	const worker = ensureOcrWorker();
	return new Promise((resolve, reject) => {
		const id = `o${++ocrRequestId}`;
		const timer = setTimeout(() => {
			ocrPending.delete(id);
			reject(new Error("OCR request timed out"));
		}, 120000);
		ocrPending.set(id, { resolve, reject, timer });
		worker.process?.postMessage({
			type: "ocr-photo",
			id,
			path: path.join(ctx.photosDir, filename),
		});
	});
}

async function pumpOcr() {
	if (!ocrAllowed()) {
		if (ocrQueue.length > 0 && !ctx.isBackgroundPaused()) scheduleOcr();
		return;
	}
	// Bounds-proven: ocrAllowed() above requires a non-empty queue.
	const filename = ocrQueue[0] as string;
	// Row deleted while queued — drop without a tesseract run or a failed
	// entry in the drain summary.
	if (!ctx.libraryHasRow(filename)) {
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
	ocrInFlightEpoch = ctx.getPurgeEpoch();
	const ocrGen = ocrWorkerGeneration;
	lastOcrStart = Date.now();
	lastOcrFile = filename;
	try {
		const reply = (await askOcr(filename)) as OcrReply;
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
			ocrInFlightEpoch === ctx.getPurgeEpoch() &&
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
		} else if (cancelled || ocrInFlightEpoch !== ctx.getPurgeEpoch()) {
			// Purged or deleted mid-photo: the reply belongs to cancelled
			// work, not to a vanished row (that case stays silent as
			// before). The tail shift below drops the job either way.
			console.log(
				`[memories] OCR ${filename}: purged or deleted mid-flight — discarding reply`,
			);
		}
	} catch (err) {
		const e = err as { message?: string };
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
			console.warn(`[memories] OCR failed for ${filename}: ${e.message}`);
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
				const e = err as { message?: string };
				console.warn(
					`[memories] OCR migration marker write skipped: ${e.message}`,
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
			ocrWorker.process?.kill();
		} catch {
			/* already gone */
		}
	}
	ocrWorker = null;
	ocrWorkerDead = true;
	ocrWorkerGeneration++;
}

// Live accessors over module state for the stayers (purge, drop, will-quit,
// tray replays). In-place reads/writes only — identities never change.
const isOcrInFlight = () => ocrInFlight;
const setOcrInFlight = (v: boolean) => {
	ocrInFlight = v;
};
const isOcrPendingQuery = () => ocrPendingQuery;
const setOcrPendingQuery = (v: boolean) => {
	ocrPendingQuery = v;
};
const getOcrTimer = () => ocrTimer;
const setOcrTimer = (v: NodeJS.Timeout | null) => {
	ocrTimer = v;
};
const getOcrWorker = () => ocrWorker;
const setOcrTotalCount = (v: number) => {
	ocrTotalCount = v;
};
const setOcrDoneCount = (v: number) => {
	ocrDoneCount = v;
};
const getLastOcrFile = () => lastOcrFile;
const setLastOcrFile = (v: string | null) => {
	lastOcrFile = v;
};

export {
	ocrQueue,
	isOcrInFlight,
	setOcrInFlight,
	isOcrPendingQuery,
	setOcrPendingQuery,
	getOcrTimer,
	setOcrTimer,
	getOcrWorker,
	killOcrWorker,
	setOcrTotalCount,
	setOcrDoneCount,
	getLastOcrFile,
	setLastOcrFile,
	ocrSnapshot,
	broadcastOcrEvent,
	scheduleOcr,
	enqueueOcr,
	backfillOcr,
	backfillScreenshotHints,
	backfillHashes,
	requeueAllPhotosForOcr,
};

// Phase 1 (pump states): the tray-state IPC lives with its pump (moved
// from main.js — same one-line snapshot serve, no behavior change).
handle("memories:ocr-state", () => ocrSnapshot());
