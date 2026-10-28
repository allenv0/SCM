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
// Phase 4b: MemoryCard moved with VirtualizedGridBody (grid/ only).
import VirtualizedGridBody from "./grid/VirtualizedGridBody";
import TabBar, { type Tab } from "./grid/TabBar";
import BackgroundTray from "./grid/BackgroundTray";
import SearchModeToggle, { type SearchMode } from "./grid/SearchModeToggle";
import UnplayableVideo from "./grid/UnplayableVideo";
import SaveTabDialog from "./grid/SaveTabDialog";
import Lightbox from "./grid/Lightbox";
import OcrHighlightBoxes from "./OcrHighlightBoxes";
import MemorySearch from "./MemorySearch";
import ModelPicker from "./ModelPicker";
import TileContextMenu from "./TileContextMenu";
import AskAnswer from "./AskAnswer";
import { useMemorySearch } from "@/hooks/useMemorySearch";
import { useBackgroundStatus } from "@/hooks/useBackgroundStatus";
import { useGridSearch } from "@/hooks/useGridSearch";
import { useLightbox } from "@/hooks/useLightbox";
import { useTabStrip } from "@/hooks/useTabStrip";
import { useYoutubeLibrary } from "@/hooks/useYoutubeLibrary";
import { useAsk } from "@/hooks/useAsk";
import { parseAskScope } from "@/lib/askScope";
// ImageItem lives in @/types (Phase 4d dedupe — the grid's copy missed
// sourcePath/screenshotHint, which the store always fills).
import type { ImageItem } from "@/types";
import type {
	RankedMemory,
	SceneMatch,
	ScoreBreakdown,
} from "@/lib/memoryRank";
import { matchingOcrWordBoxes } from "@/lib/ocrHighlights";
import type { OcrWordBox } from "@/lib/ocrHighlights";
import type { MatchDominant } from "@/lib/matchTone";
import { newestMediaFirst } from "@/lib/mediaOrder";
import {
	effectiveColumnCount,
	type GridColumnsSetting,
} from "@/lib/gridColumns";
// Phase 4b: virtualGridLayout + ROW_GAP moved with VirtualizedGridBody.
import { isVideoFile, isPlayableVideoFile, projectFor } from "@/lib/media";
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
import { VIEW_IDS, matchAccelerator, type ViewId } from "@/lib/viewShortcuts";
import { DEFAULT_SHORTCUTS, type ShortcutMap } from "@/lib/inAppShortcuts";
import { assertNever } from "@/lib/assertNever";
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

// A tile the grid can render: the library item plus (in search context) the
// best-scene match it arrived with. Carried ON the item (not in a separate
// filename→scene map) because Scenes mode can surface the SAME video at
// several timestamps — each result needs its own scene for the badge,
// poster swap, and lightbox seek.
export interface DisplayItem extends ImageItem {
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
	/** In-app shortcut map (Settings → Keyboard): the six semantic
	 *  library views (⌘1–6 by default) plus the lightbox actions. Defaults
	 *  reproduce the shipped mapping; a "" entry is deliberately unset. */
	shortcuts?: ShortcutMap;
	/** Enabled built-in tabs (Settings → Smart Tabs). Toggleable tabs
	 *  missing from the set are hidden from the tab bar; All/Videos are
	 *  always on regardless. Defaults to the stored set. */
	enabledTabs?: Set<string>;
	/** Lightbox CRT screen effect (Settings → Appearance). On (default)
	 *  frames photo/video on a retro monitor; off is a plain viewer. */
	crtEffect?: boolean;
	/** Called with the filename (and, when the envelope carries one, the
	 *  failure reason) when a tile delete fails (bridge rejection or !ok) —
	 *  App toasts it. Without this, failures were console-only and a failed
	 *  delete masqueraded as success. Optional. */
	onDeleteFailure?: (filename: string, reason?: string) => void;
	/** Called with the reason when a model switch fails — App toasts it.
	 *  The switch answers with a result ({ ok: false, error }), so this is
	 *  how the failure reaches the user instead of vanishing. Optional. */
	onModelFailure?: (message: string) => void;
}

function MasonryGrid({
	initialImages = [],
	modelState = "idle",
	modelProgress = null,
	modelFirstRun = false,
	gridColumns = "auto",
	shortcuts = DEFAULT_SHORTCUTS,
	enabledTabs = readStoredEnabledTabs(),
	crtEffect = true,
	onSetCategoryOverride,
	onDeleteFailure,
	onModelFailure,
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

	// Tab-bar mechanics (overflow fades/arrows, arrow scroll, drag panning).
	const {
		tabTrackRef,
		updateTabScrollState,
		canScrollLeft,
		canScrollRight,
		isOverflowing,
		scrollTabs,
		onTabTrackPointerDown,
		onTabTrackPointerMove,
		endDrag,
	} = useTabStrip();

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
	// Videos are always on; Screenshots/Email/YouTube render only when enabled.
	const visibleCategories = useMemo(
		() => visibleBuiltInTabs(enabledTabs),
		[enabledTabs],
	);

	// YouTube membership: filenames + per-file channel from youtube.json
	// (main-process metadata). Overlapping view like Email — items keep
	// their Videos membership. Refreshed on mount and on every library or
	// youtube status broadcast.
	// YouTube tab state: file set, channel map, active channel, counted chips.
	const { ytFilenames, ytChannel, setYtChannel, ytChannels, matchesTabWithYt } =
		useYoutubeLibrary(matchesTab);

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
		isReady: indexReady,
		models,
		activeModelId,
		migration,
		modelPreloads,
		preloadModel,
		preloadAllModels,
		ocrWordBoxesByFilename,
	} = useMemorySearch(
		initialImages.map((img) => img.filename),
		{
			onModelFailure,
		},
	);

	// LLMs mode state (parked — see shared/feature-flags.ts): the answer,
	// live evidence stream, and in-flight question all come from useAsk.
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

	// Search state + dispatch: query, the five mode flags, ranked results,
	// and the keyword→semantic pipeline (sequencing lives in the hook).
	const {
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
	} = useGridSearch(
		{
			search,
			searchScenes,
			searchDialogue,
			searchKeyword,
			searchOcr,
			indexReady,
			ask,
			clearAsk,
		},
		initialImages,
		askLiveEvidence,
	);

	// The toggle only makes sense when the library actually has videos.
	const hasVideos = initialImages.some((img) => isVideoFile(img.filename));

	// Background scene-analysis tray (Phase 4): main streams "enrich" status
	// events as videos are shot-detected + segment-embedded in the
	// background. The pill under the search bar keeps long movies visibly
	// "still processing" instead of silent, and shows the queue draining.
	// Background trays (scene enrichment, transcription, OCR) share one
	// status subscription; see the hook for the pull-on-library-updated rule.
	const { enrich, transcribe, ocr, toggleBackgroundPaused } =
		useBackgroundStatus();

	// Tile right-click context menu
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		image: ImageItem;
	} | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

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
					: browseSource.filter((img) => matchesTabWithYt(img, tabId));
			setFilteredImages(filtered);
		},
		[browseSource, matchesTabWithYt],
	);

	// Initial load, filter change, and library refresh (a new initialImages
	// identity — e.g. after importing photos — rebuilds the grid).
	// Computes the list directly from current state to avoid the
	// flash-of-empty-state that a wipe-then-rebuild causes.
	useEffect(() => {
		applyFilter(activeFilter);
	}, [activeFilter, browseSource, applyFilter]);

	// A channel that vanished (unsubscribed, metadata reset) must not leave
	// the YouTube tab filtered to nothing — fall back to All channels.
	useEffect(() => {
		if (ytChannel === "All") return;
		if (!ytChannels.some((c) => c.name === ytChannel)) setYtChannel("All");
	}, [ytChannel, ytChannels]);

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
			switch (dom) {
				case "ocr":
					return "Text on photo";
				case "filename":
				case "phrase":
					return "Filename match";
				case "semantic":
					return "Visual match";
				case undefined:
					return undefined;
				default:
					// New dominant variants fail HERE at compile time instead
					// of silently rendering an unlabeled tile.
					assertNever(dom);
			}
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
			.filter((img) => savedTabActive || matchesTabWithYt(img, activeFilter));
	}, [
		searchResults,
		imagesByFilename,
		activeFilter,
		savedTabActive,
		matchesTabWithYt,
		query,
		ocrWordBoxesByFilename,
		ocrMode,
	]);
	const displayImages: DisplayItem[] = useMemo(
		() => (searching ? searchDisplay : filteredImages),
		[searching, searchDisplay, filteredImages],
	);

	// Lightbox mechanics (open/close, wrap-around navigation, swipe, the
	// recordable keyboard map, crash breadcrumbs, body-scroll lock) live in
	// the hook; the item list is the current display list, so navigation
	// always follows what is on screen.
	const {
		lightboxOpen,
		currentIndex,
		videoRef,
		aiInsightsOpen,
		openLightbox: openLightboxAt,
		closeLightbox,
		goToNext,
		goToPrev,
		onTouchStart,
		onTouchMove,
		onTouchEnd,
	} = useLightbox(displayImages, shortcuts);

	// Opening from a tile also dismisses the right-click menu.
	const openLightbox = useCallback(
		(index: number) => {
			setContextMenu(null);
			openLightboxAt(index);
		},
		[openLightboxAt],
	);

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
						onDeleteFailure?.(filename, res?.error);
					}
				})
				.catch((err) => {
					console.warn("[memories] delete failed for", filename);
					onDeleteFailure?.(filename, (err as { message?: string })?.message);
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

	// A changing query rewrites displayImages under an open lightbox or tile
	// menu: close both on any query edit instead of letting them desync.
	useEffect(() => {
		if (lightboxOpen) closeLightbox();
		setContextMenu(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query]);

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
			src={projectFor(currentImage.filename)}
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
				src={projectFor(currentImage.filename)}
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
				src={projectFor(currentImage.filename)}
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

	// The mode the toggle shows: currentMode plus the (unsavable) LLMs mode.
	// Derived from the four booleans so ranking keeps reading them directly.
	const searchMode: SearchMode = askMode ? "ask" : currentMode;

	// Switching modes clears the other three and snaps the active category
	// back to All when the new mode cannot show it — a photo tab under
	// Scenes/Dialogue, Videos or YouTube under OCR, a category under LLMs:
	// each would otherwise render a guaranteed-empty grid.
	const setSearchMode = useCallback(
		(mode: SearchMode) => {
			setOcrMode(mode === "ocr");
			setSceneMode(mode === "scenes");
			setDialogueMode(mode === "dialogue");
			setAskMode(mode === "ask");
			if (mode === "scenes" || mode === "dialogue") {
				if (
					activeFilter !== "All" &&
					activeFilter !== "Videos" &&
					activeFilter !== "YouTube" &&
					!isSaved(activeFilter, savedSearches)
				) {
					setActiveFilter("All");
				}
			} else if (mode === "ocr") {
				if (activeFilter === "Videos" || activeFilter === "YouTube") {
					setActiveFilter("All");
				}
			} else if (mode === "ask") {
				if (activeFilter !== "All" && !isSaved(activeFilter, savedSearches)) {
					setActiveFilter("All");
				}
			}
		},
		[
			activeFilter,
			savedSearches,
			setAskMode,
			setDialogueMode,
			setOcrMode,
			setSceneMode,
		],
	);

	// Confirm the create dialog: add the tab (prompt = the query it runs,
	// label = whatever name the user picked, mode = the search mode it was
	// saved in) and activate it — the highlighted tab then always matches
	// what's on screen. Category names are reserved, so a saved search can
	// never shadow a built-in tab.
	const confirmSaveTab = useCallback(
		(label: string, mode: SavedTabMode, watch?: boolean) => {
			if (!tabDialog || tabDialog.mode !== "create") return;
			const p = tabDialog.prompt;
			setSavedSearches((prev) =>
				addSavedSearch(prev, p, label, mode, 20, watch === true),
			);
			setActiveFilter(p);
			setTabDialog(null);
		},
		[tabDialog],
	);

	// Confirm the edit dialog: keep the prompt (identity) but adopt the
	// new label and search mode.
	const confirmEditTab = useCallback(
		(label: string, mode: SavedTabMode, watch?: boolean) => {
			if (!tabDialog || tabDialog.mode !== "edit") return;
			const p = tabDialog.tab.prompt;
			setSavedSearches((prev) =>
				updateSavedSearch(prev, p, { label, mode, watch }),
			);
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
		[activeFilter, setQuery],
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
			watch: tab.watch === true,
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
	const selectTab = useCallback(
		(tab: Tab) => {
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
				// LLMs spans the whole library by design — a category click ends
				// it like every other mode switch.
				setAskMode(false);
				// Videos opens in Scenes mode so a click lands on visual moments.
				// YouTube opens in Dialogue mode: subscription videos are
				// speech-heavy (talks, essays, explainers), so spoken-line jumps
				// are the useful default; Scenes is one click away.
				setSceneMode(tab.id === "Videos");
				setDialogueMode(tab.id === "YouTube");
				// The All tab is home — clicking it also clears any active query
				// so the full library (Files mode) is back on screen.
				if (tab.id === "All") setQuery("");
			}
		},
		[setAskMode, setDialogueMode, setOcrMode, setQuery, setSceneMode],
	);

	// View shortcuts (Settings → Keyboard, Cmd+1–6 by default): six
	// semantic views, each a category tab + search mode pair. Recorded
	// combos dispatch first (in VIEW_IDS order, so a hand-edited duplicate
	// deterministically favors the earliest view); plain Cmd+digit keeps
	// the historic positional fallback (tabs[digit-1]) for saved tabs and
	// any digit the user unassigned from the views — with the shipped
	// defaults that is 7–9 (the Settings reference table reads the live
	// map). An unset view ("") never matches.
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
				case "email-ocr":
					// Email can be hidden under Settings → Smart Tabs — fall
					// back to All + OCR (the same text evidence the tab
					// filters on) instead of an unreachable tab.
					setActiveFilter(
						visibleBuiltInTabs(enabledTabs).includes("Email") ? "Email" : "All",
					);
					setOcrMode(true);
					setSceneMode(false);
					setDialogueMode(false);
					setAskMode(false);
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
					// LLMs mode is parked (ASK_MODE_VISIBLE) and also hidden
					// until Settings → LLMs Chat enables it — either way the
					// key falls back to Files mode (all modes off) here.
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
				default:
					// New views fail HERE at compile time instead of
					// silently falling through with every mode untouched.
					assertNever(view);
			}
		},
		[
			askEnabled,
			hasVideos,
			enabledTabs,
			setAskMode,
			setDialogueMode,
			setOcrMode,
			setQuery,
			setSceneMode,
		],
	);
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			for (const view of VIEW_IDS) {
				const accel = shortcuts[view];
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
	}, [tabs, selectTab, activateView, shortcuts]);

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
			{/* Filter tabs + search controls share one wrapper so their vertical
			    rhythm (and the trailing margin) matches the pre-split layout. */}
			<div className="mb-6 sm:mb-8">
				<TabBar
					tabs={tabs}
					activeFilter={activeFilter}
					selectTab={selectTab}
					openEditTab={openEditTab}
					handleRemoveTab={handleRemoveTab}
					tabTrackRef={tabTrackRef}
					updateTabScrollState={updateTabScrollState}
					onTabTrackPointerDown={onTabTrackPointerDown}
					onTabTrackPointerMove={onTabTrackPointerMove}
					endDrag={endDrag}
					scrollTabs={scrollTabs}
					canScrollLeft={canScrollLeft}
					canScrollRight={canScrollRight}
					isOverflowing={isOverflowing}
					ytChannels={ytChannels}
					ytChannel={ytChannel}
					setYtChannel={setYtChannel}
				/>
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
						<SearchModeToggle
							mode={searchMode}
							hasVideos={hasVideos}
							askEnabled={askEnabled}
							llmModel={llmModel}
							onSelect={setSearchMode}
						/>
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
							<BackgroundTray
								dataAttr="data-enrich-tray"
								paused={enrich.paused === true}
								title={
									enrich.paused === true
										? "Paused"
										: enrichPhase === "detect"
											? "Analyzing scenes"
											: enrichPhase === "embed"
												? "Embedding scenes"
												: enrichPhase === "paused"
													? "Paused while you search"
													: "Scene analysis queued"
								}
								filename={enrich.filename}
								showGate={enrichPhase === "embed" || enrichPhase === "detect"}
								gatePct={
									enrichPhase === "embed" && (enrich.total ?? 0) > 0
										? ((enrich.done ?? 0) / (enrich.total ?? 1)) * 100
										: null
								}
								countLabel={
									enrichPhase === "embed" && (enrich.total ?? 0) > 0
										? `${enrich.done ?? 0}/${enrich.total}`
										: enrichPhase === "detect" && enrich.pct != null
											? `${Math.round(enrich.pct * 100)}%`
											: enrichPhase === "queued" && enrich.pending > 0
												? `${enrich.pending} waiting`
												: ""
								}
								onTogglePause={() =>
									toggleBackgroundPaused(!(enrich.paused === true))
								}
							/>
						)}
					{transcribe &&
						(transcribe.phase === "transcribe" ||
							(transcribe.phase === "queued" &&
								(transcribe.pending ?? 0) > 0)) && (
							<BackgroundTray
								dataAttr="data-transcribe-tray"
								paused={transcribe.paused === true}
								title={
									transcribe.paused === true
										? "Paused"
										: transcribe.phase === "transcribe"
											? "Transcribing speech"
											: "Transcription queued"
								}
								filename={transcribe.filename}
								countLabel={
									(transcribe.total ?? 0) > 0
										? `${transcribe.done ?? 0}/${transcribe.total}`
										: (transcribe.pending ?? 0) > 0
											? `${transcribe.pending} waiting`
											: ""
								}
								onTogglePause={() =>
									toggleBackgroundPaused(!(transcribe.paused === true))
								}
							/>
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
							<BackgroundTray
								dataAttr="data-ocr-tray"
								paused={ocr.paused === true}
								title={
									ocr.paused === true
										? "Paused"
										: ocr.phase === "ocr"
											? "Reading text"
											: "Text reading queued"
								}
								filename={ocr.filename}
								showGate={(ocr.total ?? 0) > 0}
								gatePct={((ocr.done ?? 0) / (ocr.total ?? 1)) * 100}
								countLabel={
									(ocr.total ?? 0) > 0
										? `${ocr.done ?? 0}/${ocr.total}`
										: ocr.phase === "queued" && (ocr.pending ?? 0) > 0
											? `${ocr.pending} waiting`
											: ""
								}
								onTogglePause={() =>
									toggleBackgroundPaused(!(ocr.paused === true))
								}
							/>
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
									: !indexReady
										? "The text index is still loading — try again in a moment."
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
														? askResult.missing === "binary"
															? "Chat engine missing — Settings → LLMs Chat → Download under Chat engine."
															: askResult.missing === "model"
																? "Chat model file missing — Settings → LLMs Chat → Download the model."
																: "LLMs need the local AI model — set it up in Settings → LLMs Chat."
														: (askResult.error ?? "LLMs failed — try again.")
													: `No text or dialogue evidence for “${parseAskScope(query.trim()).query || query.trim()}”.`
											: `No matches for “${query.trim()}”. Try a different description.`
							: activeFilter === "Email"
								? ocrBusy
									? "Still reading text in the background — photos with email addresses will appear here."
									: "No photos with an email address found yet."
								: activeFilter === "Videos"
									? "No videos found in this category."
									: activeFilter === "YouTube"
										? ytFilenames.size === 0
											? "No YouTube downloads yet — add a link in Settings → YouTube."
											: `No videos from ${ytChannel === "All" ? "these channels" : ytChannel} match.`
										: "No images found in this category."}
					</p>
				</div>
			)}
			{/* Lightbox */}
			{lightboxOpen && currentImage && (
				<Lightbox
					image={currentImage}
					media={lightboxMedia}
					total={displayImages.length}
					onClose={closeLightbox}
					onPrev={goToPrev}
					onNext={goToNext}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
					crtEffect={crtEffect}
					onReveal={revealInFinder}
					isVideo={isVideo}
					videoPlayable={videoPlayable}
					aiInsightsOpen={aiInsightsOpen}
					shortcuts={shortcuts}
				/>
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
					defaultWatch={
						tabDialog.mode === "edit" ? tabDialog.tab.watch === true : false
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
