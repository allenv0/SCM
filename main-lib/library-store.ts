// Phase 2 (store): facade over main-lib/store/*.ts — the public surface is
// byte-identical to the old monolith (same 49 exports, same behavior) plus
// the lazy-bin helpers (`ensureLibraryBins` / `libraryBinsLoaded`) used by
// mutation sites that must materialize rows before changing filenames.
// test/library-store.test.js requires this path unchanged.
//
// The per-name `exports.*` assignments of the CJS facade became grouped
// ESM re-exports: the emitted CJS uses Object.defineProperty getters (the
// standard TS emit, which node's cjs-module-lexer reads), and converted
// ESM consumers get real live bindings.

export {
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
	loadLibrary,
	ensureLibraryBins,
	libraryBinsLoaded,
	libraryIndex,
	fileMtimeMs,
	backfillSourceMtimes,
} from "./store/index-core.ts";

export {
	readLibraryBins,
	readBin,
	readBinPartial,
	encodeBin,
	libraryNorms,
	cachedLibraryBins,
	writeBins,
	cosine,
} from "./store/bins.ts";

export {
	cachedSegmentsBin,
	cachedTranscriptsBin,
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
} from "./store/sidecars.ts";

export {
	enqueuePersist,
	writeFileAtomic,
	saveLibrary,
} from "./store/persist.ts";

export {
	EMBED_CODE_VERSION,
	embedMetaFileFor,
	readEmbedMeta,
	setEmbedIncomplete,
	isZeroVector,
	planDeltaReuse,
	loadModelState,
	resetModelStateCache,
	saveModelState,
	thresholdsFor,
	binInfo,
} from "./store/model-state.ts";
