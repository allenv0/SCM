"use client";

import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import {
	keywordMatchMemories,
	ocrMatchMemories,
	MIN_SEMANTIC_SCORE,
	RELATIVE_KEEP,
	type RankedMemory,
	type MemoryEntry,
} from "@/lib/memoryRank";
import { isVideoFile } from "@/lib/media";
import type { OcrWordBox } from "@/lib/ocrHighlights";
import { cosineSimilarity } from "@/lib/semanticUtils";
import { initialSearchStatus, searchStatusReducer } from "@/lib/searchStatus";
import type {
	MigratePhase,
	ModelInfo,
	ModelsManifest,
	SetModelResult,
} from "@/types";

const INDEX_URL = "/memories-index.json";
const EMBEDDINGS_URL = "/memory-embeddings.bin";
const PHRASE_EMBEDDINGS_URL = "/memory-phrase-embeddings.bin";
const MODELS_URL = "/memories-models.json";
const SEGMENTS_URL = "/memory-segments.json";
const SEGMENT_EMBEDDINGS_URL = "/memory-segment-embeddings.bin";
const QUERY_CACHE_MAX = 100;

// One shot segment: t = midpoint frame to seek to, dur = shot span, off =
// row index into the shared segment bin, poster = scene-poster index
// (see DESIGN-SCENE-SEARCH.md §5 and media.ts scenePosterFor).
interface SceneSegment {
	t: number;
	dur: number;
	off: number;
	poster: number;
}

// A scene must beat the file-level evidence by this much to re-rank the
// video within the candidate window (pure-CLIP segment cosine vs the hybrid
// file score — only a clear win is trusted). Generous on purpose: a single
// frame is noisier evidence than a whole file, so a marginally-better
// segment must not rewrite the file ranking.
const SEGMENT_UPGRADE_MARGIN = 0.05;

// How many file-level-culled videos a strong scene may rescue per search.
// Bounded so a video library can never flood the results grid.
const RESCUE_MAX = 3;

// Per-video cap in deep "Scenes" mode: one movie must not flood the grid
// with its best 20 shots, however semantically rich it is.
const SCENES_PER_VIDEO = 3;

// A query whose segments clear the scene ranking's own cutoff almost
// EVERYWHERE has no discriminative scene evidence — gibberish /
// ultra-generic queries embed near the text centroid, so every movie
// frame scores hot and the same long films (max over 128 shots each)
// surface for EVERY query. Measured on a real movie-heavy library:
// gibberish queries clear their cutoff on 30-50%+ of segments, genuine
// ones on <10% (a tiny solid-color fixture sits at ~7%). Above this
// fraction, Scenes mode returns "no scene match" and the files-mode
// scene pass stands down instead of wallpapering the grid with the same
// films.
const SCENE_NOISE_FRACTION = 0.25;

// The fraction gate above is statistically meaningless on a tiny corpus —
// with a handful of segments each one is ~10% and any two-shot video trips
// it, so small libraries would get "no scene match" for genuine queries.
// Below this many scored segments the gate stands down and the ranking
// cutoff alone decides (movie-heavy libraries, where the gate matters,
// always clear it).
const SCENE_NOISE_MIN_SEGMENTS = 20;

// Desktop variant of the site's useMemorySearch: the CLIP model lives in the
// Electron main process (indexer worker), so the query-embedding path is a
// thin IPC call instead of a web worker + transformers.js download. Ranking
// math is unchanged. Query vectors come back ALREADY centered against the
// shared text direction (main owns that), so the renderer does no centering.

export function useMemorySearch(filenames: string[]) {
	// L2 FP: search lifecycle as one pure reducer (see lib/searchStatus.ts).
	// Models/migration/preloads stay as useStates — different domain.
	const [status, dispatchStatus] = useReducer(
		searchStatusReducer,
		initialSearchStatus,
	);
	const { isReady, isSearching, error, sceneDataReady } = status;
	// OCR rectangles keyed by filename. They are needed only to mark literal
	// text hits on result tiles; semantic ranking still consumes OCR text from
	// the aligned ref below.
	const [ocrWordBoxesByFilename, setOcrWordBoxesByFilename] = useState<
		ReadonlyMap<string, OcrWordBox[]>
	>(() => new Map());

	// Model registry manifest (what the picker shows + which thresholds the
	// active model's score band needs). null until the first fetch lands.
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [activeModelId, setActiveModelId] = useState<string | null>(null);
	// Live per-model weight downloads ("Download all models"): modelId →
	// { phase, progress }. Populated from "model-preload" status events.
	const [modelPreloads, setModelPreloads] = useState<
		Record<
			string,
			{ phase: "loading" | "ready" | "error"; progress: number | null }
		>
	>({});
	// Live model migration progress; null while no migration is running.
	const [migration, setMigration] = useState<{
		phase: MigratePhase;
		done: number;
		total: number;
		modelId: string;
	} | null>(null);

	const filenamesRef = useRef<string[]>([]);
	const embeddingsRef = useRef<Float32Array[] | null>(null);
	const phraseEmbeddingsRef = useRef<Float32Array[] | null>(null);
	// OCR text extracted from each image (visible text on posters/screenshots),
	// aligned 1:1 with filenames. null/undefined = not OCR'd yet; "" = no
	// text found. Injected into keyword matching + the hybrid OCR boost.
	const ocrTextsRef = useRef<(string | null | undefined)[] | null>(null);
	const dimRef = useRef(0);
	// Scene-segment cache (Phase 1 of scene search): fetched lazily only after
	// a search returns video results, so the happy path never pays for it.
	const segmentsVideosRef = useRef<Map<string, SceneSegment[]> | null>(null);
	const segmentRowsRef = useRef<Float32Array[] | null>(null);
	const segmentDimRef = useRef(0);
	// Retry guard: enrichment runs AFTER the library-updated broadcast, so the
	// sidecar may not exist yet on the first video search. Absent is NOT
	// permanent — retry after a cooldown; only a cache hit ends the retries.
	const segmentsAttemptedRef = useRef(false);
	const segmentsRetryAtRef = useRef(0);
	// Latest manifest, readable from the (dependency-free) search callback.
	const manifestRef = useRef<ModelsManifest | null>(null);
	const loadPromiseRef = useRef<Promise<void> | null>(null);
	const queryCacheRef = useRef<Map<string, Float32Array>>(new Map());
	const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monotonic generation of the index: bumped by invalidateIndex. An
	// in-flight load captures the generation it started at and discards its
	// result if a newer load superseded it — otherwise a slow fetch that
	// began before a library-update could resolve AFTER the fresh reload and
	// clobber it with stale embeddings.
	const loadGenRef = useRef(0);
	// Cache the index fingerprint (count, dim, modelId) so redundant
	// library-updated events (enrichment ticks, OCR ticks) skip the
	// expensive full re-fetch + parse when nothing changed.
	const indexFingerprintRef = useRef<string | null>(null);

	useEffect(() => {
		filenamesRef.current = filenames;
	}, [filenames]);

	// Refetch ONLY the model manifest (registry + per-model downloaded flags)
	// after a background weight download completes, so the picker's chips
	// flip without a full index reload. Cheaper than loadIndexData, which
	// also re-fetches the (potentially large) embedding bins.
	const refreshModels = useCallback(async () => {
		try {
			const resp = await fetch(MODELS_URL);
			if (!resp.ok) return;
			const manifest = (await resp.json()) as ModelsManifest;
			if (manifest && Array.isArray(manifest.models)) {
				manifestRef.current = manifest;
				setModels(manifest.models);
				setActiveModelId(manifest.activeModelId ?? null);
			}
		} catch {
			/* keep the last-known manifest on transient failures */
		}
	}, []);

	// Model failure (mirrored via the preload bridge) surfaces as a search
	// error; App owns the full model lifecycle for the search bar's LED. A
	// failure also ends any migration in flight, and a completed (or
	// interrupted) migration clears its own progress pill — the flip's
	// library-updated broadcast arrives right after the final "indexing"
	// migrate event.
	useEffect(() => {
		return window.memories?.onStatus?.((payload) => {
			if (payload.type === "model" && payload.phase === "error") {
				dispatchStatus({ type: "status/model-error" });
				setMigration(null);
			} else if (payload.type === "migrate") {
				setMigration(payload);
			} else if (payload.type === "library-updated") {
				setMigration(null);
			} else if (payload.type === "model-preload") {
				// A background weight download for a model the user isn't
				// switching to (the picker's Download chips / "download all").
				setModelPreloads((prev) => ({
					...prev,
					[payload.modelId]: {
						phase: payload.phase,
						progress: payload.progress ?? null,
					},
				}));
				// A completed download changes the manifest's downloaded flag;
				// refresh so the picker flips its chips without a restart.
				if (payload.phase === "ready" || payload.phase === "error") {
					void refreshModels();
				}
			}
		});
	}, []);

	const loadIndexData = useCallback((): Promise<void> => {
		if (loadPromiseRef.current) return loadPromiseRef.current;
		const gen = loadGenRef.current;
		loadPromiseRef.current = (async () => {
			try {
				const [indexResp, embBuf, phraseBuf, modelsResp] = await Promise.all([
					fetch(INDEX_URL).then((r) => r.json()),
					fetch(EMBEDDINGS_URL)
						.then((r) => r.arrayBuffer())
						.catch(() => null),
					fetch(PHRASE_EMBEDDINGS_URL)
						.then((r) => r.arrayBuffer())
						.catch(() => null),
					fetch(MODELS_URL)
						.then((r) => (r.ok ? r.json() : null))
						.catch(() => null),
				]);
				const index = indexResp as {
					images?: string[];
					dim?: number;
					ocr?: (string | null | undefined)[];
					ocrWords?: (OcrWordBox[] | null | undefined)[];
					ocrRevision?: number;
					modelId?: string;
				};
				const ordered = index.images?.length
					? index.images
					: filenamesRef.current;
				// Parse everything into LOCALS first. The generation guard
				// below decides whether this load is still current — a stale
				// load (one that began before a library-update invalidated
				// the cache) must not write ANY ref, or it would clobber the
				// fresh reload's data with misaligned rows and silently
				// degrade every search to keyword matching until the next
				// reload (the ranker's alignment guard bails on mismatched
				// counts, and a same-count stale bin ranks against the wrong
				// vectors). Commit only after the guard passes.
				let ocrTexts: (string | null | undefined)[] | null = null;
				let ocrWordBoxes: (OcrWordBox[] | null | undefined)[] | null = null;
				let embeddings: Float32Array[] | null = null;
				let phrases: Float32Array[] | null = null;
				let dim = 0;
				// OCR text rides the index (model-independent, parallel to
				// images). Aligned to `ordered` — the same array embeddings
				// are keyed against — so rankers can trust the index.
				if (Array.isArray(index.ocr)) {
					ocrTexts = index.ocr.slice(0, ordered.length);
				}
				if (Array.isArray(index.ocrWords)) {
					ocrWordBoxes = index.ocrWords.slice(0, ordered.length);
				}
				if (embBuf && index.dim && index.dim > 0) {
					const num = new Int32Array(embBuf, 0, 1)[0];
					const binDim = new Int32Array(embBuf, 4, 1)[0];
					if (binDim === index.dim && num === ordered.length) {
						dim = binDim;
						embeddings = Array.from(
							{ length: num },
							(_, i) => new Float32Array(embBuf, 8 + i * binDim * 4, binDim),
						);
					} else {
						console.warn(
							"[memory-search] memory-embeddings.bin header " +
								`(${num}x${binDim}) does not match index ` +
								`(${ordered.length}x${index.dim}); falling back to keyword search`,
						);
					}
				}
				if (phraseBuf && index.dim && index.dim > 0) {
					const num = new Int32Array(phraseBuf, 0, 1)[0];
					const binDim = new Int32Array(phraseBuf, 4, 1)[0];
					if (binDim === index.dim && num === ordered.length) {
						phrases = Array.from(
							{ length: num },
							(_, i) => new Float32Array(phraseBuf, 8 + i * binDim * 4, binDim),
						);
					} else {
						console.warn(
							"[memory-search] memory-phrase-embeddings.bin " +
								`header (${num}x${binDim}) does not match index ` +
								`(${ordered.length}x${index.dim}); using image-only ranking`,
						);
					}
				}
				// A library-update may have invalidated + reloaded while this
				// fetch was in flight — never let a stale load win. Guard
				// FIRST, commit refs only if this load is still current.
				if (gen !== loadGenRef.current) return;
				ocrTextsRef.current = ocrTexts;
				setOcrWordBoxesByFilename(
					new Map(
						ordered.map(
							(filename, index) =>
								[filename, ocrWordBoxes?.[index] ?? []] as const,
						),
					),
				);
				// Record fingerprint so redundant library-updated events skip
				// the full re-fetch + parse when nothing changed.
				indexFingerprintRef.current = `${ordered.length}-${dim}-${index.modelId || ""}-${index.ocrRevision ?? 0}`;
				embeddingsRef.current = embeddings;
				phraseEmbeddingsRef.current = phrases;
				dimRef.current = dim;
				const manifest = modelsResp as ModelsManifest | null;
				if (manifest && Array.isArray(manifest.models)) {
					manifestRef.current = manifest;
					setModels(manifest.models);
					setActiveModelId(manifest.activeModelId ?? null);
				}
				dispatchStatus({ type: "index/ready" });
			} catch (e: any) {
				if (gen !== loadGenRef.current) return;
				dispatchStatus({
					type: "index/error",
					error: `Failed to load memory index: ${e?.message ?? e}`,
				});
				loadPromiseRef.current = null;
			}
		})();
		return loadPromiseRef.current;
	}, []);

	useEffect(() => {
		void loadIndexData();
	}, [loadIndexData]);

	// The index trio (index.json + two .bin files) is written atomically by
	// the main process after every import batch. The renderer used to fetch
	// it exactly once at mount and cache forever, so photos imported in the
	// same session were invisible to search (the ranker's alignment guard
	// then bailed: N filenames vs M != N embeddings). Invalidate + reload
	// whenever the library changes.
	const invalidateIndex = useCallback(() => {
		loadPromiseRef.current = null;
		loadGenRef.current++;
		embeddingsRef.current = null;
		phraseEmbeddingsRef.current = null;
		ocrTextsRef.current = null;
		setOcrWordBoxesByFilename(new Map());
		dimRef.current = 0;
		queryCacheRef.current.clear();
		// Scene segments are per-model sidecars — stale on any library change.
		segmentsVideosRef.current = null;
		segmentRowsRef.current = null;
		segmentDimRef.current = 0;
		segmentsAttemptedRef.current = false;
		dispatchStatus({ type: "index/invalidate" });
	}, []);

	// library-updated fires once per completed import batch (main.js); a
	// small coalesce window keeps a flurry of batches to one reload.
	// Before invalidating, check the index fingerprint: enrichment/OCR
	// ticks broadcast library-updated but the embedding bins haven't
	// changed, so a cheap HEAD-equivalent (fetch index JSON, compare
	// count+dim+model) lets us skip the expensive bin re-fetch + parse.
	const reloadIndex = useCallback(async () => {
		try {
			const idxResp = (await fetch(INDEX_URL).then((r) => r.json())) as {
				images?: string[];
				dim?: number;
				modelId?: string;
				ocrRevision?: number;
			};
			const fp = `${idxResp.images?.length ?? 0}-${idxResp.dim ?? 0}-${idxResp.modelId ?? ""}-${idxResp.ocrRevision ?? 0}`;
			if (fp === indexFingerprintRef.current) return; // same index, skip
		} catch {
			/* network/parse error — force reload below */
		}
		invalidateIndex();
		if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
		reloadTimerRef.current = setTimeout(() => {
			reloadTimerRef.current = null;
			void loadIndexData();
		}, 150);
	}, [invalidateIndex, loadIndexData]);

	// Library changes invalidate the cached index + embeddings so the next
	// search ranks against the fresh index.
	useEffect(() => {
		return window.memories?.onStatus?.((payload) => {
			if (payload.type === "library-updated") reloadIndex();
		});
	}, [reloadIndex]);

	// Self-heal: if we already have embeddings but the library size changed
	// underneath us (an import we never got an event for, or an event that
	// fired before this effect), reload so the ranker's alignment guard
	// never bails on a stale cache.
	useEffect(() => {
		if (
			embeddingsRef.current !== null &&
			embeddingsRef.current.length !== filenames.length
		) {
			reloadIndex();
		}
	}, [filenames, reloadIndex]);

	// Embed the query through the indexer (main process). Returns the
	// centered query vector, or null on any failure so the caller can fall
	// back to keyword matching.
	const embedQuery = useCallback(
		async (query: string): Promise<Float32Array | null> => {
			const cacheKey = query.toLowerCase().slice(0, 128);
			const cached = queryCacheRef.current.get(cacheKey);
			if (cached) return cached;

			dispatchStatus({ type: "search/start" });
			try {
				const vec = await window.memories.embedQuery(query);
				if (!vec) return null;
				if (dimRef.current > 0 && vec.length !== dimRef.current) {
					console.warn(
						"[memory-search] Query embedding dim " +
							`(${vec.length}) does not match index dim ` +
							`(${dimRef.current}); falling back to keyword search`,
					);
					return null;
				}
				const centered = new Float32Array(vec);
				queryCacheRef.current.set(cacheKey, centered);
				if (queryCacheRef.current.size > QUERY_CACHE_MAX) {
					const firstKey = queryCacheRef.current.keys().next().value;
					if (firstKey) queryCacheRef.current.delete(firstKey);
				}
				return centered;
			} catch (e: any) {
				console.warn("[memory-search] Embed query failed:", e);
				return null;
			} finally {
				dispatchStatus({ type: "search/end" });
			}
		},
		[],
	);

	// Whether this query has any discriminative scene evidence at all: the
	// fraction of segments whose cosine clears the SCENE RANKING'S OWN
	// CUTOFF (the bar a hit must beat anyway) must stay small. A query that
	// matches ~everything (gibberish / ultra-generic text embeds near the
	// centroid, so every movie frame scores hot) has nothing specific to
	// say about any video — its "best scenes" are noise, and the same long
	// films (more shots = higher max over more draws) surface for every
	// such query. Genuine queries clear the cutoff on a handful of
	// segments (<10% of a movie library; <25% on a tiny fixture), while
	// gibberish floods it (30-50%+). Shared by search() (files-mode
	// upgrade + rescue stand down) and searchScenes (empty grid instead of
	// a wall of identical films).
	function hasDiscriminativeSceneEvidence(
		scene: {
			videos: Map<string, SceneSegment[]>;
			rows: Float32Array[];
			dim: number;
		},
		qVec: Float32Array,
		cutoff: number,
	): boolean {
		let total = 0;
		let above = 0;
		for (const segments of scene.videos.values()) {
			for (const seg of segments) {
				const row = scene.rows[seg.off];
				if (!row || row.length !== scene.dim) continue;
				total++;
				if (cosineSimilarity(qVec, row) >= cutoff) above++;
			}
		}
		if (total === 0) return false;
		return above / total <= SCENE_NOISE_FRACTION;
	}

	// Rescue candidates: enriched videos the file-level window culled whose
	// BEST scene still clears `cutoff` — evidence the 20/50/80% sample
	// frames erased. Shared by the in-window search path (cutoff = the file
	// ranking's window) and the empty-window path (cutoff = minScore, the
	// only bar available when the file ranking found nothing at all).
	// Returns entries scored by the RAW segment cosine, sorted desc.
	function sceneRescueCandidates(
		scene: {
			videos: Map<string, SceneSegment[]>;
			rows: Float32Array[];
			dim: number;
		},
		qVec: Float32Array,
		cutoff: number,
		excluded: Set<string>,
	): RankedMemory[] {
		const rescued: RankedMemory[] = [];
		for (const [filename, segments] of scene.videos) {
			if (excluded.has(filename) || segments.length === 0) continue;
			let bestScore = -Infinity;
			let bestSeg: SceneSegment | null = null;
			for (const seg of segments) {
				const row = scene.rows[seg.off];
				if (!row || row.length !== scene.dim) continue;
				const s = cosineSimilarity(qVec, row);
				if (s > bestScore) {
					bestScore = s;
					bestSeg = seg;
				}
			}
			if (bestSeg && bestScore >= cutoff) {
				rescued.push({
					filename,
					score: bestScore,
					bestScene: {
						t: bestSeg.t,
						dur: bestSeg.dur,
						poster: bestSeg.poster,
						score: bestScore,
					},
				});
			}
		}
		return rescued.sort((a, b) => b.score - a.score);
	}

	// Lazy, fire-and-forget scene-segment load: one pair of fetches, cached
	// for the session, invalidated with the index trio. Never blocks search —
	// the caller renders results first and prefetches after. The desktop
	// serves these routes (Phase 1); the site build's fetches 404 harmlessly.
	const ensureSegments = useCallback(async (): Promise<boolean> => {
		if (segmentsVideosRef.current) return true;
		const now = Date.now();
		if (segmentsAttemptedRef.current && now < segmentsRetryAtRef.current) {
			return false;
		}
		segmentsAttemptedRef.current = true;
		segmentsRetryAtRef.current = now + 10000;
		// Capture the index generation: a library change mid-fetch must not
		// commit segments that describe the OLD library (stale t/off rows,
		// stale row space) — invalidateIndex resets the cache refs, so this
		// fetch would otherwise repopulate them with garbage for the new
		// library until the next change.
		const gen = loadGenRef.current;
		try {
			const [meta, buf] = await Promise.all([
				fetch(SEGMENTS_URL)
					.then((r) => (r.ok ? r.json() : null))
					.catch(() => null),
				fetch(SEGMENT_EMBEDDINGS_URL)
					.then((r) => r.arrayBuffer())
					.catch(() => null),
			]);
			if (!meta || meta.ok === false || !buf) return false;
			const dim = Number(meta.dim) || 0;
			const header = new Int32Array(buf, 0, 2);
			if (
				dim <= 0 ||
				header[0] !== (Number(meta.total) || 0) ||
				header[1] !== dim
			) {
				console.warn(
					"[memory-search] segment bin header mismatch; ignoring scene data",
				);
				return false;
			}
			const videos = new Map<string, SceneSegment[]>();
			for (const v of meta.videos ?? []) {
				const segments = (v.segments ?? []).filter(
					(s: SceneSegment) =>
						Number.isFinite(s.t) &&
						Number.isFinite(s.off) &&
						s.off >= 0 &&
						s.off < header[0],
				);
				videos.set(v.filename, segments);
			}
			// Guard FIRST, commit only if this fetch is still current — a
			// stale fetch must never repopulate a cache invalidateIndex just
			// cleared.
			if (gen !== loadGenRef.current) return false;
			segmentRowsRef.current = Array.from(
				{ length: header[0] },
				(_, i) => new Float32Array(buf, 8 + i * dim * 4, dim),
			);
			segmentsVideosRef.current = videos;
			segmentDimRef.current = dim;
			dispatchStatus({ type: "scene/ready" });
			return true;
		} catch (e: any) {
			console.warn(
				"[memory-search] Scene-segment load failed:",
				e?.message ?? e,
			);
			return false;
		}
	}, []);

	// Phase-2 surface: the loaded scene index (filename → segments, shared
	// row space) or null when unavailable. Consumed for bestScene badges and
	// seek-on-open; exposing it now keeps the Phase-1 plumbing testable.
	const getSceneIndex = useCallback((): {
		videos: Map<string, SceneSegment[]>;
		rows: Float32Array[];
		dim: number;
	} | null => {
		if (!segmentsVideosRef.current || !segmentRowsRef.current) return null;
		return {
			videos: segmentsVideosRef.current,
			rows: segmentRowsRef.current,
			dim: segmentDimRef.current,
		};
	}, []);

	// The ACTIVE model's calibrated score band (minSemanticScore /
	// relativeKeep) — see search(). Shared by search and searchScenes so
	// both gate on the same honesty thresholds.
	const currentThresholds = useCallback(() => {
		const manifest = manifestRef.current;
		const active =
			manifest?.models.find((m) => m.id === manifest.activeModelId) ?? null;
		return active?.thresholds ?? null;
	}, []);
	const search = useCallback(
		async (query: string, topK = 24): Promise<RankedMemory[]> => {
			const trimmed = query.trim();
			if (!trimmed || filenamesRef.current.length === 0) return [];

			// File-level ranking on the main process (O(N × dim) cosine scan
			// runs off the renderer's main thread). The IPC handler embeds the
			// query and ranks against the in-memory library in one call.
			let results: RankedMemory[];
			// M-11 single round-trip: memories:rank returns an ARRAY with an
			// extra `queryVec` prop so scene/transcript fusion never re-embeds.
			// Both shapes accepted: array-with-prop (current main) and legacy
			// {results, queryVec} / bare array (older mains, tests).
			let rankQueryVec: Float32Array | null = null;
			try {
				const rankedRaw = (await window.memories.rankSearch(trimmed, topK)) as
					| (RankedMemory[] & { queryVec?: number[] | null })
					| { results?: RankedMemory[]; queryVec?: number[] | null }
					| null
					| undefined;
				const ranked = Array.isArray(rankedRaw)
					? rankedRaw
					: (rankedRaw?.results ?? []);
				const qv = (
					rankedRaw as { queryVec?: number[] | null } | null | undefined
				)?.queryVec;
				results = (ranked || []).map((r) => ({
					filename: r.filename,
					score: r.score,
					dominant: r.dominant,
					breakdown: r.breakdown,
				}));
				if (qv && qv.length > 0) {
					rankQueryVec = new Float32Array(qv);
					const cacheKey0 = trimmed.toLowerCase().slice(0, 128);
					queryCacheRef.current.set(cacheKey0, rankQueryVec);
					if (queryCacheRef.current.size > QUERY_CACHE_MAX) {
						const first = queryCacheRef.current.keys().next().value;
						if (first !== undefined) queryCacheRef.current.delete(first);
					}
				}
			} catch {
				results = [];
			}

			if (results.length === 0) {
				const memories: MemoryEntry[] = filenamesRef.current.map(
					(filename) => ({ filename }),
				);
				// Filename-only fallback: Files mode is semantic + filename
				// evidence — text matching belongs to the OCR tab, which also
				// covers the model-down case.
				return keywordMatchMemories(trimmed, memories, topK);
			}

			// Scene upgrade (Phase 2): attach each video's best matching
			// scene segment. Runs on the already-filtered results (topK ≤ 96),
			// so the per-segment cosine math is lightweight on the renderer.
			const libraryHasVideos = filenamesRef.current.some((f) => isVideoFile(f));
			if (libraryHasVideos) {
				await ensureSegments();
				const scene = getSceneIndex();
				// Single round-trip (M-11): prefer the query vector that
				// arrived with the rank response; fall back to cache, then
				// a direct embed only when the rank path could not supply it.
				// Use a direct IPC call to avoid the isSearching flash —
				// file-level results are already on screen.
				let qVec: Float32Array | null = rankQueryVec;
				const cacheKey = trimmed.toLowerCase().slice(0, 128);
				const cached = queryCacheRef.current.get(cacheKey);
				if (!qVec && cached) {
					qVec = cached;
				} else if (!qVec) {
					try {
						const vec = await window.memories.embedQuery(trimmed);
						if (vec && vec.length > 0) {
							qVec = new Float32Array(vec);
							queryCacheRef.current.set(cacheKey, qVec);
						}
					} catch {
						/* scene upgrade is optional */
					}
				}
				if (scene && qVec) {
					const thresholds = currentThresholds();
					const cutoff = Math.max(
						thresholds?.minSemanticScore ?? MIN_SEMANTIC_SCORE,
						results[0].score * (thresholds?.relativeKeep ?? RELATIVE_KEEP),
					);
					if (!hasDiscriminativeSceneEvidence(scene, qVec, cutoff)) {
						return results;
					}
					const bestSegmentFor = (segments: SceneSegment[]) => {
						let bestScore = -Infinity;
						let bestSeg: SceneSegment | null = null;
						for (const seg of segments) {
							const row = scene.rows[seg.off];
							if (!row || row.length !== scene.dim) continue;
							const s = cosineSimilarity(qVec, row);
							if (s > bestScore) {
								bestScore = s;
								bestSeg = seg;
							}
						}
						return { bestScore, bestSeg };
					};
					const upgraded: RankedMemory[] = [];
					for (const r of results) {
						const segments = isVideoFile(r.filename)
							? scene.videos.get(r.filename)
							: undefined;
						let entry: RankedMemory = { ...r, bestScene: null };
						if (segments && segments.length > 0) {
							const { bestScore, bestSeg } = bestSegmentFor(segments);
							if (bestSeg && bestScore > -Infinity) {
								entry = {
									...r,
									score:
										bestScore > r.score + SEGMENT_UPGRADE_MARGIN
											? bestScore
											: r.score,
									bestScene: {
										t: bestSeg.t,
										dur: bestSeg.dur,
										poster: bestSeg.poster,
										score: bestScore,
									},
								};
							}
						}
						upgraded.push(entry);
					}
					const inWindow = new Set(upgraded.map((r) => r.filename));
					const rescued = sceneRescueCandidates(scene, qVec, cutoff, inWindow);
					const rescuedFinal = rescued.slice(0, RESCUE_MAX);
					const rescuedNames = new Set(rescuedFinal.map((r) => r.filename));
					return [...upgraded, ...rescuedFinal]
						.sort((a, b) => {
							const aRescued = rescuedNames.has(a.filename);
							const bRescued = rescuedNames.has(b.filename);
							if (aRescued !== bRescued) return aRescued ? 1 : -1;
							return b.score - a.score;
						})
						.slice(0, topK);
				}
			}
			return results;
		},
		[embedQuery, ensureSegments, getSceneIndex, currentThresholds],
	);

	// Phase 3 — deep "Scenes" mode: score EVERY segment across every video
	// (one cached sidecar fetch, then in-renderer math) and return
	// scene-level hits with exact timecodes. Opt-in via the UI toggle;
	// default search is untouched. Same honesty gates as the file ranking
	// (minScore floor + relative cutoff), plus a per-video cap so one long
	// movie can't flood the grid. Every returned row carries bestScene, so
	// the card badge, poster swap, and seek-on-open work unchanged.
	const searchScenes = useCallback(
		async (query: string, topK = 24): Promise<RankedMemory[]> => {
			const trimmed = query.trim();
			if (!trimmed || filenamesRef.current.length === 0) return [];

			// Warm the renderer-side segment index in the background: the fused
			// IPC below answers moments on its own, but badges/seek-on-open and
			// the empty-state copy (sceneDataReady) still read the local index.
			// Without this, a fused-only session never flips sceneDataReady and
			// the Scenes empty state permanently reads "still being prepared"
			// even for a definitive no-match (caught by scene-noise-test).
			void ensureSegments();

			// Main path (N-01): main scores visual segment rows (pure
			// visual, legacy-exact) and returns moments. Falls back to local
			// visual math when the bridge is unavailable (tests, older main).
			try {
				if (typeof window.memories?.rankScenes === "function") {
					const fused = (await window.memories.rankScenes(trimmed, topK)) as
						| {
								filename: string;
								score: number;
								t: number;
								dur: number;
								poster: number;
								why?: "visual" | "text" | "both";
								snippet?: string | null;
						  }[]
						| null
						| undefined;
					if (Array.isArray(fused)) {
						return fused.map((f) => ({
							filename: f.filename,
							score: f.score,
							bestScene: {
								t: f.t,
								dur: f.dur,
								poster: f.poster,
								score: f.score,
								why: f.why,
								snippet: f.snippet ?? null,
							},
						}));
					}
				}
			} catch {
				/* fall through to local visual math */
			}

			const qVec = await embedQuery(trimmed);
			if (!qVec) return [];

			await ensureSegments();
			const scene = getSceneIndex();
			if (!scene || scene.videos.size === 0) return [];

			const thr = currentThresholds();
			const minScore = thr?.minSemanticScore ?? MIN_SEMANTIC_SCORE;
			const relativeKeep = thr?.relativeKeep ?? RELATIVE_KEEP;

			const candidates: {
				filename: string;
				score: number;
				seg: SceneSegment;
			}[] = [];
			let scoredTotal = 0;
			for (const [filename, segments] of scene.videos) {
				for (const seg of segments) {
					const row = scene.rows[seg.off];
					if (!row || row.length !== scene.dim) continue;
					scoredTotal++;
					const s = cosineSimilarity(qVec, row);
					if (s >= minScore) candidates.push({ filename, score: s, seg });
				}
			}
			if (candidates.length === 0) return [];

			candidates.sort((a, b) => b.score - a.score);
			const cutoff = Math.max(minScore, candidates[0].score * relativeKeep);

			// Uniformly hot segments = no discriminative evidence: a
			// gibberish / ultra-generic query embeds near the text centroid,
			// so ~every movie frame clears the cutoff and the same long films
			// surface for every search. Count what actually beats the ranking
			// cutoff (not just the raw floor) — a tiny fixture's noise sits
			// below the cutoff, a movie library's gibberish tail sits above
			// it. Say "no scene matches" instead of walling the grid.
			const aboveCutoff = candidates.filter((c) => c.score >= cutoff).length;
			if (
				scoredTotal >= SCENE_NOISE_MIN_SEGMENTS &&
				aboveCutoff / scoredTotal > SCENE_NOISE_FRACTION
			) {
				return [];
			}

			const perVideo = new Map<string, number>();
			const hits: RankedMemory[] = [];
			for (const c of candidates) {
				if (c.score < cutoff) break;
				const seen = perVideo.get(c.filename) ?? 0;
				if (seen >= SCENES_PER_VIDEO) continue;
				perVideo.set(c.filename, seen + 1);
				hits.push({
					filename: c.filename,
					score: c.score,
					bestScene: {
						t: c.seg.t,
						dur: c.seg.dur,
						poster: c.seg.poster,
						score: c.score,
					},
				});
				if (hits.length >= topK) break;
			}
			return hits;
		},
		[embedQuery, ensureSegments, getSceneIndex, currentThresholds],
	);

	// Dialogue search: pure-transcript speech moments (what was SAID, not
	// seen). Runs entirely on main via memories:rank-dialogue — the
	// renderer holds no transcript rows, so there is no local fallback:
	// [] means no speech evidence (or no transcripts indexed yet).
	const searchDialogue = useCallback(
		async (query: string, topK = 24): Promise<RankedMemory[]> => {
			const trimmed = query.trim();
			if (!trimmed || filenamesRef.current.length === 0) return [];
			try {
				if (typeof window.memories?.rankDialogue === "function") {
					const moments = (await window.memories.rankDialogue(
						trimmed,
						topK,
					)) as
						| {
								filename: string;
								score: number;
								t: number;
								dur: number;
								poster: number;
								why?: "visual" | "text" | "both";
								snippet?: string | null;
								tier?: number;
								tierLabel?: string;
								matchStart?: number;
								matchLen?: number;
						  }[]
						| null
						| undefined;
					if (Array.isArray(moments)) {
						return moments.map((f) => ({
							filename: f.filename,
							score: f.score,
							bestScene: {
								t: f.t,
								dur: f.dur,
								poster: f.poster,
								score: f.score,
								why: f.why ?? "text",
								snippet: f.snippet ?? null,
								tier: f.tier,
								tierLabel: f.tierLabel,
								matchStart: f.matchStart,
								matchLen: f.matchLen,
							},
						}));
					}
				}
			} catch {
				/* dialogue needs the main sidecar — no local fallback */
			}
			return [];
		},
		[],
	);

	// Synchronous filename-token ranking — zero latency, instant pre-pass.
	// Deliberately filename-ONLY: Files mode ranks semantically, so OCR text
	// must not shape (or flash) its results — the OCR tab owns text matching.
	const searchKeyword = useCallback(
		(query: string, topK = 24): RankedMemory[] => {
			const trimmed = query.trim();
			if (!trimmed || filenamesRef.current.length === 0) return [];
			return keywordMatchMemories(
				trimmed,
				filenamesRef.current.map((filename) => ({ filename })),
				topK,
			);
		},
		[],
	);

	// OCR-only search (the dedicated OCR tab): rank by the fraction of query
	// tokens that literally appear in each image's extracted text. No model,
	// no semantic pass, no filename matching — results are exactly the
	// images whose on-screen text contains the query (poster titles,
	// screenshot captions — the text CLIP can't read). Synchronous, so the
	// tab responds instantly even when the AI engine is down. Returns []
	// while the OCR index hasn't loaded (the same alignment guard as the
	// keyword pre-pass).
	const searchOcr = useCallback((query: string, topK = 24): RankedMemory[] => {
		const trimmed = query.trim();
		if (!trimmed || filenamesRef.current.length === 0) return [];
		return ocrMatchMemories(
			trimmed,
			filenamesRef.current.map((filename) => ({ filename })),
			topK,
			ocrTextsRef.current,
		);
	}, []);

	// The model is always warming in the background; nothing to kick off.
	const prewarm = useCallback(() => {
		void loadIndexData();
	}, [loadIndexData]);

	// Switch the library's model. Progress streams as "migrate" status
	// events (rendered by the picker); the flip itself ends with a
	// library-updated broadcast, which reloads the index + manifest. On a
	// synchronous failure (unknown model, migration already running) the
	// migration pill may be mid-show with no event to clear it — clear it
	// here.
	const setModel = useCallback(
		async (modelId: string): Promise<SetModelResult> => {
			try {
				return await window.memories.setModel(modelId);
			} catch (err) {
				setMigration(null);
				throw err;
			}
		},
		[],
	);

	// Preload a single model's weights (no switch). Errors are surfaced by
	// the picker via the returned error field, not thrown (a failed download
	// of a model the user isn't using shouldn't break the UI).
	const preloadModel = useCallback(
		async (modelId: string) => window.memories.preloadModel(modelId),
		[],
	);

	// "Download all models": fetch every model's weights. Aggregates the
	// per-model results so the caller can show a summary.
	const preloadAllModels = useCallback(
		async () => window.memories.preloadAllModels(),
		[],
	);

	return {
		search,
		searchScenes,
		searchDialogue,
		searchKeyword,
		searchOcr,
		prewarm,
		setModel,
		getSceneIndex,
		isReady,
		isSearching,
		error,
		sceneDataReady,
		models,
		activeModelId,
		migration,
		modelPreloads,
		preloadModel,
		preloadAllModels,
		ocrWordBoxesByFilename,
	};
}
