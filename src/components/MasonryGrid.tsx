"use client";

import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useCallback,
	useMemo,
	memo,
} from "react";
import {
	IconX,
	IconPencil,
	IconChevronLeft,
	IconChevronRight,
	IconFolderOpen,
} from "@tabler/icons-react";
import { EmailRow } from "./EmailContact";
import MemoryCard from "./MemoryCard";
import OcrHighlightBoxes from "./OcrHighlightBoxes";
import FilmGate from "./FilmGate";
import MemorySearch from "./MemorySearch";
import ModelPicker from "./ModelPicker";
import TileContextMenu from "./TileContextMenu";
import AiInsightsPanel from "./AiInsightsPanel";
import AskAnswer from "./AskAnswer";
import LlmModelBadge from "./LlmModelBadge";
import { useMemorySearch } from "@/hooks/useMemorySearch";
import { useAsk, askEvidenceRows } from "@/hooks/useAsk";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { parseAskScope, scopedFilenames } from "@/lib/askScope";
import { formatEmailEvidence, type EmailMatch } from "@/lib/emailAddress";
import type {
	RankedMemory,
	SceneMatch,
	ScoreBreakdown,
} from "@/lib/memoryRank";
import { matchingOcrWordBoxes } from "@/lib/ocrHighlights";
import type { OcrWordBox } from "@/lib/ocrHighlights";
import type { MatchDominant } from "@/lib/matchTone";
import type { StatusPayload } from "@/types";
import { newestMediaFirst } from "@/lib/mediaOrder";
import {
	effectiveColumnCount,
	type GridColumnsSetting,
} from "@/lib/gridColumns";
import { virtualGridLayout, ROW_GAP } from "@/lib/virtualGrid";
import {
	isVideoFile,
	isPlayableVideoFile,
	posterFor,
	previewFor,
	formatTimecode,
} from "@/lib/media";
import {
	loadSavedSearches,
	saveSavedSearches,
	isSaved,
	addSavedSearch,
	updateSavedSearch,
	removeSavedSearch,
	savedTabLabel,
	normalizePrompt,
	type SavedTab,
	type SavedTabMode,
} from "@/lib/savedSearches";
import {
	DEFAULT_VIEW_SHORTCUTS,
	VIEW_IDS,
	matchAccelerator,
	type ViewId,
	type ViewShortcuts,
} from "@/lib/viewShortcuts";
import type { ModelPhase } from "@/types";
import {
	BUILT_IN_TABS,
	isBuiltInTab,
	readStoredEnabledTabs,
	visibleBuiltInTabs,
} from "@/lib/builtInTabs";

// Built-in tab membership. Categories are exclusive per-photo buckets
// (img.category), EXCEPT the Email tab, which is an OVERLAPPING view over
// the same library: a photo whose OCR text contains an email address shows
// up there AND still under its own category (a screenshot of an inbox is
// both a screenshot and an email). "All" spans everything.
function matchesTab(img: ImageItem, tabId: string): boolean {
	if (tabId === "All") return true;
	if (tabId === "Email") return img.hasEmail;
	return img.category === tabId;
}

// A tab in the tab bar: a built-in category or a saved-search tab (which
// carries the search mode it was saved in).
type Tab =
	| { id: string; label: string; isSaved: false }
	| { id: string; label: string; mode: SavedTabMode; isSaved: true };

interface ImageItem {
	id: string;
	filename: string;
	category: string;
	modifiedAt: number | null;
	/** Whether the photo's OCR text contains an email address — membership
	 *  for the Email tab (an overlapping view, not an exclusive category:
	 *  the photo can also belong to Screenshots/etc.). */
	hasEmail: boolean;
	/** Cleaned addresses for the Email-tab card overlay (first-seen order,
	 *  capped). Empty when hasEmail is false. */
	emailAddresses: string[];
	/** Match evidence behind emailAddresses (same order): "found as" tooltips. */
	emailMatches: EmailMatch[];
}

// A tile the grid can render: the library item plus (in search context) the
// best-scene match it arrived with. Carried ON the item (not in a separate
// filename→scene map) because Scenes mode can surface the SAME video at
// several timestamps — each result needs its own scene for the badge,
// poster swap, and lightbox seek.
interface DisplayItem extends ImageItem {
	scene?: SceneMatch | null;
	// Literal query words detected on the image itself. Empty for semantic-only
	// hits, so the UI never pretends it knows where an abstract concept is.
	ocrHighlights?: OcrWordBox[];
	// One-line "why it matched" label shown on each card.
	matchReason?: string;
	// Which signal won — drives the badge tone + tooltip accent.
	dominant?: MatchDominant;
	// Score components for the hover tooltip.
	matchBreakdown?: ScoreBreakdown;
}

// Lightbox body for searchable-only videos (mkv/hevc/...): Chromium cannot
// demux these containers, so instead of a dead <video> the lightbox shows a
// 30 s in-app preview transcoded around the matched scene timestamp (see
// main.js /images/preview/ + media.ts previewFor) with a poster fallback
// while the transcode lands or if it fails, plus an "Open in system player"
// button for full-file playback. Remounted per (file, sceneT) by key.
function UnplayableVideo({
	filename,
	sceneT,
	indexLabel,
}: {
	filename: string;
	sceneT: number;
	indexLabel: string;
}) {
	const [previewFailed, setPreviewFailed] = useState(false);
	const [opening, setOpening] = useState(false);
	const [openFailed, setOpenFailed] = useState(false);
	// No reset effect: the parent remounts per (file, sceneT) via key, so
	// fresh state arrives with each navigation automatically.
	const openExternal = useCallback(() => {
		setOpening(true);
		setOpenFailed(false);
		void window.memories
			?.openExternal?.(filename)
			.then((res) => {
				if (!res?.ok) setOpenFailed(true);
			})
			.catch(() => setOpenFailed(true))
			.finally(() => setOpening(false));
	}, [filename]);
	return (
		<div className="relative">
			{previewFailed ? (
				<img
					src={posterFor(filename)}
					alt={indexLabel}
					width={1400}
					height={1000}
					className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
				/>
			) : (
				<video
					key={`${filename}@${sceneT}`}
					src={previewFor(filename, sceneT)}
					controls
					autoPlay
					playsInline
					preload="metadata"
					poster={posterFor(filename)}
					onError={() => setPreviewFailed(true)}
					className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
				/>
			)}
			<div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
				<span className="rounded-full border border-white/20 bg-black/60 px-4 py-1.5 text-xs text-white/90 backdrop-blur">
					{sceneT > 0
						? `Preview around ${formatTimecode(sceneT)} — full file needs a system player`
						: "Preview — full file needs a system player"}
				</span>
			</div>
			<div className="mt-2 flex items-center justify-center gap-2">
				<button
					onClick={(e) => {
						e.stopPropagation();
						openExternal();
					}}
					disabled={opening}
					className="rounded-full border border-white/20 bg-black/60 px-4 py-1.5 text-xs text-white/90 backdrop-blur transition hover:bg-black/80 disabled:opacity-60"
					title="Open the full file in the OS default video player"
				>
					{opening ? "Opening…" : "Open in system player"}
				</button>
				{openFailed && (
					<span className="text-xs text-red-300">
						Couldn&apos;t open — try Show in Finder
					</span>
				)}
			</div>
		</div>
	);
}

interface MasonryGridProps {
	initialImages?: ImageItem[];
	modelState?: ModelPhase | "idle";
	modelProgress?: number | null;
	modelFirstRun?: boolean;
	/** Manual Screenshots-tab decision (right-click menu). Main persists it
	 *  by content hash and broadcasts "library-updated"; App re-derives
	 *  every category from the refreshed index. */
	onSetCategoryOverride?: (
		filename: string,
		category: "Screenshots" | "Projects",
	) => void;
	/** Grid density (Settings → Grid): "auto" keeps the responsive columns. */
	gridColumns?: GridColumnsSetting;
	/** View-shortcut map (Settings → Keyboard): which combo jumps to each
	 *  of the five semantic library views. Defaults reproduce the
	 *  historical Cmd+1–5 mapping. */
	viewShortcuts?: ViewShortcuts;
	/** Enabled built-in tabs (Settings → Smart Tabs). Toggleable tabs
	 *  missing from the set are hidden from the tab bar; All/Videos are
	 *  always on regardless. Defaults to the stored set. */
	enabledTabs?: Set<string>;
	/** Lightbox CRT screen effect (Settings → Appearance). On (default)
	 *  frames photo/video on a retro monitor; off is a plain viewer. */
	crtEffect?: boolean;
	/** Called with the filename when a tile delete fails (bridge rejection
	 *  or !ok) — App toasts it. Without this, failures were console-only
	 *  and a failed delete masqueraded as success. Optional. */
	onDeleteFailure?: (filename: string) => void;
}

function MasonryGrid({
	initialImages = [],
	modelState = "idle",
	modelProgress = null,
	modelFirstRun = false,
	gridColumns = "auto",
	viewShortcuts = DEFAULT_VIEW_SHORTCUTS,
	enabledTabs = readStoredEnabledTabs(),
	crtEffect = true,
	onSetCategoryOverride,
	onDeleteFailure,
}: MasonryGridProps) {
	// NOTE: C-04 deleted the ITEMS_PER_PAGE cursor pagination here. The
	// VirtualizedGridBody below mounts only the viewport window, so the
	// full filtered list is always the display list — no append state.

	// Grid density (Settings → Grid). A fixed count is measured against the
	// full-width grid wrapper and clamped so narrow windows never squeeze
	// tiles below GRID_MIN_TILE; Auto skips this and renders the responsive
	// CSS-columns classes unchanged.
	const gridRef = useRef<HTMLDivElement>(null);
	const [gridWidth, setGridWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = gridRef.current;
		if (!el) return;
		const measure = () => setGridWidth(el.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Tab bar: content-hug shell capped at 56rem, with an inner scroll
	// track. The shell grows with the tabs up to the cap; past it the
	// track scrolls, so fades/arrows appear only when needed. Keeps the
	// active tab visible.
	const tabTrackRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);
	const isOverflowing = canScrollLeft || canScrollRight;
	const updateTabScrollState = useCallback(() => {
		const el = tabTrackRef.current;
		if (!el) return;
		const left = el.scrollLeft > 4;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
		setCanScrollLeft(left);
		setCanScrollRight(right);
	}, []);
	useLayoutEffect(() => {
		const el = tabTrackRef.current;
		if (!el) return;
		updateTabScrollState();
		const ro = new ResizeObserver(updateTabScrollState);
		ro.observe(el);
		const mo = new MutationObserver(updateTabScrollState);
		mo.observe(el, { childList: true, subtree: true, attributes: true });
		el.addEventListener("scroll", updateTabScrollState, { passive: true });
		window.addEventListener("resize", updateTabScrollState);
		return () => {
			ro.disconnect();
			mo.disconnect();
			el.removeEventListener("scroll", updateTabScrollState);
			window.removeEventListener("resize", updateTabScrollState);
		};
	}, [updateTabScrollState]);
	// Re-check after mount; tab count changes are caught by the
	// MutationObserver above, so no savedSearches dep needed here.
	useLayoutEffect(() => {
		updateTabScrollState();
	}, [updateTabScrollState]);
	const scrollTabs = useCallback((dir: -1 | 1) => {
		tabTrackRef.current?.scrollBy({
			left: dir * 240,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}, []);
	const dragState = useRef<{
		active: boolean;
		startX: number;
		startLeft: number;
	}>({
		active: false,
		startX: 0,
		startLeft: 0,
	});
	const onTabTrackPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest("button")) return;
			const el = tabTrackRef.current;
			if (!el || !isOverflowing) return;
			dragState.current = {
				active: true,
				startX: e.clientX,
				startLeft: el.scrollLeft,
			};
			(el as unknown as HTMLElement).setPointerCapture(e.pointerId);
		},
		[isOverflowing],
	);
	const onTabTrackPointerMove = useCallback((e: React.PointerEvent) => {
		if (!dragState.current.active) return;
		const el = tabTrackRef.current;
		if (!el) return;
		const dx = e.clientX - dragState.current.startX;
		el.scrollLeft = dragState.current.startLeft - dx;
	}, []);
	const endDrag = useCallback((e: React.PointerEvent) => {
		dragState.current.active = false;
		try {
			(tabTrackRef.current as unknown as HTMLElement)?.releasePointerCapture(
				e.pointerId,
			);
		} catch {
			/* releasePointerCapture is best-effort (mouse drags never capture) */
		}
	}, []);

	// Data state: the full category-filtered list. No pagination — the
	// virtualized body windows the DOM, so this array is data only.
	// Filter state
	const [activeFilter, setActiveFilter] = useState<string>("All");
	const [filteredImages, setFilteredImages] =
		useState<ImageItem[]>(initialImages);

	// Saved search tabs (prompt + user-chosen label). A prompt colliding
	// with a built-in tab name is refused at save time and dropped here
	// defensively, so a built-in tab can never be shadowed by a saved tab
	// with the same id — including while the built-in is disabled under
	// Settings → Smart Tabs.
	const [savedSearches, setSavedSearches] = useState<SavedTab[]>(() =>
		loadSavedSearches().filter((t) => !isBuiltInTab(t.prompt)),
	);

	// Visible built-ins in tab-bar order (Settings → Smart Tabs). All and
	// Videos are always on; Screenshots/Email render only when enabled.
	const visibleCategories = useMemo(
		() => visibleBuiltInTabs(enabledTabs),
		[enabledTabs],
	);

	// Search state
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<RankedMemory[] | null>(
		null,
	);
	const [semanticPending, setSemanticPending] = useState(false);
	const searchSeqRef = useRef(0);
	const keywordResultsRef = useRef<RankedMemory[]>([]);
	const {
		search,
		searchScenes,
		searchDialogue,
		searchKeyword,
		searchOcr,
		prewarm,
		setModel,
		isSearching,
		error: searchError,
		sceneDataReady,
		models,
		activeModelId,
		migration,
		modelPreloads,
		preloadModel,
		preloadAllModels,
		ocrWordBoxesByFilename,
	} = useMemorySearch(initialImages.map((img) => img.filename));

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
	// exclusive with the other four modes; hidden until LLMs Chat is enabled.
	const [askMode, setAskMode] = useState(false);
	const {
		enabled: askEnabled,
		llmModel,
		asking,
		result: askResult,
		streamed: askStreamed,
		liveEvidence: askLiveEvidence,
		progress: askProgress,
		ask,
		stop: stopAsk,
		clear: clearAsk,
	} = useAsk();
	// Evidence-first streaming: the grid populates in citation order while
	// the answer is still generating (the invoke resolution re-sets the
	// same rows — harmless).
	useEffect(() => {
		if (!askMode || !askLiveEvidence) return;
		setSearchResults(askEvidenceRows(askLiveEvidence));
	}, [askMode, askLiveEvidence]);
	// LLMs scopes filter library rows renderer-side (tab membership lives
	// here); the ref keeps the dispatch effect off the initialImages deps.
	const askItemsRef = useRef(initialImages);
	useEffect(() => {
		askItemsRef.current = initialImages;
	}, [initialImages]);
	// The toggle only makes sense when the library actually has videos.
	const hasVideos = initialImages.some((img) => isVideoFile(img.filename));

	// Background scene-analysis tray (Phase 4): main streams "enrich" status
	// events as videos are shot-detected + segment-embedded in the
	// background. The pill under the search bar keeps long movies visibly
	// "still processing" instead of silent, and shows the queue draining.
	const [enrich, setEnrich] = useState<Extract<
		StatusPayload,
		{ type: "enrich" }
	> | null>(null);
	useEffect(() => {
		let mounted = true;
		window.memories
			?.getEnrichState?.()
			.then((s) => {
				if (mounted && s?.type === "enrich") setEnrich(s);
			})
			.catch(() => {});
		const off = window.memories?.onStatus?.((payload) => {
			if (payload.type === "enrich") {
				setEnrich(payload);
			} else if (payload.type === "library-updated") {
				// A new import batch re-queued videos; refresh the snapshot so
				// the tray reflects the post-import queue immediately.
				window.memories
					?.getEnrichState?.()
					.then((s) => {
						if (mounted && s?.type === "enrich") setEnrich(s);
					})
					.catch(() => {});
			}
		});
		return () => {
			mounted = false;
			off?.();
		};
	}, []);

	// Background transcription tray: main streams "transcribe" status events
	// as videos get their speech transcribed in the background (dialogue the
	// frame embeddings can't hear). Mirrors the enrich tray: a pill while a
	// video is being transcribed or the queue has videos waiting.
	const [transcribe, setTranscribe] = useState<Extract<
		StatusPayload,
		{ type: "transcribe" }
	> | null>(null);
	useEffect(() => {
		let mounted = true;
		(
			window.memories as unknown as {
				getTranscribeState?: () => Promise<unknown>;
			}
		)
			?.getTranscribeState?.()
			.then((s) => {
				if (mounted && (s as { type?: string })?.type === "transcribe")
					setTranscribe(s as Extract<StatusPayload, { type: "transcribe" }>);
			})
			.catch(() => {});
		const off = window.memories?.onStatus?.((payload) => {
			if ((payload as { type?: string }).type === "transcribe") {
				setTranscribe(
					payload as Extract<StatusPayload, { type: "transcribe" }>,
				);
			} else if (payload.type === "library-updated") {
				(
					window.memories as unknown as {
						getTranscribeState?: () => Promise<unknown>;
					}
				)
					?.getTranscribeState?.()
					.then((s) => {
						if (mounted && (s as { type?: string })?.type === "transcribe")
							setTranscribe(
								s as Extract<StatusPayload, { type: "transcribe" }>,
							);
					})
					.catch(() => {});
			}
		});
		return () => {
			mounted = false;
			off?.();
		};
	}, []);

	// Background OCR tray: main streams "ocr" status events as photos get
	// their visible text extracted in the background (posters, screenshots —
	// the text CLIP embeddings can't read). Mirrors the enrich tray: a pill
	// under the search bar while a photo is being recognized or the queue
	// has photos waiting, hidden when idle.
	const [ocr, setOcr] = useState<Extract<
		StatusPayload,
		{ type: "ocr" }
	> | null>(null);
	useEffect(() => {
		let mounted = true;
		window.memories
			?.getOcrState?.()
			.then((s) => {
				if (mounted && s?.type === "ocr") setOcr(s);
			})
			.catch(() => {});
		const off = window.memories?.onStatus?.((payload) => {
			if (payload.type === "ocr") {
				setOcr(payload);
			} else if (payload.type === "library-updated") {
				window.memories
					?.getOcrState?.()
					.then((s) => {
						if (mounted && s?.type === "ocr") setOcr(s);
					})
					.catch(() => {});
			}
		});
		return () => {
			mounted = false;
			off?.();
		};
	}, []);

	// User pause for ALL background pumps (scene analysis, transcription,
	// text extraction): one flag in main, toggled from any tray pill. New
	// states arrive on the same status channel, so every pill flips together.
	const toggleBackgroundPaused = useCallback((paused: boolean) => {
		void window.memories?.setBackgroundPaused?.(paused).catch(() => {
			/* bridge is optional — the pill keeps its last state */
		});
	}, []);

	// Lightbox state
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const [currentIndex, setCurrentIndex] = useState(0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [aiInsightsOpen, setAiInsightsOpen] = useState(false);

	// Tile right-click context menu
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		image: ImageItem;
	} | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	// Touch state for swipe gestures
	const [touchStart, setTouchStart] = useState({ x: 0, y: 0 });
	const [touchEnd, setTouchEnd] = useState({ x: 0, y: 0 });
	const minSwipeDistance = 50;

	// Save filter to localStorage when it changes
	useEffect(() => {
		localStorage.setItem("memories-filter", activeFilter);
	}, [activeFilter]);

	// Saved search tabs persist across launches
	useEffect(() => {
		saveSavedSearches(savedSearches);
	}, [savedSearches]);

	// A persisted filter can point at a saved search that has since been
	// deleted — resolve it at startup so the tab bar never highlights a
	// ghost tab.
	useEffect(() => {
		setActiveFilter((current) =>
			isBuiltInTab(current) || isSaved(current, savedSearches)
				? current
				: "All",
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Disabling the active tab under Settings → Smart Tabs snaps back to
	// All instead of leaving a highlighted tab with no matching filter.
	useEffect(() => {
		setActiveFilter((current) =>
			current === "All" ||
			isSaved(current, savedSearches) ||
			visibleBuiltInTabs(enabledTabs).includes(
				current as (typeof BUILT_IN_TABS)[number],
			)
				? current
				: "All",
		);
	}, [enabledTabs, savedSearches]);

	// Suggested-search chips (progressive enhancement: any fetch failure
	// simply hides the chips — the desktop app has none precomputed).
	const [suggestedQueries, setSuggestedQueries] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		fetch("/memory-queries.json")
			.then((r) => r.json())
			.then((data: { queries?: { q?: string }[] }) => {
				if (cancelled || !Array.isArray(data.queries)) return;
				const queries = data.queries
					.map((entry) => entry?.q)
					.filter((q): q is string => Boolean(q));
				if (queries.length > 0) setSuggestedQueries(queries);
			})
			.catch(() => {
				/* chips are optional — ignore fetch failures */
			});
		return () => {
			cancelled = true;
		};
	}, []);

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

	// The tab bar only highlights what's on screen: when the typed query
	// diverges from the active saved-search tab (including clearing it),
	// snap back to All. Category tabs are untouched — searching under
	// Videos still filters to videos.
	useEffect(() => {
		if (
			isSaved(activeFilter, savedSearches) &&
			normalizePrompt(query) !== activeFilter
		) {
			setActiveFilter("All");
		}
	}, [query, activeFilter, savedSearches]);

	// The library keeps its insertion order so every model's embedding bins
	// stay aligned. Browse ordering is therefore a display-only sort on the
	// source timestamp captured at import (latest first); search bypasses it.
	const browseSource = useMemo(
		() => newestMediaFirst(initialImages),
		[initialImages],
	);

	// Category filter from the full newest-first browse source. Computes
	// the filtered list directly — no intermediate empty-state wipe, so
	// tab/library-refresh switches are flash-free. No pagination: the
	// virtualized body mounts only the viewport window.
	const applyFilter = useCallback(
		(tabId: string) => {
			const filtered =
				tabId === "All"
					? browseSource
					: browseSource.filter((img) => matchesTab(img, tabId));
			setFilteredImages(filtered);
		},
		[browseSource],
	);

	// Initial load, filter change, and library refresh (a new initialImages
	// identity — e.g. after importing photos — rebuilds the grid).
	// Computes the list directly from current state to avoid the
	// flash-of-empty-state that a wipe-then-rebuild causes.
	useEffect(() => {
		applyFilter(activeFilter);
	}, [activeFilter, browseSource, applyFilter]);

	// Derived display list: semantic search results (ranked) or
	// category-filtered grid. Results carry their scene on the item. In
	// Scenes mode the same video can appear at several timestamps, so each
	// hit gets a synthetic id (`filename@t`) — the grid keys on it and the
	// lightbox seeks with it.
	const imagesByFilename = useMemo(
		() => new Map(initialImages.map((img) => [img.filename, img] as const)),
		[initialImages],
	);
	// A saved-search tab has no category of its own — results span the
	// whole library, like the All tab.
	const savedTabActive = isSaved(activeFilter, savedSearches);
	// Memoized so the search display only rebuilds when its inputs move —
	// the virtualized body's items prop must stay referentially stable
	// across unrelated re-renders (import progress, model download %) or
	// the memo below would be defeated.
	const searchDisplay = useMemo(() => {
		const dominantLabel = (
			dom?: RankedMemory["dominant"],
		): string | undefined => {
			if (dom === "ocr") return "Text on photo";
			if (dom === "filename") return "Filename match";
			if (dom === "phrase") return "Filename match";
			if (dom === "semantic") return "Visual match";
			return undefined;
		};
		const attachScene = (r: RankedMemory): DisplayItem | null => {
			const img = imagesByFilename.get(r.filename);
			if (!img) return null;
			const t = r.bestScene?.t ?? 0;
			return {
				...img,
				// Unique per scene: `scene-clip.mp4` at 3.0s and at 42.5s are
				// two different hits in Scenes mode. The scene suffix is
				// applied in EVERY mode, not just scene mode: scene search
				// results can legitimately contain the same video at several
				// timestamps, and rendering them with plain file ids during a
				// files-mode frame (e.g. the render between clicking a tab
				// and the search effect swapping the results) would hand
				// React duplicate keys — duplicate-keyed children are
				// orphaned by reconciliation and stay glued to the top of
				// the grid forever.
				id: r.bestScene ? `${img.id}@${Math.round(t * 100)}` : img.id,
				scene: r.bestScene ?? null,
				ocrHighlights: matchingOcrWordBoxes(
					query,
					ocrWordBoxesByFilename.get(img.filename),
					// The OCR tab ranks by substring containment, so its boxes
					// must explain that same evidence — a word-exact-only box
					// left most text-ranked results unannotated.
					{ substring: ocrMode },
				),
				matchReason:
					dominantLabel(r.dominant) ??
					// Dialogue hits carry no file-level dominant signal —
					// their evidence is the speech moment itself. Exact
					// tiers name themselves; older mains fall back to the
					// generic label.
					r.bestScene?.tierLabel ??
					(r.bestScene?.why === "text" ? "Speech match" : undefined),
				dominant: r.dominant,
				matchBreakdown: r.breakdown,
			};
		};
		return (searchResults ?? [])
			.map(attachScene)
			.filter((img): img is DisplayItem => Boolean(img))
			.filter((img) => savedTabActive || matchesTab(img, activeFilter));
	}, [
		searchResults,
		imagesByFilename,
		activeFilter,
		savedTabActive,
		query,
		ocrWordBoxesByFilename,
		ocrMode,
	]);
	const displayImages: DisplayItem[] = useMemo(
		() => (searching ? searchDisplay : filteredImages),
		[searching, searchDisplay, filteredImages],
	);

	const openLightbox = useCallback((index: number) => {
		setContextMenu(null);
		setCurrentIndex(index);
		setLightboxOpen(true);
	}, []);

	// Right-click on a tile opens the custom menu, clamped to the viewport
	// so it never gets cut off.
	const openContextMenu = useCallback(
		(e: React.MouseEvent, image: ImageItem) => {
			e.preventDefault();
			const MENU_W = 208;
			const MENU_H = 138;
			const x = Math.max(
				8,
				Math.min(e.clientX, window.innerWidth - MENU_W - 8),
			);
			const y = Math.max(
				8,
				Math.min(e.clientY, window.innerHeight - MENU_H - 8),
			);
			setContextMenu({ x, y, image });
		},
		[],
	);

	// Shared "Show in Finder" action — used by the lightbox button and the
	// tile context menu so both surface failures identically.
	const revealInFinder = useCallback((filename: string) => {
		void window.memories.revealInFinder(filename).then((res) => {
			if (!res?.ok) {
				console.warn("[memories] reveal in Finder failed for", filename);
			}
		});
	}, []);

	// Remove a tile from the library (app copy + AI index only; the user's
	// original file is untouched). The main process broadcasts
	// library-updated on success, which reloads the grid through App.tsx.
	// Failures toast through App — a silent failure here once masqueraded
	// as a successful delete.
	const deleteMemory = useCallback(
		(filename: string) => {
			void window.memories
				.deleteMemory(filename)
				.then((res) => {
					if (!res?.ok) {
						console.warn("[memories] delete failed for", filename);
						onDeleteFailure?.(filename);
					}
				})
				.catch(() => {
					console.warn("[memories] delete failed for", filename);
					onDeleteFailure?.(filename);
				});
		},
		[onDeleteFailure],
	);

	// Close the tile context menu on Escape, outside clicks, scroll, or
	// resize — mirrors how native context menus dismiss themselves.
	useEffect(() => {
		if (!contextMenu) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setContextMenu(null);
		};
		const onScroll = () => setContextMenu(null);
		const onResize = () => setContextMenu(null);
		const onPointerDown = (e: PointerEvent) => {
			if (
				contextMenuRef.current &&
				!contextMenuRef.current.contains(e.target as Node)
			) {
				setContextMenu(null);
			}
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		window.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
			window.removeEventListener("pointerdown", onPointerDown);
		};
	}, [contextMenu]);

	const closeLightbox = useCallback(() => {
		setLightboxOpen(false);
	}, []);

	// A changing query rewrites displayImages under an open lightbox or tile
	// menu: close both on any query edit instead of letting them desync.
	useEffect(() => {
		if (lightboxOpen) closeLightbox();
		setContextMenu(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query]);

	const goToNext = useCallback(() => {
		setCurrentIndex((prev) => (prev + 1) % displayImages.length);
	}, [displayImages.length]);

	const goToPrev = useCallback(() => {
		setCurrentIndex(
			(prev) => (prev - 1 + displayImages.length) % displayImages.length,
		);
	}, [displayImages.length]);

	// Touch event handlers for swipe gestures
	const onTouchStart = useCallback((e: React.TouchEvent) => {
		setTouchEnd({ x: 0, y: 0 });
		setTouchStart({
			x: e.targetTouches[0].clientX,
			y: e.targetTouches[0].clientY,
		});
	}, []);

	const onTouchMove = useCallback((e: React.TouchEvent) => {
		setTouchEnd({
			x: e.targetTouches[0].clientX,
			y: e.targetTouches[0].clientY,
		});
	}, []);

	const onTouchEnd = useCallback(() => {
		if (!touchStart.x || !touchEnd.x) return;

		const distanceX = touchStart.x - touchEnd.x;
		const distanceY = touchStart.y - touchEnd.y;

		if (
			Math.abs(distanceX) > Math.abs(distanceY) &&
			Math.abs(distanceX) > minSwipeDistance
		) {
			if (distanceX > 0) {
				goToNext();
			} else {
				goToPrev();
			}
		}
	}, [touchStart, touchEnd, goToNext, goToPrev]);

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!lightboxOpen) return;

			// Cmd+I toggles the AI insights panel.
			if (e.metaKey && e.key === "i" && !e.shiftKey) {
				e.preventDefault();
				setAiInsightsOpen((o) => !o);
				return;
			}

			switch (e.key) {
				case "Escape":
					closeLightbox();
					break;
				case "ArrowRight":
					goToNext();
					break;
				case "ArrowLeft":
					goToPrev();
					break;
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [lightboxOpen, closeLightbox, goToNext, goToPrev]);

	// Close AI insights when the lightbox closes.
	useEffect(() => {
		if (!lightboxOpen) setAiInsightsOpen(false);
	}, [lightboxOpen]);

	// Modal focus: trap Tab inside the lightbox, focus Close on open,
	// restore focus to the originating tile on close.
	const lightboxRef = useRef<HTMLDivElement>(null);
	useFocusTrap(lightboxRef, lightboxOpen);

	// Prevent body scroll when lightbox is open
	useEffect(() => {
		if (lightboxOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "unset";
		}
		return () => {
			document.body.style.overflow = "unset";
		};
	}, [lightboxOpen]);
	const currentImage = displayImages[currentIndex];
	const isGif = currentImage?.filename.toLowerCase().endsWith(".gif");
	const isVideo = isVideoFile(currentImage?.filename ?? "");
	const videoPlayable = isPlayableVideoFile(currentImage?.filename ?? "");

	// Lightbox media body — shared by the CRT frame and plain modes so
	// video seek / OCR overlays stay in one place.
	const lightboxMedia = !currentImage ? null : isVideo && !videoPlayable ? (
		<UnplayableVideo
			key={`${currentImage.filename}@${currentImage.scene?.t ?? 0}`}
			filename={currentImage.filename}
			sceneT={currentImage.scene?.t ?? 0}
			indexLabel={`Memory ${currentIndex + 1}`}
		/>
	) : isVideo ? (
		<video
			// Scenes mode can surface the SAME video at several timestamps;
			// the scene in the key remounts the element on navigation so
			// onLoadedMetadata re-fires and the player lands at the NEW
			// scene (harmless in normal mode — scenes are per-file unique).
			key={`${currentImage.filename}@${currentImage.scene?.t ?? 0}`}
			ref={videoRef}
			src={`/images/projects/${currentImage.filename}`}
			controls
			autoPlay
			loop
			playsInline
			onLoadedMetadata={(e) => {
				// Seek-on-open: when this video was opened from a
				// search result that matched a shot, land at the
				// best-scene moment instead of t=0.
				const scene = currentImage.scene;
				if (scene && e.currentTarget.duration > scene.t) {
					e.currentTarget.currentTime = scene.t;
				}
			}}
			className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
		/>
	) : isGif ? (
		<div className="relative">
			<img
				src={`/images/projects/${currentImage.filename}`}
				alt={`Memory ${currentIndex + 1}`}
				width={1400}
				height={1000}
				className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
			/>
			{/* Query annotations follow the opened photo out
					    of the grid, so the "why did this match"
					    explanation survives the click. */}
			<OcrHighlightBoxes words={currentImage.ocrHighlights} />
		</div>
	) : (
		<div className="relative">
			<img
				src={`/images/projects/${currentImage.filename}`}
				alt={`Memory ${currentIndex + 1}`}
				width={1400}
				height={1000}
				decoding="sync"
				className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
			/>
			<OcrHighlightBoxes words={currentImage.ocrHighlights} />
		</div>
	);

	// Save-the-search-as-a-tab dialog: opens in "create" mode from the Save
	// as tab pill (prompt = the typed query), or in "edit" mode from a
	// saved tab's pencil — where the label and search mode can change while
	// the prompt (the tab's identity) stays fixed.
	const [tabDialog, setTabDialog] = useState<
		{ mode: "create"; prompt: string } | { mode: "edit"; tab: SavedTab } | null
	>(null);
	const handleSaveSearch = useCallback(() => {
		const p = normalizePrompt(query);
		if (!p || isBuiltInTab(p)) return;
		setTabDialog({ mode: "create", prompt: p });
	}, [query]);

	// The search mode currently on screen — what a freshly created tab
	// inherits (the dialog's default, which can be overridden there).
	const currentMode: SavedTabMode = ocrMode
		? "ocr"
		: sceneMode
			? "scenes"
			: dialogueMode
				? "dialogue"
				: "files";

	// Confirm the create dialog: add the tab (prompt = the query it runs,
	// label = whatever name the user picked, mode = the search mode it was
	// saved in) and activate it — the highlighted tab then always matches
	// what's on screen. Category names are reserved, so a saved search can
	// never shadow a built-in tab.
	const confirmSaveTab = useCallback(
		(label: string, mode: SavedTabMode) => {
			if (!tabDialog || tabDialog.mode !== "create") return;
			const p = tabDialog.prompt;
			setSavedSearches((prev) => addSavedSearch(prev, p, label, mode));
			setActiveFilter(p);
			setTabDialog(null);
		},
		[tabDialog],
	);

	// Confirm the edit dialog: keep the prompt (identity) but adopt the
	// new label and search mode.
	const confirmEditTab = useCallback(
		(label: string, mode: SavedTabMode) => {
			if (!tabDialog || tabDialog.mode !== "edit") return;
			const p = tabDialog.tab.prompt;
			setSavedSearches((prev) => updateSavedSearch(prev, p, { label, mode }));
			setTabDialog(null);
		},
		[tabDialog],
	);

	// Open the edit dialog for a saved tab by its prompt (the tabs array
	// carries only the truncated label — look up the full tab).
	const openEditTab = useCallback(
		(prompt: string) => {
			const tab = savedSearches.find((t) => t.prompt === prompt);
			if (tab) setTabDialog({ mode: "edit", tab });
		},
		[savedSearches],
	);

	// Remove a saved tab; if it was the active one, return to the All tab
	// and drop the query that no longer belongs to any tab.
	const handleRemoveTab = useCallback(
		(prompt: string) => {
			setSavedSearches((prev) => removeSavedSearch(prev, prompt));
			if (activeFilter === prompt) {
				setActiveFilter("All");
				setQuery((q) => (normalizePrompt(q) === prompt ? "" : q));
			}
		},
		[activeFilter],
	);

	const tabs: Tab[] = [
		...visibleCategories.map((category) => ({
			id: category,
			label: category,
			isSaved: false as const,
		})),
		...savedSearches.map((tab) => ({
			id: tab.prompt,
			label: savedTabLabel(tab.label),
			mode: tab.mode,
			isSaved: true as const,
		})),
	];

	const scrollActiveTabIntoView = useCallback(() => {
		const track = tabTrackRef.current;
		if (!track) return;
		const esc =
			typeof CSS !== "undefined" &&
			(CSS as unknown as { escape: (s: string) => string }).escape
				? (CSS as unknown as { escape: (s: string) => string }).escape(
						activeFilter,
					)
				: activeFilter.replace(/"/g, '\\"');
		const active = track.querySelector<HTMLElement>(`[data-tab-id="${esc}"]`);
		// Fallback if CSS.escape unavailable or query fails — try direct attribute match
		const target =
			active ??
			track.querySelector<HTMLElement>(
				`[data-tab-id="${activeFilter.replace(/"/g, '\\"')}"]`,
			);
		target?.scrollIntoView({
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
			block: "nearest",
			inline: "center",
		});
	}, [activeFilter]);
	useEffect(() => {
		const id = requestAnimationFrame(() => scrollActiveTabIntoView());
		return () => cancelAnimationFrame(id);
	}, [activeFilter, tabs.length, scrollActiveTabIntoView]);
	useLayoutEffect(() => {
		updateTabScrollState();
	}, [tabs.length, updateTabScrollState]);

	// Selecting a tab is the same action whether it came from a click or a
	// keyboard shortcut — one shared handler keeps both behaviors identical.
	const selectTab = useCallback((tab: Tab) => {
		if (tab.isSaved) {
			setQuery(tab.id);
			// Saved tabs carry the search mode they were saved in — clicking
			// one returns to Files/Scenes/Dialogue/OCR exactly as left.
			setOcrMode(tab.mode === "ocr");
			setSceneMode(tab.mode === "scenes");
			setDialogueMode(tab.mode === "dialogue");
			// LLMs is not a savable mode — a saved tab always leaves it.
			setAskMode(false);
		}
		setActiveFilter(tab.id);
		// Category tabs are browsing, not searching — any tab click leaves
		// the OCR mode (Videos keeps its historic scene-mode behavior;
		// everything else is files mode). Leaving Scenes on under a photo
		// category made every search there run video-only scene ranking that
		// the category filter then dropped — an empty grid that reads as
		// broken search.
		if (!tab.isSaved) {
			setOcrMode(false);
			setDialogueMode(false);
			// LLMs spans the whole library by design — a category click ends
			// it like every other mode switch.
			setAskMode(false);
			setSceneMode(tab.id === "Videos");
			// The All tab is home — clicking it also clears any active query
			// so the full library (Files mode) is back on screen.
			if (tab.id === "All") setQuery("");
		}
	}, []);

	// View shortcuts (Settings → Keyboard, Cmd+1–5 by default): five
	// semantic views, each a category tab + search mode pair. Recorded
	// combos dispatch first (in VIEW_IDS order, so a hand-edited duplicate
	// deterministically favors the earliest view); plain Cmd+digit keeps
	// the historic positional fallback (tabs[digit-1]) for saved tabs on
	// 6–9 and any digit the user unassigned from the five views.
	const activateView = useCallback(
		(view: ViewId) => {
			switch (view) {
				case "all-files":
					setActiveFilter("All");
					setOcrMode(false);
					setSceneMode(false);
					setDialogueMode(false);
					setAskMode(false);
					setQuery("");
					break;
				case "videos-scenes":
					setActiveFilter("Videos");
					setOcrMode(false);
					setDialogueMode(false);
					setAskMode(false);
					setSceneMode(true);
					break;
				case "screenshots-ocr":
					// Screenshots can be hidden under Settings → Smart Tabs —
					// fall back to All + OCR (still text search) instead of an
					// unreachable tab.
					setActiveFilter(
						visibleBuiltInTabs(enabledTabs).includes("Screenshots")
							? "Screenshots"
							: "All",
					);
					setOcrMode(true);
					setSceneMode(false);
					setDialogueMode(false);
					setAskMode(false);
					break;
				case "all-llms":
					setActiveFilter("All");
					setOcrMode(false);
					setSceneMode(false);
					setDialogueMode(false);
					// LLMs mode is hidden until Settings → LLMs Chat enables
					// it — fall back to Files mode (all modes off) there.
					setAskMode(askEnabled);
					break;
				case "videos-dialogue":
					setActiveFilter("Videos");
					setOcrMode(false);
					setSceneMode(false);
					setAskMode(false);
					// Dialogue mode is video-only (toggle hidden with no
					// videos) — fall back to Files mode on the Videos tab.
					setDialogueMode(hasVideos);
					break;
			}
		},
		[askEnabled, hasVideos, enabledTabs],
	);
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			for (const view of VIEW_IDS) {
				const accel = (viewShortcuts ?? DEFAULT_VIEW_SHORTCUTS)[view];
				if (accel && matchAccelerator(e, accel)) {
					e.preventDefault();
					activateView(view);
					return;
				}
			}
			// Positional tail: plain Cmd+digit only — an extra modifier
			// keeps its own meaning (so recorded Cmd+Shift combos never
			// double-fire here).
			if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (!/^[1-9]$/.test(e.key)) return;
			const tab = tabs[Number(e.key) - 1];
			if (!tab) return;
			e.preventDefault();
			selectTab(tab);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [tabs, selectTab, activateView, viewShortcuts]);

	// Between videos the queue broadcasts "done"; keep the tray alive as a
	// "queued" state so it doesn't flicker during the 250 ms gap + detect
	// startup before the next job's first progress tick.
	const enrichPhase =
		enrich?.phase === "done" && (enrich.pending ?? 0) > 0
			? "queued"
			: enrich?.phase;

	// True while the OCR pass is still running or waiting — the empty state
	// in OCR mode then explains the missing hits (text may not be read yet)
	// instead of implying the text isn't there. Same condition as the tray.
	const ocrBusy =
		ocr?.phase === "ocr" || (ocr?.phase === "queued" && (ocr.pending ?? 0) > 0);

	// Same for Dialogue mode over the speech index (transcribe tray states).
	const transcribeBusy =
		transcribe?.phase === "transcribe" ||
		(transcribe?.phase === "queued" && (transcribe.pending ?? 0) > 0);

	// Rendered column count for the current preference + measured width
	// (null → Auto, where the CSS breakpoint classes decide).
	const renderedColumns = effectiveColumnCount(gridWidth ?? 0, gridColumns);
	// Auto mode resolves to the same breakpoints the old CSS classes used
	// (columns-1 sm:columns-2 lg:columns-3 xl:columns-4) — but as a concrete
	// number, because the virtualized grid needs to know the column count to
	// compute row boundaries. Tailwind's breakpoint classes are VIEWPORT-
	// based (media queries), so the count follows window.innerWidth, not the
	// container width (which is capped by lg:max-w-6xl and only drives the
	// fixed-setting clamp). Re-read on every render — window resizes already
	// re-render via the grid width observer.
	const autoColumns =
		window.innerWidth >= 1280
			? 4
			: window.innerWidth >= 1024
				? 3
				: window.innerWidth >= 640
					? 2
					: 1;
	const columnCount = renderedColumns ?? autoColumns;

	return (
		<>
			{/* Filter tabs — fit-content shell, max 56rem; inner track scrolls past the cap */}
			<div className="mb-6 sm:mb-8">
				<div className="mx-auto w-fit max-w-[56rem] px-4 sm:px-0">
					<div className="group/tabs relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-1.5 shadow-[0_12px_28px_rgba(15,23,42,0.22),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-6px_12px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_16px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-6px_14px_rgba(0,0,0,0.5)] sm:rounded-[1.4rem] sm:p-1.5 overflow-hidden">
						{/* Plastic grain */}
						<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.4rem]" />
						{/* Shell highlight */}
						<div className="pointer-events-none absolute inset-x-4 top-1 h-4 rounded-full bg-white/50 blur-md dark:bg-white/10" />
						<div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-2xl bg-gradient-to-t from-black/15 to-transparent sm:rounded-b-[1.4rem]" />

						{/* Inner bezel — holds scrollable track + fade/arrow overlays */}
						<div className="relative flex items-center rounded-xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-1 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)] sm:rounded-2xl sm:p-1">
							{/* Left fade + arrow — hover/focus only when canScrollLeft */}
							<div
								aria-hidden="true"
								className={`pointer-events-none absolute inset-y-1 left-1 z-10 w-8 rounded-l-xl bg-gradient-to-r from-[#e8edf3] via-[#e8edf3]/80 to-transparent dark:from-[#202833] dark:via-[#202833]/80 transition-opacity duration-200 ${canScrollLeft ? "opacity-100 group-hover/tabs:opacity-100" : "opacity-0"}`}
							/>
							<button
								type="button"
								aria-label="Scroll tabs left"
								onClick={() => scrollTabs(-1)}
								className={`absolute left-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-400/40 bg-white/90 p-1 shadow-[0_1px_4px_rgba(15,23,42,0.18)] backdrop-blur transition-all duration-200 hover:bg-white dark:border-slate-500/50 dark:bg-zinc-700/90 dark:hover:bg-zinc-600 ${canScrollLeft ? "opacity-0 pointer-events-none group-hover/tabs:opacity-100 group-hover/tabs:pointer-events-auto group-focus-within/tabs:opacity-100 group-focus-within/tabs:pointer-events-auto" : "opacity-0 pointer-events-none"}`}
							>
								<IconChevronLeft
									size={14}
									className="text-zinc-600 dark:text-zinc-200"
									aria-hidden="true"
								/>
							</button>

							{/* Scrollable track — only element that scrolls */}
							<div
								ref={tabTrackRef}
								role="tablist"
								aria-label="Memory categories"
								onScroll={updateTabScrollState}
								onPointerDown={onTabTrackPointerDown}
								onPointerMove={onTabTrackPointerMove}
								onPointerUp={endDrag}
								onPointerCancel={endDrag}
								onWheel={(e) => {
									if (
										Math.abs(e.deltaY) > Math.abs(e.deltaX) &&
										isOverflowing
									) {
										e.preventDefault();
										tabTrackRef.current!.scrollLeft += e.deltaY;
									}
								}}
								className={`scrollbar-hide flex flex-nowrap items-center gap-0 overflow-x-auto scroll-smooth overscroll-x-contain snap-x snap-mandatory min-w-0 flex-1 ${isOverflowing ? "justify-start" : "justify-center sm:justify-center"}`}
								style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
							>
								{tabs.map((tab) => {
									const isSelected = activeFilter === tab.id;
									return (
										// role="tab" (not <button>) so nested rename/remove
										// controls can receive real focus — focusable children
										// of a <button> are not tabbable in Chromium.
										<div
											key={tab.isSaved ? `saved:${tab.id}` : tab.id}
											data-tab-id={tab.id}
											role="tab"
											aria-selected={isSelected}
											// Roving tabindex: only the selected tab is in the
											// tab order; Arrow keys move + activate.
											tabIndex={isSelected ? 0 : -1}
											onClick={() => selectTab(tab)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													selectTab(tab);
													return;
												}
												if (e.key === "F2" && tab.isSaved) {
													e.preventDefault();
													openEditTab(tab.id);
													return;
												}
												if (
													(e.key === "Delete" || e.key === "Backspace") &&
													tab.isSaved
												) {
													e.preventDefault();
													handleRemoveTab(tab.id);
													return;
												}
												const focusTabs = Array.from(
													tabTrackRef.current?.querySelectorAll<HTMLElement>(
														'[role="tab"]',
													) ?? [],
												);
												const current = e.currentTarget as HTMLElement;
												const idx = focusTabs.indexOf(current);
												if (idx < 0) return;
												let next: number;
												if (e.key === "ArrowRight") {
													next = (idx + 1) % focusTabs.length;
												} else if (e.key === "ArrowLeft") {
													next =
														(idx - 1 + focusTabs.length) % focusTabs.length;
												} else if (e.key === "Home") {
													next = 0;
												} else if (e.key === "End") {
													next = focusTabs.length - 1;
												} else {
													return;
												}
												e.preventDefault();
												focusTabs[next]?.focus();
												const nextId =
													focusTabs[next]?.getAttribute("data-tab-id");
												const nextTab = tabs.find((t) => t.id === nextId);
												if (nextTab) selectTab(nextTab);
											}}
											title={tab.isSaved ? tab.id : undefined}
											className={`group relative flex min-w-fit cursor-pointer items-center rounded-xl px-2 py-1.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:px-4 sm:py-1.5 sm:text-[13px] ${
												isSelected
													? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_2px_6px_rgba(0,0,0,0.4)]"
													: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
											}`}
										>
											{tab.isSaved ? (
												<span className="flex items-center gap-0 transition-all duration-200 group-hover:gap-0.5 group-focus-within:gap-0.5">
													{tab.label}
													<button
														type="button"
														tabIndex={isSelected ? 0 : -1}
														aria-label={`Rename tab ${tab.label}`}
														title="Rename tab"
														onClick={(e) => {
															e.stopPropagation();
															openEditTab(tab.id);
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																e.stopPropagation();
																openEditTab(tab.id);
															}
														}}
														className="flex h-4 w-4 max-w-0 min-w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-current opacity-0 transition-all duration-200 hover:!opacity-100 group-hover:max-w-4 group-hover:opacity-50 group-focus-within:max-w-4 group-focus-within:opacity-100 group-focus-visible:max-w-4 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-black/30 hover:bg-zinc-400/30 active:scale-90"
													>
														<IconPencil size={11} aria-hidden="true" />
													</button>
													<button
														type="button"
														tabIndex={isSelected ? 0 : -1}
														aria-label={`Remove tab ${tab.label}`}
														title="Remove tab"
														onClick={(e) => {
															e.stopPropagation();
															handleRemoveTab(tab.id);
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																e.stopPropagation();
																handleRemoveTab(tab.id);
															}
														}}
														className="flex h-4 w-4 max-w-0 min-w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-current opacity-0 transition-all duration-200 hover:!opacity-100 group-hover:max-w-4 group-hover:opacity-50 group-focus-within:max-w-4 group-focus-within:opacity-100 group-focus-visible:max-w-4 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-black/30 hover:bg-zinc-400/30 active:scale-90"
													>
														<IconX size={11} aria-hidden="true" />
													</button>
												</span>
											) : (
												tab.label
											)}
										</div>
									);
								})}
							</div>

							{/* Right fade + arrow */}
							<div
								aria-hidden="true"
								className={`pointer-events-none absolute inset-y-1 right-1 z-10 w-8 rounded-r-xl bg-gradient-to-l from-[#e8edf3] via-[#e8edf3]/80 to-transparent dark:from-[#202833] dark:via-[#202833]/80 transition-opacity duration-200 ${canScrollRight ? "opacity-100 group-hover/tabs:opacity-100" : "opacity-0"}`}
							/>
							<button
								type="button"
								aria-label="Scroll tabs right"
								onClick={() => scrollTabs(1)}
								className={`absolute right-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-400/40 bg-white/90 p-1 shadow-[0_1px_4px_rgba(15,23,42,0.18)] backdrop-blur transition-all duration-200 hover:bg-white dark:border-slate-500/50 dark:bg-zinc-700/90 dark:hover:bg-zinc-600 ${canScrollRight ? "opacity-0 pointer-events-none group-hover/tabs:opacity-100 group-hover/tabs:pointer-events-auto group-focus-within/tabs:opacity-100 group-focus-within/tabs:pointer-events-auto" : "opacity-0 pointer-events-none"}`}
							>
								<IconChevronRight
									size={14}
									className="text-zinc-600 dark:text-zinc-200"
									aria-hidden="true"
								/>
							</button>
						</div>
					</div>
				</div>

				{/* Semantic search */}
				<div className="mt-4 flex flex-col items-center gap-3 sm:mt-5">
					<MemorySearch
						value={query}
						onChange={setQuery}
						onPrewarm={prewarm}
						modelState={modelState}
						modelProgress={modelProgress}
						modelFirstRun={modelFirstRun}
						onSaveSearch={askMode ? undefined : handleSaveSearch}
						savedSearch={isSaved(query, savedSearches)}
						placeholder={
							askMode && llmModel
								? `Chat with ${llmModel.shortLabel}…`
								: undefined
						}
					/>{" "}
					{/* Search mode toggle + semantic model picker. Files is
					    whole-file ranking (default); Scenes (visible when the
					    library has videos) finds exact-moment hits inside
					    videos by sight; Dialogue (also video-gated) finds
					    exact moments by what is said — pure speech index,
					    never mixed with scenes; OCR limits results to the
					    images whose visible text matches — no model involved. */}
					<div className="flex w-full max-w-[56rem] items-center justify-end gap-3">
						<div className="mr-auto flex items-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(15,23,42,0.18)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_3px_8px_rgba(0,0,0,0.4)]">
							<button
								aria-label="File search mode"
								title="Rank whole files"
								onClick={() => {
									setSceneMode(false);
									setOcrMode(false);
									setDialogueMode(false);
									setAskMode(false);
								}}
								className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
									!sceneMode && !ocrMode && !dialogueMode && !askMode
										? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
										: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
								} `}
							>
								{!sceneMode && !ocrMode && !dialogueMode && !askMode && (
									<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]" />
								)}
								Files
							</button>
							{hasVideos && (
								<button
									aria-label="Scenes search mode"
									title="Find exact moments inside every video"
									onClick={() => {
										setSceneMode(true);
										setOcrMode(false);
										setDialogueMode(false);
										setAskMode(false);
										// Scenes ranking returns only video moments, so a photo
										// category tab (Screenshots) would
										// filter every hit out — snap back to All instead of
										// showing a guaranteed-empty grid.
										if (
											activeFilter !== "All" &&
											activeFilter !== "Videos" &&
											!isSaved(activeFilter, savedSearches)
										) {
											setActiveFilter("All");
										}
									}}
									className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
										sceneMode
											? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
											: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
									} `}
								>
									{sceneMode && (
										<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]" />
									)}
									Scenes
								</button>
							)}
							{hasVideos && (
								<button
									aria-label="Dialogue search mode"
									title="Find moments by what is said in videos (speech only)"
									onClick={() => {
										setDialogueMode(true);
										setOcrMode(false);
										setSceneMode(false);
										setAskMode(false);
										// Dialogue moments are video-only, like scenes:
										// a photo-category tab would filter every hit
										// out — snap back to All instead of showing a
										// guaranteed-empty grid.
										if (
											activeFilter !== "All" &&
											activeFilter !== "Videos" &&
											!isSaved(activeFilter, savedSearches)
										) {
											setActiveFilter("All");
										}
									}}
									className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
										dialogueMode
											? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
											: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
									} `}
								>
									{dialogueMode && (
										<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]" />
									)}
									Dialogue
								</button>
							)}
							<button
								aria-label="OCR search mode"
								title="Find images by the text visible on them (posters, screenshots)"
								onClick={() => {
									setOcrMode(true);
									setSceneMode(false);
									setDialogueMode(false);
									setAskMode(false);
									// Videos are never OCR'd (their content is scene-
									// searchable), so OCR mode under the Videos tab is a
									// guaranteed-empty combination — snap back to All.
									if (activeFilter === "Videos") {
										setActiveFilter("All");
									}
								}}
								className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
									ocrMode
										? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
										: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
								} `}
							>
								{ocrMode && (
									<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]" />
								)}
								OCR
							</button>
							{askEnabled && (
								<button
									aria-label="LLMs search mode"
									title="Answer a question from the text and speech in your library"
									onClick={() => {
										setAskMode(true);
										setOcrMode(false);
										setSceneMode(false);
										setDialogueMode(false);
										// LLMs spans photos + videos — scoped photo
										// evidence would be filtered out under a
										// category tab like Videos (refinement 3).
										if (
											activeFilter !== "All" &&
											!isSaved(activeFilter, savedSearches)
										) {
											setActiveFilter("All");
										}
									}}
									className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
										askMode
											? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
											: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
									} `}
								>
									{askMode && (
										<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]" />
									)}
									LLMs
								</button>
							)}
							{/* Current-model chip: appears with LLMs mode, naming
						    the engine behind the tab (green = ready, amber =
						    still downloading). */}
							{askMode && <LlmModelBadge model={llmModel} />}
						</div>
						<ModelPicker
							models={models}
							activeModelId={activeModelId}
							modelPreloads={modelPreloads}
							migration={migration}
							engineBusy={modelState === "loading"}
							onSetModel={setModel}
							onPreloadModel={preloadModel}
							onPreloadAll={preloadAllModels}
						/>
					</div>
					{/* LLMs answer card (MDs/Ask-Mode-Plan.md): the LLM answer +
					    clickable citation chips above the evidence grid. A chip
					    opens that row in the lightbox; every claim is one click
					    from its source. */}
					{askMode && (asking || askResult) && (
						<div className="w-full max-w-[56rem]">
							<AskAnswer
								query={parseAskScope(query.trim()).query}
								result={askResult}
								asking={asking}
								streamed={askStreamed}
								liveEvidence={askLiveEvidence}
								progress={askProgress}
								onStop={stopAsk}
								onSelectEvidence={(i) => openLightbox(i)}
								onDismiss={() => {
									clearAsk();
									setQuery("");
								}}
							/>
						</div>
					)}
					{/* Background scene-analysis tray (Phase 4): a live pill so long
					    movies stay visibly "still processing" while shot detection
					    + segment embedding run in the background — detect shows an
					    indeterminate film gate, embed a determinate done/total,
					    and the queue count shows what's still waiting. */}
					{enrich &&
						(enrichPhase === "detect" ||
							enrichPhase === "embed" ||
							(enrichPhase === "paused" && enrich.active) ||
							(enrichPhase === "queued" && enrich.pending > 0)) && (
							<div
								data-enrich-tray
								className="flex w-full max-w-[56rem] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-4 py-2.5 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_rgba(0,0,0,0.5)]"
								aria-live="polite"
							>
								<span
									className={`h-2.5 w-2.5 shrink-0 rounded-full ${
										enrichPhase === "paused" || enrich.paused === true
											? "bg-zinc-500 shadow-[0_0_4px_rgba(148,163,184,0.5)]"
											: "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]"
									}`}
								/>
								<div className="min-w-0 flex-1">
									<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.14em]">
										{enrich.paused === true
											? "Paused"
											: enrichPhase === "detect"
												? "Analyzing scenes"
												: enrichPhase === "embed"
													? "Embedding scenes"
													: enrichPhase === "paused"
														? "Paused while you search"
														: "Scene analysis queued"}
									</p>
									{enrich.filename && (
										<p
											className="phosphor-dim truncate text-xs"
											title={enrich.filename}
										>
											{enrich.filename}
										</p>
									)}
								</div>
								{(enrichPhase === "embed" || enrichPhase === "detect") && (
									<FilmGate
										pct={
											enrichPhase === "embed" && (enrich.total ?? 0) > 0
												? ((enrich.done ?? 0) / (enrich.total ?? 1)) * 100
												: null
										}
										cells={12}
										className="h-1.5 w-28 shrink-0 sm:w-36"
									/>
								)}
								<span className="phosphor-dim shrink-0 font-mono text-[11px] tabular-nums">
									{enrichPhase === "embed" && (enrich.total ?? 0) > 0
										? `${enrich.done ?? 0}/${enrich.total}`
										: enrichPhase === "detect" && enrich.pct != null
											? `${Math.round(enrich.pct * 100)}%`
											: enrichPhase === "queued" && enrich.pending > 0
												? `${enrich.pending} waiting`
												: ""}
								</span>
								<button
									type="button"
									onClick={() =>
										toggleBackgroundPaused(!(enrich.paused === true))
									}
									title={
										enrich.paused === true
											? "Resume background work"
											: "Pause background work (scene analysis, transcription, text reading)"
									}
									className="phosphor-dim shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/10"
								>
									{enrich.paused === true ? "Resume" : "Pause"}
								</button>
							</div>
						)}
					{transcribe &&
						(transcribe.phase === "transcribe" ||
							(transcribe.phase === "queued" &&
								(transcribe.pending ?? 0) > 0)) && (
							<div
								data-transcribe-tray
								className="flex w-full max-w-[56rem] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-4 py-2.5 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_rgba(0,0,0,0.5)]"
								aria-live="polite"
							>
								<span
									className={`h-2.5 w-2.5 shrink-0 rounded-full ${
										transcribe.paused === true
											? "bg-zinc-500 shadow-[0_0_4px_rgba(148,163,184,0.5)]"
											: "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]"
									}`}
								/>
								<div className="min-w-0 flex-1">
									<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.14em]">
										{transcribe.paused === true
											? "Paused"
											: transcribe.phase === "transcribe"
												? "Transcribing speech"
												: "Transcription queued"}
									</p>
									{transcribe.filename && (
										<p
											className="phosphor-dim truncate text-xs"
											title={transcribe.filename}
										>
											{transcribe.filename}
										</p>
									)}
								</div>
								<span className="phosphor-dim shrink-0 font-mono text-[11px] tabular-nums">
									{(transcribe.total ?? 0) > 0
										? `${transcribe.done ?? 0}/${transcribe.total}`
										: (transcribe.pending ?? 0) > 0
											? `${transcribe.pending} waiting`
											: ""}
								</span>
								<button
									type="button"
									onClick={() =>
										toggleBackgroundPaused(!(transcribe.paused === true))
									}
									title={
										transcribe.paused === true
											? "Resume background work"
											: "Pause background work (scene analysis, transcription, text reading)"
									}
									className="phosphor-dim shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/10"
								>
									{transcribe.paused === true ? "Resume" : "Pause"}
								</button>
							</div>
						)}
					{/* Background OCR tray: visible-text extraction runs in the
					    background after imports (and for pre-OCR libraries), so
					    text-heavy photos — posters, screenshots — become
					    keyword-searchable without the user waiting. Same pill
					    language as the enrich tray: amber pulse while a photo is
					    being recognized, queue count while waiting. */}
					{ocr &&
						(ocr.phase === "ocr" ||
							(ocr.phase === "queued" && (ocr.pending ?? 0) > 0)) && (
							<div
								data-ocr-tray
								className="flex w-full max-w-[56rem] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-4 py-2.5 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_rgba(0,0,0,0.5)]"
								aria-live="polite"
							>
								<span
									className={`h-2.5 w-2.5 shrink-0 rounded-full ${
										ocr.paused === true
											? "bg-zinc-500 shadow-[0_0_4px_rgba(148,163,184,0.5)]"
											: "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]"
									}`}
								/>
								<div className="min-w-0 flex-1">
									<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.14em]">
										{ocr.paused === true
											? "Paused"
											: ocr.phase === "ocr"
												? "Reading text"
												: "Text reading queued"}
									</p>
									{ocr.filename && (
										<p
											className="phosphor-dim truncate text-xs"
											title={ocr.filename}
										>
											{ocr.filename}
										</p>
									)}
								</div>
								{(ocr.total ?? 0) > 0 && (
									<FilmGate
										pct={((ocr.done ?? 0) / (ocr.total ?? 1)) * 100}
										cells={12}
										className="h-1.5 w-28 shrink-0 sm:w-36"
									/>
								)}
								<span className="phosphor-dim shrink-0 font-mono text-[11px] tabular-nums">
									{(ocr.total ?? 0) > 0
										? `${ocr.done ?? 0}/${ocr.total}`
										: ocr.phase === "queued" && (ocr.pending ?? 0) > 0
											? `${ocr.pending} waiting`
											: ""}
								</span>
								<button
									type="button"
									onClick={() => toggleBackgroundPaused(!(ocr.paused === true))}
									title={
										ocr.paused === true
											? "Resume background work"
											: "Pause background work (scene analysis, transcription, text reading)"
									}
									className="phosphor-dim shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/10"
								>
									{ocr.paused === true ? "Resume" : "Pause"}
								</button>
							</div>
						)}
					{/* Suggested-search chips (precomputed at build time) */}
					{!searching && suggestedQueries.length > 0 && (
						<div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
							<span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
								Try
							</span>
							{suggestedQueries.map((q) => (
								<button
									key={q}
									onClick={() => setQuery(q)}
									className="rounded-full border border-slate-400/40 bg-white/60 px-3 py-1 text-xs text-zinc-600 transition-colors hover:bg-white hover:text-zinc-900 dark:border-slate-600/60 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-white"
								>
									{q}
								</button>
							))}
						</div>
					)}
				</div>

				{searching && (
					<div
						className="mt-3 flex items-center justify-center gap-2"
						aria-live="polite"
					>
						{isSearching ? (
							<span className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
								<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.8)]" />
								Searching memories…
							</span>
						) : semanticPending ? (
							// Keyword results are already on screen; the CLIP pass is
							// still re-ranking them — keep that visible.
							<span className="flex items-center gap-2 rounded-full border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-3.5 py-1.5 text-[11px] shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.4)]">
								<span className="h-2 w-2 animate-pulse rounded-full bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]" />
								<span className="phosphor-text">
									{displayImages.length === 0
										? "Ranking with AI"
										: "Refining with AI"}
								</span>
							</span>
						) : null}
						{searchError && (
							<span className="text-xs text-red-500 dark:text-red-400">
								· {searchError}
							</span>
						)}
					</div>
				)}
			</div>
			{/* Virtualized Masonry Grid — the card body is memoized
			    (VirtualizedGridBody) so status events (import progress, model
			    download %) re-render the controls but never the tiles. Only
			    the rows around the viewport are mounted, so a large library
			    stays smooth instead of accumulating every tile in the DOM.
			    The brief opacity dip during the semantic upgrade makes the
			    keyword→CLIP swap feel intentional rather than accidental. */}
			<div
				ref={gridRef}
				className={`w-full transition-opacity duration-200 ${
					semanticPending ? "opacity-90" : "opacity-100"
				}`}
			>
				{gridWidth !== null && (
					<VirtualizedGridBody
						items={displayImages}
						columns={columnCount}
						width={gridWidth}
						onOpen={openLightbox}
						onContextMenu={openContextMenu}
						showEmails={activeFilter === "Email"}
					/>
				)}
			</div>
			{/* End of list message — the whole filtered list is always
			    present (C-04: no pagination), so this shows whenever the
			    grid is non-empty and not searching. */}
			{displayImages.length > 0 && !searching && (
				<div className="flex items-center justify-center py-8 text-sm text-zinc-400 dark:text-zinc-500">
					— End of memories —
				</div>
			)}
			{displayImages.length === 0 && !isSearching && !semanticPending && (
				<div className="flex h-64 items-center justify-center rounded-2xl border border-zinc-200 bg-neutral-100/50 dark:border-zinc-800 dark:bg-neutral-900/50">
					<p className="text-zinc-500 dark:text-zinc-400">
						{" "}
						{searching
							? ocrMode
								? ocrBusy
									? "Text is still being read in the background — try again shortly."
									: `No images with matching text for “${query.trim()}”.`
								: sceneMode
									? sceneDataReady
										? `No scene matches for “${query.trim()}”. Try a different description.`
										: "Scene data is still being prepared — try searching again in a moment."
									: dialogueMode
										? transcribeBusy
											? "Speech is still being transcribed in the background — try again shortly."
											: `No dialogue matches for “${query.trim()}”. Try words someone actually says.`
										: askMode
											? asking || semanticPending
												? "Reading your library…"
												: askResult && askResult.ok === false
													? askResult.reason === "not-installed"
														? "LLMs need the local AI model — set it up in Settings → LLMs Chat."
														: (askResult.error ?? "LLMs failed — try again.")
													: `No text or dialogue evidence for “${parseAskScope(query.trim()).query || query.trim()}”.`
											: `No matches for “${query.trim()}”. Try a different description.`
							: activeFilter === "Email"
								? ocrBusy
									? "Still reading text in the background — photos with email addresses will appear here."
									: "No photos with an email address found yet."
								: activeFilter === "Videos"
									? "No videos found in this category."
									: "No images found in this category."}
					</p>
				</div>
			)}
			{/* Lightbox */}
			{lightboxOpen && currentImage && (
				<div
					ref={lightboxRef}
					role="dialog"
					aria-modal="true"
					aria-label={`Photo: ${currentImage.filename}`}
					className="animate-fade-in fixed inset-0 z-50 flex touch-pan-y items-center justify-center p-4"
					onClick={closeLightbox}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
				>
					{/* Backdrop with blur */}
					<div className="absolute inset-0 bg-black/80 backdrop-blur-2xl dark:bg-black/90" />

					{/* Close button */}
					<button
						data-autofocus
						type="button"
						onClick={closeLightbox}
						className="absolute right-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:right-6 sm:top-6"
						aria-label="Close"
					>
						<IconX size={20} className="text-zinc-700 dark:text-zinc-300" />
					</button>

					{/* Navigation buttons */}
					{displayImages.length > 1 && (
						<>
							<button
								onClick={(e) => {
									e.stopPropagation();
									goToPrev();
								}}
								className="absolute left-4 top-1/2 z-50 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:left-8 md:flex"
								aria-label="Previous image"
							>
								<IconChevronLeft
									size={24}
									className="text-zinc-700 dark:text-zinc-300"
								/>
							</button>
							<button
								onClick={(e) => {
									e.stopPropagation();
									goToNext();
								}}
								className="absolute right-4 top-1/2 z-50 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:right-8 md:flex"
								aria-label="Next image"
							>
								<IconChevronRight
									size={24}
									className="text-zinc-700 dark:text-zinc-300"
								/>
							</button>
						</>
					)}

					{/* Show in Finder — reveals the real on-disk file in the OS
					    file manager (source path if still present, else the app's
					    library copy). */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							revealInFinder(currentImage.filename);
						}}
						className="absolute bottom-6 left-6 z-50 flex items-center gap-2 rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] px-4 py-2 text-xs font-medium text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-105 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:text-zinc-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)]"
						title="Reveal this file in Finder"
					>
						<IconFolderOpen
							size={15}
							className="text-zinc-600 dark:text-zinc-400"
							aria-hidden="true"
						/>
						Show in Finder
					</button>

					{/* Main image container */}
					<div
						className="animate-scale-in relative z-10 max-h-[90vh] max-w-[95vw]"
						onClick={(e) => e.stopPropagation()}
					>
						{crtEffect ? (
							<>
								{/* Outer shell */}
								<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_24px_50px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_18px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-10px_18px_rgba(0,0,0,0.5)] sm:rounded-[1.6rem] sm:p-3">
									{/* Plastic grain */}
									<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.6rem]" />
									{/* Shell highlight */}
									<div className="pointer-events-none absolute inset-x-4 top-0.5 h-3 rounded-full bg-white/50 blur-md dark:bg-white/8" />
									{/* Bottom lip */}
									<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-2xl bg-gradient-to-t from-black/15 to-transparent sm:rounded-b-[1.6rem]" />

									{/* Inner bezel */}
									<div className="relative rounded-xl border border-slate-500/45 bg-[#edf2f8] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-2px_4px_rgba(15,23,42,0.15)] dark:border-slate-600/70 dark:bg-[#0a0a0a] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_6px_rgba(0,0,0,0.5)] sm:rounded-2xl sm:p-1.5">
										{/* CRT screen */}
										<div className="relative overflow-hidden rounded-lg border border-white/15 bg-[#060606] shadow-[inset_0_0_1px_rgba(255,255,255,0.16),inset_0_0_90px_rgba(0,0,0,0.9)] sm:rounded-xl">
											{/* Screen curvature */}
											<div className="pointer-events-none absolute inset-0 z-10 rounded-lg shadow-[inset_0_0_110px_rgba(0,0,0,0.7),inset_0_0_40px_rgba(58,58,58,0.2)]" />
											<div className="pointer-events-none absolute inset-x-10 top-2 z-10 h-8 rounded-full bg-white/5 blur-md" />

											{/* Screen glow — phosphor family, matching the CRT themes */}
											<div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-br from-emerald-400/[0.05] via-transparent to-cyan-300/[0.05]" />
											<div className="crt-flicker pointer-events-none absolute inset-0 z-10" />

											{/* Scene chip: explains why a search-opened video
											    started mid-way through. */}
											{isVideo && videoPlayable && currentImage.scene && (
												<div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2">
													<span className="phosphor-text rounded-full border border-[rgba(144,255,169,0.25)] bg-black/70 px-3 py-1 text-[11px] font-semibold shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
														Jumped to scene{" "}
														{formatTimecode(currentImage.scene.t)}
													</span>
												</div>
											)}

											{/* Image */}
											<div className="relative z-[5] flex items-center justify-center p-2 sm:p-4">
												{lightboxMedia}
											</div>
										</div>
									</div>
								</div>
							</>
						) : (
							/* Plain mode: no bezel, no CRT screen, no overlays —
							   just the media on the lightbox backdrop. */
							<div className="relative flex items-center justify-center">
								{isVideo && videoPlayable && currentImage.scene && (
									<div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2">
										<span className="phosphor-text rounded-full border border-[rgba(144,255,169,0.25)] bg-black/70 px-3 py-1 text-[11px] font-semibold shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
											Jumped to scene {formatTimecode(currentImage.scene.t)}
										</span>
									</div>
								)}
								{lightboxMedia}
							</div>
						)}
						{/* Addresses read off the photo — full list with copy,
						    so the lightbox answers "which email?" without
						    squinting at the pixels. Shown whenever the photo
						    carries addresses, whatever tab opened it. */}
						{currentImage.emailAddresses &&
							currentImage.emailAddresses.length > 0 && (
								<LightboxEmailBar
									addresses={currentImage.emailAddresses}
									matches={currentImage.emailMatches ?? []}
								/>
							)}
					</div>

					{/* AI Insights panel (⌘I to toggle) */}
					<AiInsightsPanel
						filename={currentImage.filename}
						open={aiInsightsOpen}
					/>

					{/* Navigation hints */}
					<div className="absolute bottom-6 right-6 z-50 hidden rounded-full border border-slate-500/30 bg-gradient-to-b from-[#eef3f9]/90 to-[#c3cdda]/90 px-4 py-2 text-xs text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(15,23,42,0.2)] dark:border-slate-600/50 dark:from-[#252d38]/90 dark:to-[#151b24]/90 dark:text-zinc-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_6px_rgba(0,0,0,0.4)] sm:block">
						Use &larr; &rarr; to navigate, ESC to close
					</div>

					{/* Mobile swipe hint */}
					<div className="absolute bottom-6 right-6 z-50 block rounded-full border border-slate-500/30 bg-gradient-to-b from-[#eef3f9]/90 to-[#c3cdda]/90 px-4 py-2 text-xs text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(15,23,42,0.2)] dark:border-slate-600/50 dark:from-[#252d38]/90 dark:to-[#151b24]/90 dark:text-zinc-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_6px_rgba(0,0,0,0.4)] sm:hidden">
						&larr; Swipe to navigate &rarr;
					</div>
				</div>
			)}
			{/* Tile context menu (right-click) */}
			{contextMenu && (
				<div ref={contextMenuRef}>
					<TileContextMenu
						x={contextMenu.x}
						y={contextMenu.y}
						filename={contextMenu.image.filename}
						category={contextMenu.image.category}
						onOpen={() => {
							const idx = displayImages.findIndex(
								(d) => d.id === contextMenu.image.id,
							);
							if (idx !== -1) openLightbox(idx);
						}}
						onReveal={() => revealInFinder(contextMenu.image.filename)}
						onDelete={() => deleteMemory(contextMenu.image.filename)}
						onToggleScreenshot={() => {
							if (!onSetCategoryOverride) return;
							// The decision is the INVERSE of the current bucket:
							// a Screenshot leaves the tab (Projects), anything
							// else joins it (Screenshots).
							onSetCategoryOverride(
								contextMenu.image.filename,
								contextMenu.image.category === "Screenshots"
									? "Projects"
									: "Screenshots",
							);
						}}
						onClose={() => setContextMenu(null)}
					/>
				</div>
			)}{" "}
			{/* Save-as-tab / edit-tab dialog: name the tab (create) or
				    rename + re-mode it (edit). */}
			{tabDialog && (
				<SaveTabDialog
					key={
						tabDialog.mode === "edit"
							? `edit:${tabDialog.tab.prompt}`
							: `create:${tabDialog.prompt}`
					}
					title={tabDialog.mode === "edit" ? "Edit tab" : "Name this tab"}
					query={
						tabDialog.mode === "edit" ? tabDialog.tab.prompt : tabDialog.prompt
					}
					defaultName={
						tabDialog.mode === "edit" ? tabDialog.tab.label : tabDialog.prompt
					}
					defaultMode={
						tabDialog.mode === "edit" ? tabDialog.tab.mode : currentMode
					}
					onSave={tabDialog.mode === "edit" ? confirmEditTab : confirmSaveTab}
					onCancel={() => setTabDialog(null)}
				/>
			)}
		</>
	);
}

export default memo(MasonryGrid);

// ---------------------------------------------------------------------------
// Virtualized masonry body
//
// The old GridBody rendered EVERY display item into a CSS multi-column
// layout — the whole library stayed in the DOM forever, so browsing
// collapsed into jank and memory bloat around a few thousand photos. The
// virtualizer replaces it with a windowed uniform grid: every card is an
// exact 4:3 box (aspect-[4/3] in MemoryCard), so rows have a single,
// measurable height and only the rows intersecting the viewport (± one
// viewport of overscan) are mounted at any time. The scroll window tracks
// window.scrollY (the page scrolls on <html>/<body>), so a 50k-photo
// library keeps ~2 viewports of cards in the DOM regardless of library
// size, and the pagination sentinel below still appends pages as the
// virtual height grows.
// ---------------------------------------------------------------------------

interface VirtualizedGridBodyProps {
	items: DisplayItem[];
	/** Rendered column count (resolved from the setting + measured width). */
	columns: number;
	/** Measured width of the grid wrapper (clientWidth). */
	width: number;
	onOpen: (index: number) => void;
	onContextMenu: (e: React.MouseEvent, image: ImageItem) => void;
	/** True on the Email tab — cards overlay the extracted address. */
	showEmails?: boolean;
}

const VirtualizedGridBody = memo(function VirtualizedGridBody({
	items,
	columns,
	width,
	onOpen,
	onContextMenu,
	showEmails = false,
}: VirtualizedGridBodyProps) {
	// The scroll window lives HERE, not in MasonryGrid, so a scroll frame
	// re-renders only the tiles (rAF-throttled; the page scrolls on
	// <html>/<body>, so the window is window.scrollY..+innerHeight).
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportH, setViewportH] = useState(() => window.innerHeight);
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			setScrollTop(window.scrollY);
			setViewportH((prev) =>
				prev === window.innerHeight ? prev : window.innerHeight,
			);
		};
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(update);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", update);
		update();
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", update);
			if (raf) cancelAnimationFrame(raf);
		};
	}, []);

	// The true row height is read off the first rendered card (the estimate
	// is exact by construction, so this only ever corrects sub-pixel drift).
	const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
	const firstCardElRef = useRef<HTMLDivElement | null>(null);
	const firstCardRef = useCallback((el: HTMLDivElement | null) => {
		firstCardElRef.current = el;
		if (!el) return;
		const h = el.offsetHeight;
		if (h > 0) setMeasuredRowH((prev) => (prev === h ? prev : h));
	}, []);

	// Visible window ± one full viewport of overscan (computed inside
	// virtualGridLayout), so fast scrolling never flashes empty space while
	// the mounted-card count stays bounded no matter how large the library
	// gets (pure math — see virtualGrid.ts).
	const { colWidth, stride, totalHeight, sliceStart, sliceEnd } =
		virtualGridLayout({
			itemCount: items.length,
			columns,
			width,
			scrollTop,
			viewportH,
			measuredRowH,
		});

	// A column-count/width change resizes every card: re-read the first
	// rendered card's height instead of trusting the stale measurement. The
	// first-card ref fires BEFORE this effect on mount, so guard against
	// clobbering a just-landed measurement with null.
	const prevColWidthRef = useRef<number | null>(null);
	useEffect(() => {
		if (
			prevColWidthRef.current !== null &&
			prevColWidthRef.current !== colWidth
		) {
			const h = firstCardElRef.current?.offsetHeight;
			setMeasuredRowH(h && h > 0 ? h : null);
		}
		prevColWidthRef.current = colWidth;
	}, [colWidth]);

	// Filenames whose image resolved at least once this session: remounted
	// cards render opaque immediately instead of replaying the load fade.
	const loadedFilenamesRef = useRef<Set<string>>(new Set());

	if (colWidth <= 0 || items.length === 0) {
		return <div className="w-full" />;
	}

	return (
		<div className="relative w-full" style={{ height: totalHeight }}>
			{/* eslint-disable-next-line react-hooks/refs -- render-phase read of a session Set; remounts must not replay the fade. Revisit in M-12. */}
			{items.slice(sliceStart, sliceEnd).map((image, i) => {
				const globalIndex = sliceStart + i;
				const row = Math.floor(globalIndex / columns);
				const col = globalIndex % columns;
				return (
					<div
						key={image.id}
						ref={i === 0 ? firstCardRef : undefined}
						className="absolute"
						style={{
							top: row * stride,
							left: col * (colWidth + ROW_GAP),
							width: colWidth,
						}}
					>
						<MemoryCard
							image={image.filename}
							priority={i < 6}
							forceVisible={loadedFilenamesRef.current.has(image.filename)}
							onLoaded={(filename) => {
								loadedFilenamesRef.current.add(filename);
							}}
							bestScene={image.scene ?? null}
							highlightedWords={image.ocrHighlights ?? []}
							matchReason={image.matchReason}
							dominant={image.dominant}
							matchBreakdown={image.matchBreakdown}
							emailAddresses={image.emailAddresses ?? []}
							emailMatches={image.emailMatches ?? []}
							showEmailOverlay={showEmails}
							onClick={(e) => {
								// Right-click / ctrl+click is reserved for the
								// context menu; only plain left-clicks open.
								if (e.button !== 0 || e.ctrlKey) return;
								onOpen(globalIndex);
							}}
							onContextMenu={(e) => onContextMenu(e, image)}
						/>
					</div>
				);
			})}
		</div>
	);
});

// Contact sheet under the lightbox media — the full address list at large
// size (copy + compose per row), so the lightbox answers
// "which email?" without squinting at pixels. Shown whenever the opened
// photo carries addresses, whatever tab opened it.
function LightboxEmailBar({
	addresses,
	matches = [],
}: {
	addresses: string[];
	matches?: EmailMatch[];
}) {
	const evidence = new Map(matches.map((m) => [m.address, m]));
	return (
		<div className="mt-3 flex justify-center">
			<div className="w-fit max-w-full rounded-2xl border border-white/15 bg-black/70 px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md">
				<p className="mb-1.5 px-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-sky-200/70">
					Email{addresses.length > 1 ? "s" : ""} on this photo
				</p>
				<div className="flex max-w-[min(78vw,26rem)] flex-col gap-1.5">
					{addresses.map((email) => {
						const match = evidence.get(email);
						return (
							<EmailRow
								key={email}
								email={email}
								evidenceTitle={match ? formatEmailEvidence(match) : undefined}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}

// Dialog shown when the user clicks "Save as tab" (create) or a saved
// tab's pencil (edit): the tab's display name defaults to the query (or
// keeps its current name when editing) but can be anything, and the search
// mode can be picked too. Enter or clicking Save confirms; Escape or
// clicking the backdrop cancels.
function SaveTabDialog({
	title,
	query,
	defaultName,
	defaultMode,
	onSave,
	onCancel,
}: {
	title: string;
	/** The underlying search query this tab runs — fixed, shown for context. */
	query: string;
	defaultName: string;
	defaultMode: SavedTabMode;
	onSave: (label: string, mode: SavedTabMode) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState(defaultName);
	const [mode, setMode] = useState<SavedTabMode>(defaultMode);
	const inputRef = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	useFocusTrap(dialogRef, true);

	const trimmed = normalizePrompt(name);
	const submit = () => {
		if (!trimmed) return;
		onSave(trimmed, mode);
	};

	const modeOptions: { id: SavedTabMode; label: string }[] = [
		{ id: "files", label: "Files" },
		{ id: "scenes", label: "Scenes" },
		{ id: "ocr", label: "OCR" },
		{ id: "dialogue", label: "Dialogue" },
	];

	return (
		<div
			className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center p-4"
			role="presentation"
		>
			{/* Backdrop — click to cancel */}
			<div
				className="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onClick={onCancel}
			/>
			{/* Dialog shell: the plastic projector bezel language of the
			    tab bar and search bar. */}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label="Name this tab"
				className="relative w-full max-w-sm animate-scale-in rounded-3xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_24px_50px_rgba(15,23,42,0.35),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_18px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-10px_18px_rgba(0,0,0,0.5)]"
			>
				<div className="plastic-grain pointer-events-none absolute inset-0 rounded-3xl" />
				<div className="pointer-events-none absolute inset-x-6 top-2 h-6 rounded-full bg-white/50 blur-md dark:bg-white/10" />
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-3xl bg-gradient-to-t from-black/15 to-transparent" />

				{/* Inner bezel */}
				<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
					<p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
						{title}
					</p>
					<p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
						Runs search: “{query}”
					</p>
					<input
						ref={inputRef}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
							else if (e.key === "Escape") onCancel();
						}}
						placeholder="Tab name"
						maxLength={60}
						aria-label="Tab name"
						data-autofocus
						className="mt-3 w-full rounded-xl border border-slate-500/45 bg-white/70 px-3 py-2 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 focus:ring-2 focus:ring-zinc-400 dark:border-slate-600/70 dark:bg-black/30 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:ring-zinc-500"
					/>
					{/* Search mode this tab runs when clicked — same three-way
					    Files/Scenes/Dialogue/OCR choice as the search bar. */}
					<div className="mt-3">
						<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
							Search mode
						</p>
						<div className="mt-1.5 flex w-fit items-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(15,23,42,0.18)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_3px_8px_rgba(0,0,0,0.4)]">
							{modeOptions.map((opt) => (
								<button
									key={opt.id}
									type="button"
									aria-label={`Tab mode: ${opt.label}`}
									aria-pressed={mode === opt.id}
									onClick={() => setMode(opt.id)}
									className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
										mode === opt.id
											? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
											: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
									}`}
								>
									{opt.label}
								</button>
							))}
						</div>
					</div>
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={onCancel}
							className="rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-4 py-1.5 text-xs font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={submit}
							disabled={!trimmed}
							className="rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-4 py-1.5 text-xs font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.25)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white"
						>
							Save tab
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
