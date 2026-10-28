// Phase 2 (store/index-core): pure move from main-lib/library-store.js —
// paths + init, generation counter, index load/serve, mtime backfill. Owns
// every layout path (single owner) plus the in-memory index. Sibling domains
// are read through namespace imports (cycle-safe: this codebase's modules
// only touch siblings at call time, never at load time), with additive
// exports below so the namespace objects stay live.

import fs from "node:fs";
import path from "node:path";
import { loadCategoryOverrides } from "../category-overrides.ts";
import {
	getModel,
	type ModelConfig,
	getRetiredModelMigration,
	resolveModelId,
	DEFAULT_MODEL_ID,
} from "../../indexer/models.ts";
import * as bins from "./bins.ts";
import * as persist from "./persist.ts";
import * as sidecars from "./sidecars.ts";

export let DATA_DIR: string;
export let PHOTOS_DIR: string;
export let THUMBS_DIR: string;
export let INDEX_FILE: string;
export let LEGACY_EMBED_FILE: string;
export let LEGACY_PHRASE_FILE: string;
export let MODELS_STATE_FILE: string;
export let QUERIES_FILE: string;

export function initLibraryStore({
	userDataDir,
}: {
	userDataDir: string;
}): void {
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

let libraryGeneration = 0;
export function libraryGenerationNumber(): number {
	return libraryGeneration;
}

// Full state reset (model switch / test isolation): drops the in-memory
// library, all sidecar caches, and every memoized bin/norm payload so the

let sampleQueries: any;
export function loadSampleQueries(): any {
	if (sampleQueries) return sampleQueries;
	try {
		sampleQueries = JSON.parse(fs.readFileSync(QUERIES_FILE, "utf-8"));
	} catch {
		sampleQueries = { queries: [] };
	}
	return sampleQueries;
}

export function embedFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-embeddings-${modelId}.bin`);
}

export function phraseFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-phrase-embeddings-${modelId}.bin`);
}

// Scene-segment sidecars (Phase 1 of scene search): per-model, additive-only.
export function segmentsMetaFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-segments-${modelId}.json`);
}

export function segmentsBinFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-segment-embeddings-${modelId}.bin`);
}

// Transcript sidecars (speech index for scene search): per-model,
// additive-only. Each chunk is one {t0,t1,off,n,text} row (n always 1 —
// one embedding per ~30 s speech window). Keyed by FULL filename from day
// one (never the extension-stripped stem — do not repeat M-05).
export function transcriptsMetaFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-transcripts-${modelId}.json`);
}

export function transcriptsBinFileFor(modelId: string): string {
	return path.join(DATA_DIR, `memory-transcript-embeddings-${modelId}.bin`);
}

export function thumbFor(filename: string): string {
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

// In-memory index (uninitialized until loadLibrary; assigned in init order
// before any reader — see initLibraryStore). Every array is parallel to
// `filenames`; nulls are meaningful (see the per-field notes in loadLibrary).
export interface Library {
	filenames: string[];
	sources: string[];
	sourceMtimes: Array<number | null>;
	ocr: Array<string | null>;
	ocrWords: Array<Array<{ text?: unknown } | null> | null>;
	ocrRevision: number;
	ocrLangs: string | null;
	hashes: Array<string | null>;
	screenshotHints: Array<boolean | null>;
	embeddings: Float32Array[];
	phrases: Float32Array[];
	dim: number;
	/** Row count in the index/bins as loaded from disk. */
	diskRowCount: number;
	/** Phrase table dimension from the on-disk header, before rows load. */
	phraseDim: number;
	textMean: Float32Array | null;
	modelId: string;
	pendingModelMigration: { fromId: string; targetId: string } | null;
}

let library: Library | null = null;
// False until ensureLibraryBins() reads the primary/phrase rows. The getters
// below make every legacy `l.embeddings` / `l.phrases` read load on demand,
// so a metadata-only boot (timestamps, OCR, renderer index) never pages
// hundreds of megabytes of vectors into main.
let binsLoaded = false;

export function libraryBinsLoaded(): boolean {
	return binsLoaded;
}

export function ensureLibraryBins(): Library {
	const l = loadLibrary();
	if (binsLoaded) return l;
	// Use the row count captured from the index, not the live filenames
	// length: callers may mutate filenames before the first vector access
	// (import appends, delete splices), and the disk bin still has the
	// pre-mutation count.
	const expected = l.diskRowCount;
	if (l.pendingModelMigration || expected === 0 || l.dim <= 0) {
		binsLoaded = true;
		return l;
	}
	try {
		const [embeddings, phrases] = bins.readLibraryBins(
			l.modelId,
			expected,
			l.dim,
		);
		l.embeddings = embeddings;
		l.phrases = phrases;
		l.phraseDim = phrases.length === expected ? l.dim : 0;
		if (embeddings.length !== expected) {
			console.warn(
				`[memories] embedding bin misaligned (${embeddings.length}/${expected}); starting fresh`,
			);
			l.embeddings = [];
			l.phrases = [];
			l.phraseDim = 0;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[memories] embedding bin load failed: ${msg}`);
		l.embeddings = [];
		l.phrases = [];
		l.phraseDim = 0;
	}
	binsLoaded = true;
	return l;
}

// Reads the per-model bin pair, falling back to the legacy pre-v4 names when
// this model's own files don't exist yet (an upgrade from an old install: the
// old pair IS the default model's pair). Returns [embeddings, phrases].
export function loadLibrary(): Library {
	if (library) return library;
	fs.mkdirSync(PHOTOS_DIR, { recursive: true });
	const lib: Library = {
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
		diskRowCount: 0,
		phraseDim: 0,
		textMean: null,
		modelId: DEFAULT_MODEL_ID,
		// Set only while an index references a retired or unknown vision
		// model. Main re-embeds it before it ever persists the resolved model
		// id, so incompatible vectors can never be served as the replacement.
		pendingModelMigration: null,
	};
	let currentEmbeddings = lib.embeddings;
	let currentPhrases = lib.phrases;
	Object.defineProperty(lib, "embeddings", {
		enumerable: true,
		configurable: true,
		get() {
			ensureLibraryBins();
			return currentEmbeddings;
		},
		set(value: Float32Array[]) {
			currentEmbeddings = value;
			binsLoaded = true;
		},
	});
	Object.defineProperty(lib, "phrases", {
		enumerable: true,
		configurable: true,
		get() {
			ensureLibraryBins();
			return currentPhrases;
		},
		set(value: Float32Array[]) {
			currentPhrases = value;
			binsLoaded = true;
		},
	});
	library = lib;
	binsLoaded = false;
	try {
		const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
		const images = Array.isArray(index.images) ? index.images : [];
		library.diskRowCount = images.length;
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
				// Metadata only: probe headers, not rows. Mirror
				// readLibraryBins' pairing rule so phraseDim describes the
				// table a real load would actually use. The first rank/bin
				// request calls ensureLibraryBins().
				const primaryEmbed = bins.readBinHeader(embedFileFor(library.modelId));
				let phraseHeader: { count: number; dim: number } | null = null;
				if (
					primaryEmbed &&
					primaryEmbed.count === images.length &&
					primaryEmbed.dim === dim
				) {
					phraseHeader = bins.readBinHeader(phraseFileFor(library.modelId));
				} else {
					const legacyEmbed = bins.readBinHeader(LEGACY_EMBED_FILE);
					if (
						legacyEmbed &&
						legacyEmbed.count === images.length &&
						legacyEmbed.dim === dim
					) {
						phraseHeader = bins.readBinHeader(LEGACY_PHRASE_FILE);
					}
				}
				library.phraseDim =
					phraseHeader &&
					phraseHeader.count === images.length &&
					phraseHeader.dim === dim
						? dim
						: 0;
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[memories] no library on disk (${msg}); starting fresh`);
	}
	if (
		library.filenames.length === 0 ||
		library.dim <= 0 ||
		library.pendingModelMigration
	) {
		binsLoaded = true;
	}
	return library;
}

export function libraryIndex(): {
	version: number;
	modelId: string;
	dim: any;
	phraseDim: number;
	generatedAt: string;
	images: string[];
	sources: string[];
	sourceMtimes: Array<number | null>;
	ocr: Array<string | null>;
	ocrWords: Array<Array<{ text?: unknown } | null> | null>;
	ocrRevision: number;
	ocrLangs: string | null;
	hashes: Array<string | null>;
	screenshotHints: Array<boolean | null>;
	categoryOverrides: Record<string, string>;
	textMean: number[] | undefined;
} {
	const l = loadLibrary();
	// Do not touch l.phrases here: the getter would defeat lazy load on every
	// renderer index fetch. The header probe in loadLibrary already set the
	// on-disk value; once rows are loaded, keep it in sync.
	const phraseDim = libraryBinsLoaded()
		? l.phrases.length === l.filenames.length
			? l.dim
			: 0
		: l.phraseDim;
	// Cast: the default id is always in the registry — the fallback can only
	// miss when the registry itself lost the default (never).
	const config =
		getModel(l.modelId) || (getModel(DEFAULT_MODEL_ID) as ModelConfig);
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

export function fileMtimeMs(filePath: string): number | null {
	if (!filePath) return null;
	try {
		const mtime = Number(fs.statSync(filePath).mtimeMs);
		return Number.isFinite(mtime) ? mtime : null;
	} catch {
		return null;
	}
}

export async function backfillSourceMtimes(): Promise<number> {
	const l = loadLibrary();
	if (!l || l.filenames.length === 0) return 0;
	if (!Array.isArray(l.sourceMtimes)) l.sourceMtimes = [];

	let changed = false;
	let filled = 0;
	for (let i = 0; i < l.filenames.length; i++) {
		if (Number.isFinite(l.sourceMtimes[i])) continue;
		const source = l.sources[i];
		// Bounds-proven casts: sources may be shorter than filenames (legacy
		// libraries) and fileMtimeMs treats a missing value as null, exactly
		// like the untyped code did.
		const mtime =
			fileMtimeMs(source as string) ??
			fileMtimeMs(path.join(PHOTOS_DIR, l.filenames[i] as string));
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
		await persist.saveLibrary();
		console.log(
			`[memories] chronology backfill: recorded ${filled} source timestamp(s)`,
		);
	}
	return filled;
}

// Bumped whenever main's view of the library can diverge from disk (save,
// reset, bin write) — same counter the rank worker generation-syncs on.
export function bumpLibraryGeneration(): void {
	libraryGeneration++;
}

// Reset the index + fan out to the modules owning the other caches (same
// resets, same order as the verbatim block this replaces: segments,
// transcripts, bins, norms).
export function resetLibraryCaches(): void {
	libraryGeneration++;
	library = null;
	binsLoaded = false;
	sidecars.resetSidecarCaches();
	bins.resetBinCaches();
}
