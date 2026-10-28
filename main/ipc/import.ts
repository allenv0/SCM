// Phase 1 (import): pure move from main.js (2026-10-10) — import pipeline
// (scan/expand/hash/copy/importPaths), picker, import/pick/delete handlers,
// library rows (has/drop/remove). No behavior change: same dedupe, retries,
// checkpoints, tombstones. Shared refs still owned by main.js arrive via
// main/context.js and are read AT CALL TIME: spawnIndexer / getMigrationState
// / updateTrayState / isVideo / photosDir / dataDir (existing slots),
// importExtensions / videoExtensions (stable const Sets), generatePoster /
// posterFor (hoisted fns). Sibling domains are required directly (no cycle:
// none of them require import back): watched (addWatchedFolder), pumps
// (enqueue + drop-time state). Own fns needed by stayers (pickAndImport,
// importPaths, removeLibraryRow, row/progress helpers) are exported below;
// the pending flag + row/hash helpers backfill the shared slots.
import fs from "node:fs";
import path from "node:path";
// Module import (not the global): global `crypto` is absent on older
// Electron/node — the explicit module import is the same guarantee.
import crypto from "node:crypto";
import { dialog, BrowserWindow } from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import {
	loadLibrary,
	ensureLibraryBins,
	saveLibrary,
	removeSegmentsForAllModels,
	removeTranscriptsForAllModels,
	thumbFor,
} from "../../main-lib/library-store.ts";
import {
	isSystemIndexerError,
	rememberImportFailure,
	isKnownImportFailure,
	retireImportFailure,
} from "../../main-lib/failed-imports.ts";
import { probeScreenshotMetadata } from "../../screenshot-probe.ts";
import { sortPathsByMtime } from "../../indexer/import-order-utils.ts";
import { sniffImageMime, canonicalImageExt } from "../../indexer/mime-sniff.ts";
import { addWatchedFolder } from "./watched.ts";
import {
	enqueueEnrichment,
	enrichQueue,
	isEnrichInFlight,
	deadJobs,
	clearEnrichProgressFor,
	enrichSnapshot,
	broadcastEnrichEvent,
} from "./pumps/enrich.ts";
import {
	enqueueTranscription,
	transcribeQueue,
	isTranscribeInFlight,
	clearTranscribeProgressFor,
	transcribeSnapshot,
	broadcastTranscribeEvent,
} from "./pumps/transcribe.ts";
import {
	enqueueOcr,
	ocrQueue,
	isOcrInFlight,
	getLastOcrFile,
	setLastOcrFile,
	ocrSnapshot,
	broadcastOcrEvent,
} from "./pumps/ocr.ts";

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Recursively collect every supported media file under `dir`. Symlinked
// directories are skipped to avoid cycles; unreadable entries are ignored.
function scanDirForMedia(dir: string, out: string[] = []): string[] {
	let entries: fs.Dirent[];
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
					ctx.importExtensions.has(path.extname(entry.name).toLowerCase())
				) {
					out.push(full);
				}
			} catch {
				/* dangling symlink — ignore */
			}
		} else if (
			entry.isFile() &&
			ctx.importExtensions.has(path.extname(entry.name).toLowerCase())
		) {
			out.push(full);
		}
	}
	return out;
}

// Collapse a list of picked/dropped paths into importable files: directories
// expand to their media contents (recursive); plain files pass through so the
// per-file importer can still report unsupported ones.
function expandMediaPaths(paths: string[]) {
	const out: string[] = [];
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

function uniqueName(base: string, taken: Set<string>) {
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
function hashFile(
	file: string,
	{ stallMs = 30_000 }: { stallMs?: number } = {},
) {
	return new Promise<string>((resolve, reject) => {
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
	src: string,
	dst: string,
	{
		stallMs = 30_000,
		tickMs = 2_000,
	}: { stallMs?: number; tickMs?: number } = {},
) {
	return new Promise<void>((resolve, reject) => {
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

// C-01 Wave 2 (S2/S3): isSystemIndexerError live in main-lib/failed-imports.ts (imported above).

// C-01 Wave 2 (S2/S3): rememberImportFailure live in main-lib/failed-imports.ts (imported above).

// C-01 Wave 2 (S2/S3): isKnownImportFailure live in main-lib/failed-imports.ts (imported above).

// True while an import batch is running. The migration refuses to start
// while a batch is in flight (its rows would embed in the wrong model), and
// a second batch is refused too (uniqueName dedupe and the ordered flush
// assume one writer at a time).
let importInFlight = false;

// One file's pipeline outcome (processOne never throws — the ordered flush
// sees a row for every path).
type ImportOutcome =
	| { kind: "skipped"; filePath: string }
	| { kind: "error"; filename: string; dest: string | null; err: Error }
	| {
			kind: "added";
			filename: string;
			filePath: string;
			reply: { vec: ArrayLike<number>; phrase?: ArrayLike<number> | null };
			dest: string;
			hash: string;
			sourceMtime: number | null;
			screenshotHint: boolean | null;
	  };

// `fromWatch` marks a watched-folder sync (launch / poll / live fs event).
// The import-failure cache is only consulted for these: a manual re-import is
// the user explicitly asking for a fresh attempt, so it always runs.
async function importPaths(
	rawPaths: string[],
	{ fromWatch = false }: { fromWatch?: boolean } = {},
) {
	// A model migration re-embeds the whole library and pins the worker
	// pool to the target model. Rows imported mid-migration would be
	// embedded in the WRONG model — they'd land as target-model vectors in
	// a library that still names the old one (or misalign it when the flip
	// aborts). Refuse until it settles.
	if (ctx.getMigrationState()) {
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
	ctx.updateTrayState();
	let result;
	try {
		result = await importPathsInner(rawPaths, { fromWatch });
	} finally {
		importInFlight = false;
		ctx.updateTrayState();
	}
	// Hidden-window completion note (watched-folder syncs with nothing new
	// stay silent — only batches that actually added photos ping).
	if (result && Array.isArray(result.added) && result.added.length > 0) {
		const n = result.added.length;
		const errs = Array.isArray(result.errors) ? result.errors.length : 0;
		ctx.maybeNotify(
			"Import complete",
			`${n} photo${n === 1 ? "" : "s"} added to your library` +
				(errs > 0 ? ` (${errs} file${errs === 1 ? "" : "s"} failed)` : "") +
				".",
		);
	}
	return result;
}

async function importPathsInner(
	rawPaths: string[],
	{ fromWatch = false }: { fromWatch?: boolean } = {},
) {
	ctx.spawnIndexer();
	// Any path may be a directory (folder picker / folder drop): expand it to
	// the media files inside so the batch counter below counts real files.
	const paths = expandMediaPaths(rawPaths);

	// Auto-watch folders: any DIRECTORY in the batch joins the persisted
	// watch list (the expand above already flattened it to files — rawPaths
	// still name the folders). Individual files are imported once, never
	// watched. The newly-watched names ride the result so the renderer can
	// say "now watching …" without a separate round trip.
	const watchedNow: string[] = [];
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
	const skippedPaths = new Set<string>();
	const result: {
		added: string[];
		skipped: string[];
		errors: Array<{ file: string; error: string }>;
		watched: string[];
	} = { added: [], skipped: [], errors: [], watched: watchedNow };

	// A path listed twice in one drop must import once. The sequential loop
	// used to catch this at iteration time; the concurrent pipeline checks
	// the source set at dispatch, so identical paths are collapsed here —
	// the first occurrence wins and the rest are reported skipped.
	const seenPaths = new Set<string>();
	let uniquePaths: string[] = [];
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
	const posterJobs: Array<Promise<unknown>> = [];

	// Disk persistence is coalesced: a per-file save rewrites the whole
	// index trio (O(n²) total I/O over a batch) while nothing reads the disk
	// mid-batch — the renderer only reloads on library-updated (batch end).
	// Poster extractions each spawn ffmpeg; cap how many run at once so a
	// video-heavy batch cannot saturate the machine while it is off the
	// critical path. Failures are swallowed (the video stays searchable;
	// its tile falls back to the "missing media" placeholder).
	const POSTER_CONCURRENCY = 2;
	// Slot promises exist only to serialize; their resolved values are never
	// read (hence unknown).
	const posterSlots: Array<Promise<unknown>> = Array.from(
		{ length: POSTER_CONCURRENCY },
		() => Promise.resolve(),
	);
	let posterSlotIndex = 0;
	const pushPoster = (filename: string, make: () => Promise<string>) => {
		// Cast: slot is always in [0, POSTER_CONCURRENCY) — the array is
		// built with exactly that many entries.
		const slot = posterSlotIndex % POSTER_CONCURRENCY;
		posterSlotIndex++;
		const prev = posterSlots[slot] as Promise<unknown>;
		const run = prev.then(make).catch((err) => {
			console.warn(
				`[memories] poster failed for ${filename}: ${(err as { message?: string }).message}`,
			);
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
	const sendImport = (phase: string, filename: string) => {
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
	const pendingResults = new Map<number, ImportOutcome>();
	let next = 0;

	// Apply one file's outcome in order: add rows, checkpoint-save, or record
	// the skip/error. `done` doubles as the flush cursor — every path yields
	// exactly one outcome, so when done reaches total the batch is complete.
	const applyOutcome = (outcome: ImportOutcome) => {
		if (outcome.kind === "skipped") {
			skippedPaths.add(outcome.filePath);
			return;
		}
		if (outcome.kind === "error") {
			// The failure may predate the copy (validation, embed timeout);
			// unlink only what actually landed.
			try {
				if (outcome.dest) fs.unlinkSync(outcome.dest);
			} catch {
				/* never copied — nothing to clean up */
			}
			result.errors.push({
				file: outcome.filename,
				error: outcome.err.message,
			});
			return;
		}
		// Materialize the existing bin pair BEFORE changing filenames. The
		// lazy getter reads `filenames.length` as the expected row count; if
		// the push happened first, a healthy N-row bin would be read as
		// N+1 and discarded as misaligned.
		ensureLibraryBins();
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
			// Cast: the has() guard above proves the entry exists (get() does
			// not narrow).
			const outcome = pendingResults.get(done) as ImportOutcome;
			pendingResults.delete(done);
			applyOutcome(outcome);
			done++;
		}
	};

	// Process one file: validate, copy, then embed through the worker pool.
	// Always returns an outcome object (never throws) so the ordered flush
	// sees a row for every path.
	const processOne = async (seq: number): Promise<ImportOutcome> => {
		// Cast: seq < total always holds (the pump's dispatch bound).
		const filePath = uniquePaths[seq] as string;
		let dest: string | null = null;
		try {
			// A failed model load (broken weights / download failure) must
			// not copy+unlink every remaining file: report the rest and bail.
			// Getter hoisted to a local (plain reference read; tsc does not
			// narrow a fresh call's result from the guard).
			const initFailed = ctx.getIndexerInitFailed();
			if (initFailed) {
				return {
					kind: "error",
					filename: path.basename(filePath),
					dest,
					err: new Error(`AI indexing unavailable: ${initFailed.message}`),
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
			if (!ctx.importExtensions.has(ext)) {
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
			const isVideoFile = ctx.videoExtensions.has(ext);
			// Rename-proof Screenshots-tab signal: the file's own PNG/JPEG
			// text metadata ("Screenshot" in Software/UserComment) is read
			// straight from the source before the copy — a bounded read (see
			// screenshot-probe.js), so it never stalls the batch.
			const screenshotHint = isVideoFile
				? false
				: await probeScreenshotMetadata(filePath);
			let filename = uniqueName(path.basename(filePath), taken);
			dest = path.join(ctx.photosDir, filename);

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
							fs.renameSync(dest, path.join(ctx.photosDir, corrected));
							console.log(
								`[memories] normalized ${filename} → ${corrected} (content is ${sniffed})`,
							);
							filename = corrected;
							dest = path.join(ctx.photosDir, filename);
						} catch (err) {
							console.warn(
								`[memories] extension normalization failed for ${filename}: ${(err as { message?: string }).message}`,
							);
						}
					}
				}
			}
			sendImport("embedding", filename);
			// Cast: the embed reply rides the IndexerOutbound union; the vector
			// fields exist on the done members this ask produces (cast-once-
			// at-the-ask-site pattern — the `!reply.vec` guard below keeps the
			// "no vector" error path for a lying reply).
			const reply = (await ctx.askIndexer({
				type: isVideoFile ? "embed-video" : "embed-photo",
				path: dest,
				filename,
			})) as { vec: ArrayLike<number>; phrase?: ArrayLike<number> | null };
			if (!reply.vec) throw new Error("Embedding produced no vector");
			if (isVideoFile) {
				sendImport("poster", filename);
				// Poster generation never touches the index, so it runs
				// concurrently with the rest of the batch instead of
				// stalling the import loop; all jobs settle just before
				// the library-updated broadcast below.
				pushPoster(filename, () => ctx.generatePoster(dest as string));
			}
			return {
				kind: "added",
				filename,
				filePath,
				reply,
				dest: dest as string,
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
			return {
				kind: "error",
				filename: path.basename(filePath),
				dest,
				err: err as Error,
			};
		}
	};

	// Bounded-concurrency pump: keep a couple of files in flight per worker
	// so a slow video on one worker doesn't idle the others; each worker
	// serializes its own requests (see indexer.js). The batch completes when
	// every path has been dispatched AND every in-flight task has settled
	// (its outcome flushed) — a plain Promise.all over the first wave would
	// miss tasks launched later by pump().
	const BATCH_CONCURRENCY = Math.max(2, ctx.indexerPoolSize * 2);
	const inflight = new Set<Promise<void>>();
	// The executor assigns the real resolver synchronously; the noop keeps
	// the definite-assignment checker happy without changing behavior.
	let resolveBatch: () => void = () => {};
	const batchDone = new Promise<void>((r) => {
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
						filename: path.basename(uniquePaths[seq] as string),
						dest: null,
						err: err as Error,
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
				.filter((name) => ctx.isVideo(name))
				.map((name) => ({
					filename: name,
					path: path.join(ctx.photosDir, name),
				})),
		);
		// Speech transcription: same videos, queued behind visual
		// enrichment (transcribeAllowed serializes on enrich drain).
		enqueueTranscription(
			result.added
				.filter((name) => ctx.isVideo(name))
				.map((name) => ({
					filename: name,
					path: path.join(ctx.photosDir, name),
				})),
		);
		// OCR text extraction: new photos are recognized in the background
		// too (posters, screenshots — the visible text CLIP can't read).
		enqueueOcr(result.added.filter((name) => !ctx.isVideo(name)));
	}
	return result;
}

async function pickAndImport() {
	// Cast: getAllWindows()[0] is undefined only in headless smokes, where
	// the dialog never opens — the parent argument keeps its position.
	const win = BrowserWindow.getAllWindows()[0] as BrowserWindow;
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
handle("memories:import-paths", async (_event: unknown, paths: unknown) => {
	const list = Array.isArray(paths)
		? paths.filter((p) => typeof p === "string")
		: [];
	return importPaths(list);
});

handle("memories:pick", async () => pickAndImport());
// A row deleted mid-pipeline must stop being processed: without this, a
// deleted video's queued pump jobs keep running (burning the retry budget
// on a missing file), their late chunk replies resurrect sidecar entries
// for a row that no longer exists, and the tray keeps showing the deleted
// file. Queues hold {filename,...} jobs (enrich/transcribe) or bare
// filename strings (OCR).
function libraryHasRow(filename: string) {
	return loadLibrary().filenames.includes(filename);
}

function dropQueuedJobsFor(filename: string) {
	// Tombstone only when an in-flight chunk for this file survives below:
	// every pump's commit path consumes the entry on hit, so an entry with
	// no orphan behind it would linger and wrongly discard a future
	// re-queued job for the same filename. The head is left for the
	// orphan's own discard-shift — splicing it here would make that shift
	// evict a live successor, and the in-flight flags would misattribute
	// the tray to the next job until the orphan lands.
	const skipHead = (q: unknown[], flag: boolean) =>
		flag && q.length > 0 ? 1 : 0;
	const headSurvives =
		(isEnrichInFlight() && enrichQueue[0]?.filename === filename) ||
		(isTranscribeInFlight() && transcribeQueue[0]?.filename === filename) ||
		(isOcrInFlight() && ocrQueue[0] === filename);
	if (headSurvives) deadJobs.add(filename);
	for (const [q, flag] of [
		[enrichQueue, isEnrichInFlight()],
		[transcribeQueue, isTranscribeInFlight()],
	] as Array<[typeof enrichQueue, boolean]>) {
		for (let i = q.length - 1; i >= skipHead(q, flag); i--) {
			// Head read hoists to a local: the loop index is mutable, so the
			// guard does not narrow the element access (established pattern).
			const job = q[i] as { filename: string };
			if (job && job.filename === filename) q.splice(i, 1);
		}
	}
	for (
		let i = ocrQueue.length - 1;
		i >= skipHead(ocrQueue, isOcrInFlight());
		i--
	) {
		if (ocrQueue[i] === filename) ocrQueue.splice(i, 1);
	}
	clearEnrichProgressFor(filename);
	clearTranscribeProgressFor(filename);
	if (getLastOcrFile() === filename) setLastOcrFile(null);
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
function removeLibraryRow(filename: string) {
	const l = loadLibrary();
	// Load the N-row bin before the splice shrinks filenames; otherwise the
	// lazy ensure would read the bin as N-1 rows and lose the last vector.
	ensureLibraryBins();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return false;
	try {
		fs.unlinkSync(path.join(ctx.photosDir, filename));
	} catch {
		/* file already gone — the index row is what matters */
	}
	// Video posters are sidecars in POSTERS_DIR; sweep them too so no
	// orphaned thumbnail survives after the tile disappears.
	try {
		fs.unlinkSync(ctx.posterFor(filename));
	} catch {
		/* photo (no poster) or poster already gone */
	}
	// Scene posters (<stem>-scene-<i>.jpg) are sidecars of the same tile;
	// sweep them so no best-scene thumbnail outlives its video.
	try {
		const stem = path.basename(filename, path.extname(filename));
		for (const entry of fs.readdirSync(ctx.postersDir)) {
			if (entry.startsWith(`${stem}-scene-`) && entry.endsWith(".jpg")) {
				fs.unlinkSync(path.join(ctx.postersDir, entry));
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
handle("memories:delete", async (_event: unknown, filename: unknown) => {
	if (typeof filename !== "string" || !filename)
		return { ok: false, error: "Invalid filename" };
	if (!removeLibraryRow(filename))
		return { ok: false, error: "Memory not found in the library" };
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

// Live accessors over module state for the stayers (e2e isolation ctx,
// tray menu) and the shared slots. In-place reads/writes only.
const isImportInFlight = () => importInFlight;
const setImportInFlight = (v: boolean) => {
	importInFlight = v;
};

export {
	importPaths,
	removeLibraryRow,
	pickAndImport,
	isImportInFlight,
	setImportInFlight,
	libraryHasRow,
	hashFile,
};
