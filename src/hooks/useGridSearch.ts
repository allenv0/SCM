"use client";

import { useEffect, useRef, useState } from "react";
import type { AskEvidenceRow, AskResult, ImageItem } from "@/types";
import type { RankedMemory } from "@/lib/memoryRank";
import { askEvidenceRows } from "@/hooks/useAsk";
import { parseAskScope, scopedFilenames } from "@/lib/askScope";

// Search state + dispatch, extracted from MasonryGrid verbatim: the query,
// the five mutually-exclusive mode flags, the ranked results, the
// keyword-pre-pass/semantic-upgrade pipeline, and the LLMs evidence path.
//
// The search functions are injected rather than called through
// useMemorySearch directly, so this hook stays a pure state machine over
// whatever indexes the caller has wired up (and tests can drive it).
// Sequence guarding is unchanged: every dispatch bumps `searchSeqRef` and a
// late async reply whose seq no longer matches is dropped, which is what
// keeps fast typing from clobbering the newest results.
export interface GridSearchSource {
	/** Debounced CLIP semantic search over the whole library. */
	search: (query: string, topK: number) => Promise<RankedMemory[]>;
	/** Shot-level scene ranking (Scenes mode). */
	searchScenes: (query: string, topK: number) => Promise<RankedMemory[]>;
	/** Transcript-moment ranking (Dialogue mode). */
	searchDialogue: (query: string, topK: number) => Promise<RankedMemory[]>;
	/** Synchronous filename/phrase pre-pass. */
	searchKeyword: (query: string, topK: number) => RankedMemory[];
	/** Synchronous OCR-text ranking (OCR mode). */
	searchOcr: (query: string, topK: number) => RankedMemory[];
	/** True once the index (OCR texts included) has committed after the
	 *  latest invalidation; false while wiped, loading, or failed. Drives
	 *  the OCR re-run effect below. */
	indexReady: boolean;
	/** LLMs mode question → gated answer + evidence rows. */
	ask: (query: string, filenames: string[]) => Promise<AskResult | null>;
	/** Cancel an in-flight LLMs question (query cleared). */
	clearAsk: () => void;
}

export function useGridSearch(
	source: GridSearchSource,
	items: ImageItem[],
	askLiveEvidence: AskEvidenceRow[] | null,
) {
	const {
		search,
		searchScenes,
		searchDialogue,
		searchKeyword,
		searchOcr,
		indexReady,
		ask,
		clearAsk,
	} = source;

	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<RankedMemory[] | null>(
		null,
	);
	const [semanticPending, setSemanticPending] = useState(false);
	const searchSeqRef = useRef(0);
	const keywordResultsRef = useRef<RankedMemory[]>([]);

	// Deep "Scenes" search mode (Phase 3): when on, a query scores EVERY
	// segment across all videos and returns exact-moment hits instead of
	// whole files. Opt-in, so the default search is byte-for-byte today's.
	const [sceneMode, setSceneMode] = useState(false);
	// Dedicated "OCR" search mode: results are ONLY the images whose visible
	// text matches the query — no model, no filename matching, no semantic
	// pass. Mutually exclusive with Scenes mode (files is the default).
	const [ocrMode, setOcrMode] = useState(false);
	// Dedicated "Dialogue" search mode: results are ONLY transcript moments
	// (what was SAID in videos — pure speech index, never mixed with visual
	// scene search). Mutually exclusive with the other three modes.
	const [dialogueMode, setDialogueMode] = useState(false);
	// Dedicated "LLMs" search mode (MDs/Ask-Mode-Plan.md): the query is
	// answered by the embedded local LLM from OCR/dialogue/filename
	// evidence, with the evidence rows rendered in the grid below. Mutually
	// exclusive with the other four modes. PARKED: `askEnabled` comes from
	// useAsk, which ANDs the stored config with ASK_MODE_VISIBLE
	// (shared/feature-flags.ts) — so the pill, badge, answer card, and the
	// all-llms view mapping below are all unreachable while the flag is off,
	// with every one of them left in place for the revival flip.
	const [askMode, setAskMode] = useState(false);

	// Evidence-first streaming: the grid populates in citation order while
	// the answer is still generating (the invoke resolution re-sets the
	// same rows — harmless).
	useEffect(() => {
		if (!askMode || !askLiveEvidence) return;
		setSearchResults(askEvidenceRows(askLiveEvidence));
	}, [askMode, askLiveEvidence]);

	// LLMs scopes filter library rows renderer-side (tab membership lives
	// here); the ref keeps the dispatch effect off the items identity, so a
	// library refresh does not re-run the question.
	const askItemsRef = useRef(items);
	useEffect(() => {
		askItemsRef.current = items;
	}, [items]);

	// Rank up to 96 candidates so post-filtering by category still fills a
	// grid.
	const searchTopK = 96;

	// Derived display list: semantic search results (ranked) or category-filtered grid
	const searching = query.trim().length > 0;

	// Instant keyword pre-pass + debounced semantic upgrade. In Scenes mode
	// the pre-pass is skipped (a keyword pass would return whole videos, not
	// scenes) — the scene ranking replaces the grid after the debounce. In
	// OCR mode there is no debounce at all: the OCR-only ranking is
	// synchronous (no model involved), so results appear the moment the
	// query does.
	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			searchSeqRef.current++;
			setSearchResults(null);
			setSemanticPending(false);
			clearAsk();
			return;
		}
		if (ocrMode) {
			searchSeqRef.current++;
			setSearchResults(searchOcr(trimmed, searchTopK));
			setSemanticPending(false);
			return;
		}
		if (sceneMode) {
			setSearchResults([]);
			setSemanticPending(true);
			const seq = ++searchSeqRef.current;
			const timer = setTimeout(async () => {
				const results = await searchScenes(trimmed, searchTopK);
				if (seq !== searchSeqRef.current) return;
				setSearchResults(results);
				setSemanticPending(false);
			}, 300);
			return () => clearTimeout(timer);
		}
		// Dialogue mode mirrors Scenes (no keyword pre-pass — a keyword pass
		// would return whole videos, not speech moments) against the pure
		// transcript index. Never mixed with visual scene results.
		if (dialogueMode) {
			setSearchResults([]);
			setSemanticPending(true);
			const seq = ++searchSeqRef.current;
			const timer = setTimeout(async () => {
				const results = await searchDialogue(trimmed, searchTopK);
				if (seq !== searchSeqRef.current) return;
				setSearchResults(results);
				setSemanticPending(false);
			}, 300);
			return () => clearTimeout(timer);
		}
		// LLMs mode (MDs/Ask-Mode-Plan.md): parse the /scope prefix, filter
		// the library rows renderer-side, and send the cleaned question to
		// the main-process sidecar. The result's evidence rows render in the
		// grid in citation order; the answer card reads the useAsk result.
		if (askMode) {
			const { scope, query: askQuery } = parseAskScope(trimmed);
			if (!askQuery) {
				searchSeqRef.current++;
				setSearchResults(null);
				setSemanticPending(false);
				return;
			}
			setSearchResults([]);
			setSemanticPending(true);
			const seq = ++searchSeqRef.current;
			const timer = setTimeout(async () => {
				const filenames = scopedFilenames(askItemsRef.current, scope);
				const res = await ask(askQuery, filenames);
				if (seq !== searchSeqRef.current) return;
				setSearchResults(res ? askEvidenceRows(res.evidence) : []);
				setSemanticPending(false);
			}, 300);
			return () => clearTimeout(timer);
		}
		const kwResults = searchKeyword(trimmed, searchTopK);
		keywordResultsRef.current = kwResults;
		setSearchResults(kwResults);
		setSemanticPending(true);
		const seq = ++searchSeqRef.current;
		const timer = setTimeout(async () => {
			const clipResults = await search(trimmed, searchTopK);
			if (seq !== searchSeqRef.current) return;
			// Merge: CLIP results lead, keyword-only items append at the
			// bottom. This keeps the grid stable — items found by both
			// reorder in place, while keyword-only items that CLIP didn't
			// find stay visible with a "Filename match" badge instead of
			// vanishing.
			const kwSet = new Set(clipResults.map((r) => r.filename));
			const keywordOnly = keywordResultsRef.current
				.filter((r) => !kwSet.has(r.filename))
				.map((r) => ({ ...r, dominant: "filename" as const }));
			const merged = [...clipResults, ...keywordOnly].slice(0, searchTopK);
			setSearchResults(merged);
			setSemanticPending(false);
		}, 300);
		return () => clearTimeout(timer);
	}, [
		query,
		search,
		searchScenes,
		searchDialogue,
		searchKeyword,
		searchOcr,
		searchTopK,
		sceneMode,
		dialogueMode,
		ocrMode,
		askMode,
		ask,
		clearAsk,
	]);

	// OCR re-run when the index lands. searchOcr ranks synchronously against
	// the renderer's OCR-texts ref, which every library-updated invalidation
	// wipes to null and the next index commit refills ~150ms+fetch later. A
	// query typed in that window ranked against null and returned [] — and
	// nothing re-ran it (this hook's deps never change on a commit), so the
	// tab stayed empty claiming "no matching text" for text that exists.
	// Re-rank when readiness flips true. Deliberately a NO-OP on false:
	// during the wipe→refill window the stale-but-real results stay visible
	// instead of flashing empty on every OCR/enrichment tick, and the main
	// effect above keeps its own deps so other modes never re-dispatch here.
	useEffect(() => {
		if (!indexReady) return;
		const trimmed = query.trim();
		if (!ocrMode || !trimmed) return;
		searchSeqRef.current++;
		// Deliberately synchronous, same as the OCR dispatch in the main
		// effect above: the tab's contract is results the moment the query
		// lands, and the ranked array is already final (nothing awaits).
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setSearchResults(searchOcr(trimmed, searchTopK));
		setSemanticPending(false);
	}, [indexReady, ocrMode, query, searchOcr, searchTopK]);

	return {
		query,
		setQuery,
		searchResults,
		semanticPending,
		searching,
		sceneMode,
		setSceneMode,
		ocrMode,
		setOcrMode,
		dialogueMode,
		setDialogueMode,
		askMode,
		setAskMode,
	};
}
