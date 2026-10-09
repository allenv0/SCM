"use strict";

// Library store (C-01 Wave 2, slice S4): in-memory index + bins, persisted
// to DATA_DIR and served to the renderer from memory. Owns the library,
// segment/transcript sidecars, model state, thresholds IO, the persist
// queue, and the cosine/norm math over library rows. Layout roots arrive
// via initLibraryStore() — main.js calls it after the MEMORIES_DATA_DIR
// override. Requires the category-overrides store for the served index.
// No electron dependency (plain-node tested).

const fs = require("fs");
const path = require("path");
const { loadCategoryOverrides } = require("./category-overrides.js");
const {
	getModel,
	getRetiredModelMigration,
	resolveModelId,
	DEFAULT_MODEL_ID,
	MODELS,
} = require("../indexer/models.js");
const {
	parseWhisperModel,
	DEFAULT_WHISPER_MODEL,
	repairCandidates,
	compactTranscriptStore,
} = require("../indexer/transcript-store-utils.js");

let DATA_DIR = null;
let PHOTOS_DIR = null;
let THUMBS_DIR = null;
let INDEX_FILE = null;
let LEGACY_EMBED_FILE = null;
let LEGACY_PHRASE_FILE = null;
let MODELS_STATE_FILE = null;
let QUERIES_FILE = null;
function initLibraryStore({ userDataDir }) {
	DATA_DIR = path.join(userDataDir, "library");
	PHOTOS_DIR = path.join(DATA_DIR, "photos");
	THUMBS_DIR = path.join(DATA_DIR, "thumbs");
	INDEX_FILE = path.join(DATA_DIR, "memories-index.json");
	LEGACY_EMBED_FILE = path.join(DATA_DIR, "memory-embeddings.bin");
	LEGACY_PHRASE_FILE = path.join(DATA_DIR, "memory-phrase-embeddings.bin");
	MODELS_STATE_FILE = path.join(DATA_DIR, "memory-models.json");
	QUERIES_FILE = path.join(DATA_DIR, "memory-queries.json");
}

// Monotonic counter bumped whenever main's view of the library can diverge
// from disk (save, reset, bin write). The rank utilityProcess sends this
// with each request and reloads on mismatch — no embedding transfer over IPC.
let libraryGeneration = 0;
function libraryGenerationNumber() {
	return libraryGeneration;
}

// Full state reset (model switch / test isolation): drops the in-memory
// library, all sidecar caches, and every memoized bin/norm payload so the
// next access lazily rebuilds from disk.
function resetLibraryCaches() {
	libraryGeneration++;
	library = null;
	segmentCache = {
		modelId: null,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
	};
	transcriptCache = {
		modelId: null,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
		version: 1,
		progress: {},
		whisperModel: DEFAULT_WHISPER_MODEL,
		utterances: new Map(),
	};
	libraryBinCache = { key: null, embeddings: null, phrases: null };
	libraryNormCache = { key: null, norms: null };
	segmentsBinCache = { key: null, buf: null };
	transcriptsBinCache = { key: null, buf: null };
}

// Preloaded sample-query results (loaded once from memory-queries.json).
let sampleQueries = null;
function loadSampleQueries() {
	if (sampleQueries) return sampleQueries;
	try {
		sampleQueries = JSON.parse(fs.readFileSync(QUERIES_FILE, "utf-8"));
	} catch {
		sampleQueries = { queries: [] };
	}
	return sampleQueries;
}

function embedFileFor(modelId) {
	return path.join(DATA_DIR, `memory-embeddings-${modelId}.bin`);
}
function phraseFileFor(modelId) {
	return path.join(DATA_DIR, `memory-phrase-embeddings-${modelId}.bin`);
}
// Scene-segment sidecars (Phase 1 of scene search): per-model, additive-only.
function segmentsMetaFileFor(modelId) {
	return path.join(DATA_DIR, `memory-segments-${modelId}.json`);
}
function segmentsBinFileFor(modelId) {
	return path.join(DATA_DIR, `memory-segment-embeddings-${modelId}.bin`);
}
// Transcript sidecars (speech index for scene search): per-model,
// additive-only. Each chunk is one {t0,t1,off,n,text} row (n always 1 —
// one embedding per ~30 s speech window). Keyed by FULL filename from day
// one (never the extension-stripped stem — do not repeat M-05).
function transcriptsMetaFileFor(modelId) {
	return path.join(DATA_DIR, `memory-transcripts-${modelId}.json`);
}
function transcriptsBinFileFor(modelId) {
	return path.join(DATA_DIR, `memory-transcript-embeddings-${modelId}.bin`);
}

function thumbFor(filename) {
	return path.join(
		THUMBS_DIR,
		path.basename(filename, path.extname(filename)) + ".jpg",
	);
}

// ---------------------------------------------------------------------------
// Library: in-memory copy of the index + bins, persisted to DATA_DIR on every
// mutation and served to the renderer from memory (same formats as the site:
// memories-index.json + header'd Float32 bins, so the renderer's existing
// parsing code works unchanged).
// ---------------------------------------------------------------------------

let library = null;

// Reads the per-model bin pair, falling back to the legacy pre-v4 names when
// this model's own files don't exist yet (an upgrade from an old install: the
// old pair IS the default model's pair). Returns [embeddings, phrases].
function readLibraryBins(modelId, count, dim) {
	const primary = readBin(embedFileFor(modelId), count, dim);
	const phrase = readBin(phraseFileFor(modelId), count, dim);
	if (primary.length === count && phrase.length === count) {
		return [primary, phrase];
	}
	const legacyEmb = readBin(LEGACY_EMBED_FILE, count, dim);
	const legacyPhr = readBin(LEGACY_PHRASE_FILE, count, dim);
	if (legacyEmb.length === count) {
		if (primary.length !== count)
			console.warn(
				`[memories] no ${modelId} bin yet; using legacy bin as its pair`,
			);
		return [legacyEmb, legacyPhr.length === count ? legacyPhr : []];
	}
	return [
		primary.length === count ? primary : [],
		phrase.length === count ? phrase : [],
	];
}

function loadLibrary() {
	if (library) return library;
	fs.mkdirSync(PHOTOS_DIR, { recursive: true });
	library = {
		filenames: [],
		sources: [],
		sourceMtimes: [],
		ocr: [],
		ocrWords: [],
		ocrRevision: 0,
		ocrLangs: null,
		hashes: [],
		screenshotHints: [],
		embeddings: [],
		phrases: [],
		dim: 0,
		textMean: null,
		modelId: DEFAULT_MODEL_ID,
		// Set only while an index references a retired or unknown vision
		// model. Main re-embeds it before it ever persists the resolved model
		// id, so incompatible vectors can never be served as the replacement.
		pendingModelMigration: null,
	};
	try {
		const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
		const images = Array.isArray(index.images) ? index.images : [];
		const dim = Number(index.dim) || 0;
		const storedModelId =
			typeof index.modelId === "string" && index.modelId ? index.modelId : null;
		const retirement = storedModelId
			? getRetiredModelMigration(storedModelId)
			: null;
		const knownModel = storedModelId ? getModel(storedModelId) : null;
		// A v4 model id is the only proof an old vector space is compatible
		// with a live registry entry. Pre-v4 libraries have no id, and a
		// removed/unknown id may have a different dimension or semantic space.
		// Do not resolve then read those bins: wait for the safe re-embed in
		// main while leaving the original index and artifacts untouched.
		const needsModelMigration =
			images.length > 0 && dim > 0 && (!knownModel || Boolean(retirement));
		if (needsModelMigration) {
			const targetId = retirement?.targetId || DEFAULT_MODEL_ID;
			library.modelId = targetId;
			library.pendingModelMigration = {
				fromId: storedModelId || "legacy-unversioned",
				targetId,
			};
			console.warn(
				`[memories] ${storedModelId ? `retiring ${storedModelId}` : "legacy model id missing"}; ` +
					`will re-embed ${images.length} row(s) into ${targetId}`,
			);
		} else {
			library.modelId = resolveModelId(storedModelId);
		}
		if (images.length > 0 && dim > 0) {
			library.filenames = images;
			// Original on-disk paths recorded at import (drives the lightbox's
			// "Show in Finder"). May be absent/short in libraries written before
			// this feature, in which case the app-managed copy is revealed.
			library.sources = Array.isArray(index.sources)
				? index.sources.slice(0, images.length)
				: [];
			// Source-file modification time captured at import. This is display
			// metadata only: keeping it parallel to images lets the browse feed
			// sort by media recency without ever reordering embedding bins.
			library.sourceMtimes = new Array(images.length).fill(null);
			if (Array.isArray(index.sourceMtimes)) {
				for (
					let i = 0;
					i < images.length && i < index.sourceMtimes.length;
					i++
				) {
					const mtime = index.sourceMtimes[i];
					if (typeof mtime === "number" && Number.isFinite(mtime)) {
						library.sourceMtimes[i] = mtime;
					}
				}
			}
			// OCR text extracted in the background from each image (posters,
			// screenshots — the text a CLIP embedding can't read). Parallel to
			// filenames; "" = OCR'd but no text found, null = not yet OCR'd.
			// Model-independent, so it lives in the index (not per-model bins)
			// and survives model switches untouched.
			library.ocr = Array.isArray(index.ocr)
				? index.ocr.slice(0, images.length)
				: new Array(images.length).fill(null);
			// Per-word, normalized OCR rectangles for search-result highlights.
			// `null` means an older row has text but no geometry yet, so the
			// background OCR upgrade can revisit it; [] means it was recognized
			// and had no usable words.
			library.ocrWords = Array.isArray(index.ocrWords)
				? Array.from({ length: images.length }, (_, i) =>
						Array.isArray(index.ocrWords[i]) ? index.ocrWords[i] : null,
					)
				: new Array(images.length).fill(null);
			library.ocrRevision = Number.isInteger(index.ocrRevision)
				? index.ocrRevision
				: 0;
			// Language set the stored OCR text was recognized with (tesseract
			// "eng+chi_sim+..." string). Null = pre-language-stamp library;
			// the launch backfill treats a stamp mismatch as stale rows and
			// re-queues every photo under the current setting.
			library.ocrLangs =
				typeof index.ocrLangs === "string" && index.ocrLangs.length > 0
					? index.ocrLangs
					: null;
			// Content SHA-256 per row (fix for rename-duplicates in watched
			// folders): a renamed file is a NEW source path, so path-dedupe
			// can't see it — its bytes are already in the library and the
			// hash proves it. Additive field; pre-hash libraries pad nulls so
			// the array always stays 1:1 with filenames.
			library.hashes = new Array(images.length).fill(null);
			if (Array.isArray(index.hashes)) {
				for (let i = 0; i < images.length && i < index.hashes.length; i++) {
					if (typeof index.hashes[i] === "string")
						library.hashes[i] = index.hashes[i];
				}
			}
			// Screenshot metadata hint per row (Screenshots tab): null = not
			// probed yet, false = probed with no screenshot metadata, true =
			// the file's PNG/JPEG text metadata names a screenshot. Probed at
			// import (and backfilled for legacy rows); model-independent, so
			// it lives in the index like OCR. The renderer treats missing
			// rows as "no signal".
			library.screenshotHints = new Array(images.length).fill(null);
			if (Array.isArray(index.screenshotHints)) {
				for (
					let i = 0;
					i < images.length && i < index.screenshotHints.length;
					i++
				) {
					const hint = index.screenshotHints[i];
					if (hint === true || hint === false)
						library.screenshotHints[i] = hint;
				}
			}
			library.dim = dim;
			library.textMean =
				!library.pendingModelMigration && Array.isArray(index.textMean)
					? new Float32Array(index.textMean)
					: null;
			if (!library.pendingModelMigration) {
				[library.embeddings, library.phrases] = readLibraryBins(
					library.modelId,
					images.length,
					dim,
				);
			}
			if (library.embeddings.length !== images.length) {
				console.warn(
					`[memories] embedding bin misaligned (${library.embeddings.length}/${images.length}); starting fresh`,
				);
				library.embeddings = [];
				library.phrases = [];
			}
		}
	} catch (err) {
		console.warn(
			`[memories] no library on disk (${err.message}); starting fresh`,
		);
	}
	return library;
}

function readBin(file, count, dim) {
	const rows = readBinPartial(file, dim, { quarantine: true, file });
	// Mismatch with the requested count: a normal "this bin is for
	// a different library/model" signal, not corruption.
	if (rows.length !== count) return [];
	return rows;
}

// Length-tolerant bin read: every row the file holds (validated the same
// way as readBin), regardless of the caller's row count. The delta-switch
// planner uses this to reuse cached rows by identity when the library has
// grown or shrunk since the target model's bins were written.
function readBinPartial(file, dim, opts = {}) {
	try {
		const buf = fs.readFileSync(file);
		const decoded = decodeBinRows(buf, dim);
		if (!decoded) return [];
		if (decoded.corrupt && opts.quarantine) {
			console.warn(
				`[memories] bin corrupt (bytes=${decoded.bytes} header=[${decoded.header}]) — quarantining ${opts.file || file}`,
			);
			try {
				fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
			} catch (e) {
				console.warn(
					`[memories] could not quarantine corrupt bin: ${e.message}`,
				);
			}
			return [];
		}
		if (decoded.corrupt) return [];
		return decoded.rows;
	} catch {
		return [];
	}
}

// Structural validation + decode shared by readBin/readBinPartial. Returns
// { rows } on success, { corrupt, bytes, header } when the file is
// internally inconsistent (truncated — quarantined by the caller, C-02), or
// null when the bin is merely for a different vector space (dim mismatch —
// the caller's fallback chain applies, never corruption).
function decodeBinRows(buf, dim) {
	try {
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		const hCount = header[0];
		const hDim = header[1];
		// Structural check: is the FILE internally consistent? A bin that
		// declares more rows than its bytes can hold is truncated/corrupt.
		// A count=0 bin is the app's own "empty" representation (e.g.
		// phrases before the text model loads) — it is NOT corrupt, only
		// the 8-byte header.
		const structurallyValid =
			Number.isInteger(hCount) &&
			hCount >= 0 &&
			hCount < 1_000_000 &&
			(hCount === 0
				? buf.length >= 8
				: Number.isInteger(hDim) &&
					hDim > 0 &&
					hDim < 8192 &&
					buf.length >= 8 + hCount * hDim * 4);
		if (!structurallyValid) {
			return { corrupt: true, bytes: buf.length, header: [hCount, hDim] };
		}
		if (hDim !== dim) return null;
		const rows = [];
		for (let i = 0; i < hCount; i++) {
			rows.push(
				new Float32Array(buf.buffer, buf.byteOffset + 8 + i * dim * 4, dim),
			);
		}
		return { rows };
	} catch {
		return null;
	}
}

function encodeBin(vectors, dim) {
	// Defensive: never write nulls (an empty vector keeps 1:1 alignment).
	const body = Buffer.concat(
		vectors.map((v) =>
			Buffer.from(
				v
					? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
					: new ArrayBuffer(dim * 4),
			),
		),
	);
	const header = Buffer.alloc(8);
	header.writeInt32LE(vectors.length, 0);
	header.writeInt32LE(dim, 4);
	return Buffer.concat([header, body]);
}

function libraryIndex() {
	const l = loadLibrary();
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const config = getModel(l.modelId) || getModel(DEFAULT_MODEL_ID);
	return {
		version: 4,
		modelId: l.modelId,
		dim: l.dim || config.dim,
		phraseDim,
		generatedAt: new Date().toISOString(),
		images: l.filenames,
		sources: l.sources,
		// Parallel to images. Existing libraries are backfilled on startup;
		// null means neither the original nor app-managed copy was stat-able.
		sourceMtimes: l.sourceMtimes,
		// Parallel to images; may be shorter for libraries imported before
		// OCR existed (the renderer treats missing rows as "no OCR text").
		ocr: l.ocr,
		// Parallel to images. Word boxes are normalized to 0..1 relative to
		// the source image and let the renderer outline literal query matches.
		ocrWords: l.ocrWords,
		// Lets a renderer refresh OCR metadata after a background drain even
		// though image count, embedding dim, and model are unchanged.
		ocrRevision: l.ocrRevision || 0,
		// Language stamp for the stored OCR rows (see loadLibrary). The
		// renderer doesn't consume it directly; main uses it to detect a
		// language change across launches.
		ocrLangs: l.ocrLangs || null,
		// Content hashes per row; pre-hash libraries pad null (see loadLibrary).
		hashes: l.hashes,
		// Screenshot metadata hints per row (Screenshots tab): null = not yet
		// probed, true = the file's own metadata names a screenshot. The
		// renderer combines this with filename/source-folder signals.
		screenshotHints: l.screenshotHints || [],
		// Manual category overrides keyed by content hash ("Screenshots" |
		// "Projects") — the user's explicit Add to/Remove from Screenshots
		// decisions, which beat every automatic signal.
		categoryOverrides: { ...loadCategoryOverrides() },
		textMean: l.textMean ? Array.from(l.textMean) : undefined,
	};
}

// ---------------------------------------------------------------------------
// Persistence: index + bins are written ASYNCHRONOUSLY through a serialized
// queue (temp-file + atomic rename per file), so a large library can never
// block the main process — previously every save re-encoded the whole bin
// pair and writeFileSync'd it on the UI thread. The renderer is served from
// MEMORY (libraryIndex / cachedLibraryBins), so the disk matters only for
// crash durability and the next launch; the FIFO queue keeps the on-disk
// state equal to the last completed save no matter how writes overlap.
// ---------------------------------------------------------------------------

let persistQueue = Promise.resolve();
let persistSeq = 0;

// Enqueue a persistence step. The chain itself survives failures (a bad
// write must not strand every later save); the returned promise is the
// caller's own view of the outcome.
function enqueuePersist(fn) {
	const run = persistQueue.then(fn);
	persistQueue = run.catch(() => {});
	return run;
}

// Write one file atomically: unique temp name (concurrent writers can't
// collide on a shared temp), fsync for durability, then rename over the
// destination. The fsync makes the bytes durable across power loss BEFORE
// the atomic rename lands (APFS rename is atomic but not durable without a
// prior fsync).
async function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp-${process.pid}-${++persistSeq}`;
	const fd = await fs.promises.open(tmp, "w");
	let wrote = false;
	try {
		await fd.write(data);
		await fd.sync();
		await fd.close();
		await fs.promises.rename(tmp, file);
		wrote = true;
	} finally {
		if (!wrote) {
			try {
				await fd.close();
			} catch {
				/* already closed */
			}
			// Never litter zero-byte temps on a failed write (fd.write
			// throws first under memory pressure): sweeps and the M-04
			// no-leftovers guard assume a tmp means a write in flight.
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* already gone */
			}
		}
	}
}

// The encoded bin payloads are served to the renderer on every reload; the
// underlying rows only change when the library is saved, so the encoded
// Buffer is memoized and rebuilt only when (model, row count, dim) moves.
// Keyed on the LIVE in-memory state so the served bytes always match the
// index the renderer just fetched — and migration checkpoints (which write
// partial TARGET-model bins through writeBins) can never pollute it. The
// cache is dropped in saveLibrary: a same-size mutation (a healed phrase
// row) keeps the key identical but changes the payload.
let libraryBinCache = { key: null, embeddings: null, phrases: null };

function cachedLibraryBins() {
	const l = loadLibrary();
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const key = `${l.modelId}|${l.filenames.length}|${l.dim}|${phraseDim}`;
	if (libraryBinCache.key !== key) {
		libraryBinCache = {
			key,
			embeddings: encodeBin(l.embeddings, l.dim),
			phrases: encodeBin(l.phrases, phraseDim),
		};
	}
	return libraryBinCache;
}

let segmentsBinCache = { key: null, buf: null };

function cachedSegmentsBin() {
	const c = loadSegments(loadLibrary().modelId);
	const key = `${c.modelId}|${c.rows.length}|${c.dim}`;
	if (segmentsBinCache.key !== key) {
		segmentsBinCache = {
			key,
			buf: c.loaded ? encodeBin(c.rows, c.dim) : null,
		};
	}
	return segmentsBinCache;
}

let transcriptsBinCache = { key: null, buf: null };

function cachedTranscriptsBin() {
	const c = loadTranscripts(loadLibrary().modelId);
	const key = `${c.modelId}|${c.rows.length}|${c.dim}`;
	if (transcriptsBinCache.key !== key) {
		transcriptsBinCache = {
			key,
			buf: c.loaded ? encodeBin(c.rows, c.dim) : null,
		};
	}
	return transcriptsBinCache;
}

// Writes one model's bin pair (the active model for saveLibrary; a target
// model mid-migration via writeBins). Null rows persist as zero vectors so
// the 1:1 alignment with filenames never drifts. opts.filenames (required
// for non-active targets) snapshots the row identity the vectors align to;
// opts.incomplete marks a partial fill so a crash resumes instead of
// serving zeros as final. The meta rides the same persist step as the bins
// so the pair can never diverge.
function writeBins(modelId, embeddings, phrases, dim, phraseDim, opts = {}) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const embBuf = encodeBin(embeddings, dim);
	const phrBuf = encodeBin(phrases, phraseDim);
	const filenames = Array.isArray(opts.filenames) ? [...opts.filenames] : null;
	const metaJson = filenames
		? JSON.stringify({
				version: 1,
				codeVersion: EMBED_CODE_VERSION,
				modelId,
				dim,
				count: filenames.length,
				incomplete: opts.incomplete === true,
				filenames,
				writtenAt: new Date().toISOString(),
			})
		: null;
	return enqueuePersist(() =>
		Promise.all([
			writeFileAtomic(embedFileFor(modelId), embBuf),
			writeFileAtomic(phraseFileFor(modelId), phrBuf),
			...(metaJson
				? [writeFileAtomic(embedMetaFileFor(modelId), metaJson)]
				: []),
		]),
	)
		.then(() => {
			libraryGeneration++;
		})
		.catch((err) => {
			console.warn(
				`[memories] bin write failed for ${modelId}: ${err.message}`,
			);
		});
}

async function saveLibrary() {
	const l = loadLibrary();
	// A retired/unknown model's rows are deliberately withheld while main
	// builds a replacement index. Startup maintenance (timestamps, stale-row
	// pruning, OCR, etc.) may call saveLibrary before that async migration
	// begins; letting one of those writes through would replace the only
	// recoverable old index with an empty target-model bin. The migration
	// clears this guard immediately before its final atomic save.
	if (l.pendingModelMigration) return;
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const indexJson = JSON.stringify(libraryIndex());
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const embBuf = encodeBin(l.embeddings, l.dim);
	const phrBuf = encodeBin(l.phrases, phraseDim);
	// Row-identity snapshot for the delta-switch planner, captured at the
	// same moment as the bins above so the pair can never diverge (see
	// writeBins). A background fill in progress stamps incomplete:true via
	// setEmbedIncomplete, so a crash resumes the tail on next launch.
	const metaJson = JSON.stringify({
		version: 1,
		codeVersion: EMBED_CODE_VERSION,
		modelId: l.modelId,
		dim: l.dim,
		count: l.filenames.length,
		incomplete: embedIncompleteByModel.get(l.modelId) === true,
		filenames: [...l.filenames],
		writtenAt: new Date().toISOString(),
	});
	// Rows changed under this key (e.g. a healed phrase row keeps the same
	// count/dim) — drop the memoized payload so the next fetch re-encodes.
	libraryBinCache = { key: null, embeddings: null, phrases: null };
	libraryNormCache = { key: null, norms: null };
	try {
		await enqueuePersist(async () => {
			// Bins first, index last: a crash between renames leaves either
			// the old index (consistent with the old bins) or a new index
			// whose bins already landed — never a new index pointing at
			// bins that haven't been written yet. The load-time count check
			// self-heals either way, but this keeps the on-disk pair
			// consistent and avoids a full re-embed.
			await Promise.all([
				writeFileAtomic(embedFileFor(l.modelId), embBuf),
				writeFileAtomic(phraseFileFor(l.modelId), phrBuf),
				writeFileAtomic(embedMetaFileFor(l.modelId), metaJson),
			]);
			await writeFileAtomic(INDEX_FILE, indexJson);
			libraryGeneration++;
		});
	} catch (err) {
		// Persistence failure must not crash the flow that triggered it: the
		// in-memory library (what the renderer reads) is still consistent,
		// and the next save retries the disk write.
		console.warn(`[memories] library save failed: ${err.message}`);
	}
}

// The first release with sourceMtimes must repair libraries that already had
// arbitrary fs.readdir order baked into `images`. Read the source file when
// possible; an app-managed copy's mtime is a useful import-time fallback when
// its original was moved or deleted. This deliberately changes metadata only
// — embedding rows remain in their persisted order for every model bin.
function fileMtimeMs(filePath) {
	if (!filePath) return null;
	try {
		const mtime = Number(fs.statSync(filePath).mtimeMs);
		return Number.isFinite(mtime) ? mtime : null;
	} catch {
		return null;
	}
}

async function backfillSourceMtimes() {
	const l = loadLibrary();
	if (!l || l.filenames.length === 0) return 0;
	if (!Array.isArray(l.sourceMtimes)) l.sourceMtimes = [];

	let changed = false;
	let filled = 0;
	for (let i = 0; i < l.filenames.length; i++) {
		if (Number.isFinite(l.sourceMtimes[i])) continue;
		const source = l.sources[i];
		const mtime =
			fileMtimeMs(source) ?? fileMtimeMs(path.join(PHOTOS_DIR, l.filenames[i]));
		if (mtime !== null) {
			l.sourceMtimes[i] = mtime;
			changed = true;
			filled++;
		} else if (i >= l.sourceMtimes.length) {
			l.sourceMtimes[i] = null;
			changed = true;
		}
	}
	if (l.sourceMtimes.length > l.filenames.length) {
		l.sourceMtimes.length = l.filenames.length;
		changed = true;
	}
	if (changed) {
		await saveLibrary();
		console.log(
			`[memories] chronology backfill: recorded ${filled} source timestamp(s)`,
		);
	}
	return filled;
}

// ---------------------------------------------------------------------------
// Scene-segment sidecars (Phase 1 of scene search, DESIGN-SCENE-SEARCH.md).
// Each segment is one {t, dur, off, n} row (n always 1 — one embedding per
// shot midpoint). Rows live in a per-model bin with the SAME 8-byte header +
// Float32 encoding as the embedding bins, so the renderer parses them with
// the exact same code. The main index is untouched — segments are purely
// additive and model-specific (a model switch just means the new model's
// files don't exist yet and rebuild lazily).
// ---------------------------------------------------------------------------

// Lazy per-model cache: { modelId, dim, loaded, videos: Map(filename →
// [{t,dur,off,n}]), rows: Float32Array[] }. Invalidated implicitly — every
// accessor reloads when the modelId differs.
let segmentCache = {
	modelId: null,
	dim: 0,
	loaded: false,
	videos: new Map(),
	rows: [],
};

function loadSegments(modelId) {
	if (segmentCache.modelId === modelId && segmentCache.loaded)
		return segmentCache;
	const fresh = { modelId, dim: 0, loaded: false, videos: new Map(), rows: [] };
	try {
		const parsed = JSON.parse(
			fs.readFileSync(segmentsMetaFileFor(modelId), "utf8"),
		);
		const bin = fs.readFileSync(segmentsBinFileFor(modelId));
		const header = new Int32Array(bin.buffer, bin.byteOffset, 2);
		// The bin header is the ground truth: sidecars written before the
		// dim was persisted (a Phase-1 bug) carry meta.dim = 0 — adopt the
		// bin's declared dim so old data loads instead of being orphaned.
		const dim = Number(parsed.dim) || header[1] || 0;
		if (dim > 0 && header[0] === (parsed.total || 0) && header[1] === dim) {
			fresh.dim = dim;
			for (const v of parsed.videos || []) {
				// A corrupt/partial sidecar must not serve out-of-bounds rows:
				// drop segments whose offsets don't land inside the bin.
				const segments = (v.segments || []).filter(
					(s) =>
						Number.isFinite(s.off) &&
						s.off >= 0 &&
						s.off < header[0] &&
						Number.isFinite(s.t),
				);
				fresh.videos.set(v.filename, segments);
			}
			fresh.rows = readBin(segmentsBinFileFor(modelId), header[0], dim);
			fresh.loaded = true;
		}
	} catch {
		/* no segments for this model yet */
	}
	segmentCache = fresh;
	return segmentCache;
}

function saveSegments() {
	const c = segmentCache;
	if (!c.loaded) return;
	const meta = {
		version: 1,
		modelId: c.modelId,
		dim: c.dim,
		total: c.rows.length,
		videos: [...c.videos.entries()].map(([filename, segments]) => ({
			filename,
			segments,
		})),
	};
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const binFile = segmentsBinFileFor(c.modelId);
	const metaFile = segmentsMetaFileFor(c.modelId);
	const binBuf = encodeBin(c.rows, c.dim);
	// The row space changed under this key — drop the memoized payload so
	// the next fetch re-encodes the fresh rows.
	segmentsBinCache = { key: null, buf: null };
	// Atomic + off the main thread, like the library bins (M-04). Bin
	// first, meta last so a crash can't leave a meta pointing at a
	// half-written bin.
	return enqueuePersist(async () => {
		await writeFileAtomic(binFile, binBuf);
		await writeFileAtomic(metaFile, JSON.stringify(meta));
	});
}

// Compact the row space after a library row is deleted so the meta totals
// stay 1:1 with the bin. Segment data is small (KB–MB), so a rebuild is cheap.
// Resolves the ACTIVE model's cache first: the cache may be unloaded (delete
// without any prior scene access) or hold a different model than the library
// (a switch since the last access) — either way the on-disk sidecar for the
// active model must be the one compacted.
function compactSegmentCache(c, filename) {
	c.videos.delete(filename);
	const keep = [];
	for (const segs of c.videos.values()) {
		for (const seg of segs) keep.push(c.rows[seg.off]);
	}
	c.rows = keep;
	let off = 0;
	for (const segs of c.videos.values()) {
		for (const seg of segs) {
			seg.off = off++;
		}
	}
}

function removeSegmentsFor(filename) {
	const c = loadSegments(loadLibrary().modelId);
	if (!c.loaded || !c.videos.has(filename)) return;
	compactSegmentCache(c, filename);
	saveSegments();
}

// Delete/purge must clean EVERY model's sidecar: a film enriched under
// model A then deleted after a switch to B would otherwise leave dead
// rows in A's sidecar forever (pruneOrphanSidecars only fires for
// rowless names, which never triggers for valid-row purges). The cache
// holds one model at a time, so the ACTIVE model's live object is held
// across the loop: re-loading it from disk afterwards could resurrect
// just-deleted entries when the compaction save hasn't drained yet
// (saves persist asynchronously), and evicting it first would compact a
// stale disk copy. Object identity keeps live truth either way; the
// global is pointed back at it at the end so later callers see the model
// they expect.
function removeSegmentsForAllModels(filename) {
	const live = loadSegments(loadLibrary().modelId);
	const liveHad = live.loaded && live.videos.has(filename);
	if (liveHad) compactSegmentCache(live, filename);
	for (const modelId of Object.keys(MODELS)) {
		if (modelId === live.modelId) continue;
		const c = loadSegments(modelId);
		if (!c.loaded || !c.videos.has(filename)) continue;
		compactSegmentCache(c, filename);
		saveSegments();
	}
	segmentCache = live;
	if (liveHad) saveSegments();
}

// ---------------------------------------------------------------------------
// Transcript sidecars (speech index for scene search). Each chunk is one
// {t0,t1,off,n,text} row (n always 1). Rows live in a per-model bin with the
// SAME 8-byte header + Float32 encoding as the segment bins. Purely additive
// and model-specific, like segments. Empty chunk lists are valid (silent /
// music-only film) and mean "transcribed, nothing searchable" — never retried.
// ---------------------------------------------------------------------------

let transcriptCache = {
	modelId: null,
	dim: 0,
	loaded: false,
	videos: new Map(),
	rows: [],
	version: 1,
	progress: {},
	whisperModel: DEFAULT_WHISPER_MODEL,
	utterances: new Map(),
};

function loadTranscripts(modelId) {
	if (transcriptCache.modelId === modelId && transcriptCache.loaded)
		return transcriptCache;
	const fresh = {
		modelId,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
		version: 1,
		progress: {},
		whisperModel: DEFAULT_WHISPER_MODEL,
		utterances: new Map(),
	};
	try {
		const parsed = JSON.parse(
			fs.readFileSync(transcriptsMetaFileFor(modelId), "utf8"),
		);
		const bin = fs.readFileSync(transcriptsBinFileFor(modelId));
		const header = new Int32Array(bin.buffer, bin.byteOffset, 2);
		const dim = Number(parsed.dim) || header[1] || 0;
		if (dim > 0 && header[0] === (parsed.total || 0) && header[1] === dim) {
			fresh.dim = dim;
			fresh.version = Number(parsed.version) || 1;
			// Pre-stamp sidecars were all tiny.en (the only engine shipped).
			fresh.whisperModel = parseWhisperModel(parsed.whisperModel || "tiny.en");
			for (const v of parsed.videos || []) {
				const chunks = (v.chunks || []).filter(
					(c) =>
						Number.isFinite(c.off) &&
						c.off >= 0 &&
						c.off < header[0] &&
						Number.isFinite(c.t0) &&
						Number.isFinite(c.t1) &&
						c.t1 > c.t0,
				);
				fresh.videos.set(v.filename, chunks);
				// Utterance-level full-text rows (exact-search index, v3+).
				// Validated like chunks minus offsets (no bin rows behind them).
				const lines = Array.isArray(v.utterances)
					? v.utterances
							.filter(
								(u) =>
									u &&
									Number.isFinite(u.t0) &&
									Number.isFinite(u.t1) &&
									u.t1 > u.t0 &&
									typeof u.text === "string" &&
									u.text.trim().length > 0,
							)
							.map((u) => ({ t0: u.t0, t1: u.t1, text: String(u.text) }))
					: [];
				if (lines.length > 0) fresh.utterances.set(v.filename, lines);
			}
			fresh.rows = readBin(transcriptsBinFileFor(modelId), header[0], dim);
			fresh.progress =
				parsed.progress && typeof parsed.progress === "object"
					? parsed.progress
					: {};
			fresh.loaded = true;
		}
	} catch {
		/* no transcripts for this model yet */
	}
	transcriptCache = fresh;
	if (fresh.loaded) {
		// Self-heal pre-fix orphan rows / gapped offsets (compact + restamp,
		// persist once). Records stay untouched — only unreachable rows go.
		const compacted = compactTranscriptStore(fresh.videos, fresh.rows);
		if (compacted.dropped !== 0) {
			console.warn(
				`[memories] transcript sidecar inconsistent (${compacted.dropped} orphan rows) — compacted`,
			);
			fresh.videos = compacted.videos;
			fresh.rows = compacted.rows;
			saveTranscripts();
		}
	}
	return transcriptCache;
}

function saveTranscripts() {
	const c = transcriptCache;
	if (!c.loaded) return;
	if (!c.version || c.version < 2) c.version = 2;
	if (!c.progress || typeof c.progress !== "object") c.progress = {};
	if (!(c.utterances instanceof Map)) c.utterances = new Map();
	const meta = {
		version: c.version,
		modelId: c.modelId,
		whisperModel: parseWhisperModel(c.whisperModel),
		dim: c.dim,
		total: c.rows.length,
		videos: [...c.videos.entries()].map(([filename, chunks]) => ({
			filename,
			chunks,
			...(c.utterances.get(filename)?.length
				? { utterances: c.utterances.get(filename) }
				: {}),
		})),
		progress: c.progress,
	};
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const binFile = transcriptsBinFileFor(c.modelId);
	const metaFile = transcriptsMetaFileFor(c.modelId);
	const binBuf = encodeBin(c.rows, c.dim);
	transcriptsBinCache = { key: null, buf: null };
	return enqueuePersist(async () => {
		await writeFileAtomic(binFile, binBuf);
		await writeFileAtomic(metaFile, JSON.stringify(meta));
	});
}

// Drop a film's whole speech index (chunks + utterance lines + progress).
// Used on library removal AND on whisper-model switch (per-film reset would
// leave mixed-model rows behind; the switch path resets the whole store).
function dropTranscriptEntries(c, filename) {
	c.videos.delete(filename);
	if (c.utterances instanceof Map) c.utterances.delete(filename);
	if (c.progress && typeof c.progress === "object") delete c.progress[filename];
}

function resetTranscriptsFor(filename) {
	const c = loadTranscripts(loadLibrary().modelId);
	if (!c.loaded) return;
	dropTranscriptEntries(c, filename);
}

function compactTranscriptCache(c, filename) {
	dropTranscriptEntries(c, filename);
	const keep = [];
	for (const chunks of c.videos.values()) {
		for (const ch of chunks) keep.push(c.rows[ch.off]);
	}
	c.rows = keep;
	let off = 0;
	for (const chunks of c.videos.values()) {
		for (const ch of chunks) {
			ch.off = off++;
		}
	}
}

function removeTranscriptsFor(filename) {
	const c = loadTranscripts(loadLibrary().modelId);
	if (!c.loaded || !c.videos.has(filename)) return;
	compactTranscriptCache(c, filename);
	saveTranscripts();
}

// All-models twin of removeSegmentsForAllModels (same leak, same fix —
// see above). Holds the live object across the loop for the same reason.
function removeTranscriptsForAllModels(filename) {
	const live = loadTranscripts(loadLibrary().modelId);
	const liveHad = live.loaded && live.videos.has(filename);
	if (liveHad) compactTranscriptCache(live, filename);
	for (const modelId of Object.keys(MODELS)) {
		if (modelId === live.modelId) continue;
		const c = loadTranscripts(modelId);
		if (!c.loaded || !c.videos.has(filename)) continue;
		compactTranscriptCache(c, filename);
		saveTranscripts();
	}
	transcriptCache = live;
	if (liveHad) saveTranscripts();
}

// One-time repair for stub-era poisoning: before the whisper engine existed,
// every video was recorded with ZERO chunks — indistinguishable from a truly
// silent film, so the launch backfill skips them forever ("covered"). Empty
// is only legitimate without an audio stream, so probe each empty entry and
// drop the ones WITH audio; the backfill then re-queues them for real
// transcription. Silent films keep their empty (never retried). Runs once
// ever per sidecar (stamped version 2). Returns the repair count.
async function repairUntranscribedWithAudio() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return 0;
	const c = loadTranscripts(l.modelId);
	if (!c.loaded || (c.version || 1) >= 2) return 0;
	const candidates = repairCandidates(c.videos);
	let ffmpeg;
	try {
		ffmpeg = require("../indexer/video-utils.js").resolveFfmpeg();
	} catch {
		ffmpeg = null;
	}
	let repaired = 0;
	if (ffmpeg && candidates.length > 0) {
		const { probeHasAudio } = require("../indexer/video-utils.js");
		for (const name of candidates) {
			let hasAudio;
			try {
				hasAudio = await probeHasAudio(ffmpeg, path.join(PHOTOS_DIR, name));
			} catch {
				hasAudio = false;
			}
			if (hasAudio) {
				c.videos.delete(name);
				repaired++;
			}
		}
	}
	c.version = 2;
	saveTranscripts();
	if (repaired > 0) {
		console.log(
			`[memories] transcript repair: ${repaired} video(s) with audio re-queued for transcription`,
		);
	}
	return repaired;
}

// ---------------------------------------------------------------------------
// Per-model state: calibrated thresholds, persisted to memory-models.json.
// The registry seeds the default model's thresholds; any model whose
// thresholds are null gets calibrated on first use (see calibrateThresholds).
// ---------------------------------------------------------------------------

let modelStateCache = null;

// Post-restore invalidation: the thresholds file on disk was just replaced
// from a version — drop the memoized read so the next thresholdsFor()
// serves the restored calibrations instead of the pre-restore ones.
function resetModelStateCache() {
	modelStateCache = null;
}

function loadModelState() {
	if (modelStateCache) return modelStateCache;
	modelStateCache = { version: 1, models: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(MODELS_STATE_FILE, "utf8"));
		if (parsed && typeof parsed.models === "object") {
			modelStateCache.models = parsed.models;
		}
	} catch {
		/* no state yet */
	}
	return modelStateCache;
}

function saveModelState() {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(
		MODELS_STATE_FILE,
		JSON.stringify(loadModelState(), null, "\t"),
	);
}

// The effective thresholds for a model: persisted calibration wins, then the
// registry seed, then null (uncalibrated → the renderer's defaults).
function thresholdsFor(modelId) {
	const state = loadModelState().models[modelId];
	if (state && state.thresholds) return state.thresholds;
	const config = getModel(modelId);
	return (config && config.thresholds) || null;
}

// Headers of the on-disk bin pair for a model: { rows, dim } or null.
function binInfo(modelId) {
	try {
		const buf = fs.readFileSync(embedFileFor(modelId));
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		return { rows: header[0], dim: header[1] };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Delta switch: per-model row-identity snapshots + pipeline versioning.
//
// The bin pair is index-aligned to the filenames array at write time but
// carries no record of WHICH filename each row belonged to — so after
// deletes, reorders, or imports a later switch cannot tell a still-valid
// row from a shifted one by index alone (index-copy would silently attach
// wrong vectors to wrong images). The sidecar below records that identity
// every time a model's bins are written, plus the pipeline version that
// produced the vectors. The renderer never reads it; only the switch
// planner (planDeltaReuse) does. The bin format itself is untouched.
// ---------------------------------------------------------------------------

// Bump when the embedding pipeline's math changes (preprocessing resize,
// normalization, quantization, model revision): cached vectors from an older
// pipeline look valid (same dim, plausible rows) but are stale, so a version
// mismatch forces a full re-embed rather than silent reuse.
const EMBED_CODE_VERSION = 1;

function embedMetaFileFor(modelId) {
	return path.join(DATA_DIR, `memory-embed-meta-${modelId}.json`);
}

function readEmbedMeta(modelId) {
	try {
		const meta = JSON.parse(fs.readFileSync(embedMetaFileFor(modelId), "utf8"));
		if (!meta || typeof meta !== "object") return null;
		if (!Array.isArray(meta.filenames)) return null;
		if (!Number.isInteger(meta.codeVersion)) return null;
		if (!Number.isInteger(meta.dim) || meta.dim <= 0) return null;
		return meta;
	} catch {
		return null;
	}
}

// Rows whose vectors are still being filled (a background delta tail or an
// interrupted foreground migration). saveLibrary stamps the flag into the
// meta it writes, so a crash mid-fill leaves incomplete:true on disk and the
// next launch resumes instead of serving zeros as final.
const embedIncompleteByModel = new Map();
function setEmbedIncomplete(modelId, flag) {
	if (flag) embedIncompleteByModel.set(modelId, true);
	else embedIncompleteByModel.delete(modelId);
}

function isZeroVector(v) {
	if (!v) return true;
	for (let i = 0; i < v.length; i++) {
		if (v[i] !== 0) return false;
	}
	return true;
}

// Match the current library against a target model's cached bins BY
// FILENAME (never by index — deletes/reorders shift indices). Returns
// { usable, reason, reusedEmbeddings, reusedPhrases, missing, reused } where
// the reused arrays are dense and aligned to `filenames` (null = missing)
// and `missing` names the files that need embedding. Zero-vector rows count
// as missing (failed rows self-heal on the next switch instead of being
// copied forward). Duplicate filenames reuse the snapshot's first row.
function planDeltaReuse(modelId, dim, filenames) {
	const empty = {
		usable: false,
		reason: "no-meta",
		reusedEmbeddings: [],
		reusedPhrases: [],
		missing: [...filenames],
		reused: 0,
	};
	const meta = readEmbedMeta(modelId);
	if (!meta) return empty;
	if (meta.codeVersion !== EMBED_CODE_VERSION) {
		return { ...empty, reason: "code-version" };
	}
	if (meta.dim !== dim) {
		return { ...empty, reason: "dim" };
	}
	const embedRows = readBinPartial(embedFileFor(modelId), dim);
	const phraseRows = readBinPartial(phraseFileFor(modelId), dim);
	if (
		embedRows.length !== meta.filenames.length ||
		phraseRows.length !== meta.filenames.length
	) {
		return { ...empty, reason: "bin-meta-mismatch" };
	}
	const snapIndex = new Map();
	for (let j = 0; j < meta.filenames.length; j++) {
		if (!snapIndex.has(meta.filenames[j])) snapIndex.set(meta.filenames[j], j);
	}
	const reusedEmbeddings = new Array(filenames.length).fill(null);
	const reusedPhrases = new Array(filenames.length).fill(null);
	const missing = [];
	let reused = 0;
	for (let i = 0; i < filenames.length; i++) {
		const j = snapIndex.get(filenames[i]);
		if (j === undefined) {
			missing.push(filenames[i]);
			continue;
		}
		const e = embedRows[j];
		const p = phraseRows[j];
		if (!e || !p || isZeroVector(e) || isZeroVector(p)) {
			missing.push(filenames[i]);
			continue;
		}
		reusedEmbeddings[i] = e;
		reusedPhrases[i] = p;
		reused++;
	}
	return {
		usable: true,
		reason: "ok",
		reusedEmbeddings,
		reusedPhrases,
		missing,
		reused,
	};
}

// Precomputed per-row L2 norms for the image embeddings, so the hot rank
// scan does cosine as dot/(qNorm·rowNorm) — one mul + div per row instead
// of recomputing both norms every call. Embeddings are append-mostly
// (import adds rows, delete removes them) so the cache is keyed on
// (length, dim); saveLibrary also clears it so any in-place mutation
// (a migration rewriting rows) re-bounds on the next search (C-03).
let libraryNormCache = { key: null, norms: null };
function libraryNorms() {
	const l = loadLibrary();
	const key = `${l.embeddings.length}|${l.dim}`;
	if (libraryNormCache.key !== key) {
		const dim = l.dim;
		const norms = new Float32Array(l.embeddings.length);
		for (let i = 0; i < l.embeddings.length; i++) {
			const v = l.embeddings[i];
			let s = 0;
			if (v) for (let k = 0; k < dim; k++) s += v[k] * v[k];
			norms[i] = s > 0 ? Math.sqrt(s) : 0;
		}
		libraryNormCache = { key, norms };
	}
	return libraryNormCache.norms;
}

function cosine(a, b) {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

module.exports = {
	initLibraryStore,
	resetLibraryCaches,
	libraryGenerationNumber,
	embedFileFor,
	phraseFileFor,
	segmentsMetaFileFor,
	segmentsBinFileFor,
	transcriptsMetaFileFor,
	transcriptsBinFileFor,
	thumbFor,
	loadSampleQueries,
	readLibraryBins,
	loadLibrary,
	readBin,
	readBinPartial,
	encodeBin,
	EMBED_CODE_VERSION,
	embedMetaFileFor,
	readEmbedMeta,
	setEmbedIncomplete,
	isZeroVector,
	planDeltaReuse,
	libraryIndex,
	libraryNorms,
	enqueuePersist,
	writeFileAtomic,
	cachedLibraryBins,
	cachedSegmentsBin,
	cachedTranscriptsBin,
	writeBins,
	saveLibrary,
	fileMtimeMs,
	backfillSourceMtimes,
	loadSegments,
	saveSegments,
	removeSegmentsFor,
	removeSegmentsForAllModels,
	loadTranscripts,
	saveTranscripts,
	resetTranscriptsFor,
	removeTranscriptsFor,
	removeTranscriptsForAllModels,
	repairUntranscribedWithAudio,
	loadModelState,
	resetModelStateCache,
	saveModelState,
	thresholdsFor,
	binInfo,
	cosine,
};
