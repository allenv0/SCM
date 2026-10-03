"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPhotoPlus, IconSettings } from "@tabler/icons-react";
import FilmGate from "@/components/FilmGate";
import MasonryGrid from "@/components/MasonryGrid";
import DropOverlay from "@/components/DropOverlay";
import SettingsSheet from "@/components/SettingsSheet";
import Onboarding from "@/onboarding/Onboarding";
import { useOnboarding } from "@/onboarding/useOnboarding";
import { useTheme } from "@/hooks/useTheme";
import { useCrtEffect } from "@/hooks/useCrtEffect";
import { useGridColumns } from "@/hooks/useGridColumns";
import { useVideoQuality } from "@/hooks/useVideoQuality";
import { useWhisperModel } from "@/hooks/useWhisperModel";
import { useOcrLangs } from "@/hooks/useOcrLangs";
import { useAppIcon } from "@/hooks/useAppIcon";
import { useViewShortcuts } from "@/hooks/useViewShortcuts";
import { useEnabledTabs } from "@/hooks/useEnabledTabs";
import { getCategory, type CategoryOverride } from "@/lib/categories";
import { extractEmailMatches, type EmailMatch } from "@/lib/emailAddress";
import { shortName, importResultToast } from "@/lib/importToast";
import { isVideoFile } from "@/lib/media";
import type {
	ImportPhase,
	ImportResult,
	ModelPhase,
	StatusPayload,
} from "@/types";

interface ImageItem {
	id: string;
	filename: string;
	category: string;
	/** Source-file mtime captured at import; null when it was unavailable. */
	modifiedAt: number | null;
	/** Original import path recorded by main; null for pre-`sources` rows. */
	sourcePath: string | null;
	/** Import-time PNG/JPEG metadata probe (rename-proof screenshot signal). */
	screenshotHint: boolean;
	/** Whether the photo's OCR text contains an email address — the
	 *  membership signal for the Email tab (a photo can also belong to
	 *  Screenshots/etc.; the bucket is an overlapping view, not a
	 *  category). */
	hasEmail: boolean;
	/** Cleaned addresses for the Email-tab card overlay (first-seen order,
	 *  capped — see extractEmailMatches). Empty when hasEmail is false. */
	emailAddresses: string[];
	/** Match evidence behind emailAddresses (same order): powers the
	 *  "found as" tooltips on tiles and the lightbox sheet. */
	emailMatches: EmailMatch[];
}

interface ImportProgress {
	phase: ImportPhase;
	filename: string;
	done: number;
	total: number;
}

const PHASE_LABELS: Record<ImportPhase, string> = {
	copying: "Copying",
	embedding: "Analyzing with AI",
	poster: "Generating poster",
	indexing: "Indexing",
	// Terminal event — the card is cleared on it, never rendered.
	done: "Done",
};

// Result toasts are brief; one-time notices (startup repair, failed
// imports) deserve long enough to actually be read.
const TOAST_MS = 4000;
const LONG_TOAST_MS = 8000;

function healSummary(healed: number, attempted: number): string {
	if (healed === attempted) {
		return `Repaired ${healed} damaged AI index entr${healed === 1 ? "y" : "ies"} — search quality restored`;
	}
	if (healed > 0) {
		return `Partially repaired AI index (${healed}/${attempted} rows)`;
	}
	return `AI index repair failed (${attempted} rows) — some searches may miss results`;
}

type ToastTone = "default" | "success" | "warning" | "error";

// Semantic toast treatments (the STATE layer of the AI color system): the
// surface stays plastic, the border + text tint carry the hue.
const TOAST_TONE: Record<ToastTone, string> = {
	default:
		"border-slate-500/45 bg-gradient-to-b from-[#eef3f9]/95 to-[#c3cdda]/95 text-zinc-700 dark:border-slate-600/70 dark:from-[#252d38]/95 dark:to-[#151b24]/95 dark:text-zinc-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.6)]",
	success:
		"border-[rgba(var(--ai-ready-rgb),0.5)] bg-gradient-to-b from-emerald-50/95 to-emerald-100/95 text-emerald-800 dark:border-[rgba(var(--ai-ready-rgb),0.6)] dark:from-emerald-950/95 dark:to-emerald-900/95 dark:text-emerald-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.6)]",
	warning:
		"border-amber-500/50 bg-gradient-to-b from-amber-50/95 to-amber-100/95 text-amber-800 dark:border-amber-500/60 dark:from-amber-950/95 dark:to-amber-900/95 dark:text-amber-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.6)]",
	error:
		"border-[rgba(var(--ai-error-rgb),0.5)] bg-gradient-to-b from-rose-50/95 to-rose-100/95 text-rose-800 dark:border-[rgba(var(--ai-error-rgb),0.6)] dark:from-rose-950/95 dark:to-rose-900/95 dark:text-rose-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.6)]",
};

export default function App() {
	const [images, setImages] = useState<ImageItem[]>([]);
	const [libraryLoaded, setLibraryLoaded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [importProgress, setImportProgress] = useState<ImportProgress | null>(
		null,
	);
	const [toast, setToast] = useState<{
		message: string;
		duration: number;
		tone: ToastTone;
	} | null>(null);
	const [modelState, setModelState] = useState<ModelPhase | "idle">("idle");
	const [modelProgress, setModelProgress] = useState<number | null>(null);
	// True while the CLIP weights are still being fetched (first launch) —
	// drives the one-time download hint inside the search bar.
	const [modelFirstRun, setModelFirstRun] = useState(false);
	// The Settings sheet (Appearance, Grid, Shortcuts).
	const [settingsOpen, setSettingsOpen] = useState(false);

	// First-run CRT tour (website's monitor + three demo channels). Shows
	// once per machine; Done/Skip persists the flag in localStorage.
	// Preview with ?onboarding=1, suppress with ?onboarding=0.
	const {
		show: showOnboarding,
		dismiss: dismissOnboarding,
		reset: replayOnboarding,
	} = useOnboarding();

	// Appearance (light / dark / system) — mounted here so the OS-preference
	// listener lives for the session; the Settings sheet drives it.
	const { theme, setTheme } = useTheme();

	// Lightbox CRT screen effect — Settings → Appearance. On (default):
	// retro monitor frame; off: plain full-screen viewer.
	const { crtEffect, setCrtEffect } = useCrtEffect();

	// Grid density (Auto or 2–5 photos per row) — the Settings sheet's Grid
	// section drives it; MasonryGrid applies it.
	const { gridColumns, setGridColumns } = useGridColumns();

	// Video search quality (Eco / Balanced / Detailed / Ultra / Ultra Pro) —
	// the Settings sheet's Video search section drives it; the main process
	// applies it to background scene analysis. costFacts feeds the cost line.
	const {
		videoQuality,
		setVideoQuality,
		reanalyzeVideos,
		suspectedTruncated,
		suspectedTruncatedFiles,
		refreshSuspectedTruncated,
		costFacts,
		refreshCostFacts,
	} = useVideoQuality();

	// Speech model (Tiny / Base / Small whisper) — the Settings sheet's
	// Video search section drives it; the main process applies it to
	// background transcription (switching re-transcribes every video).
	const { whisperModel, setWhisperModel } = useWhisperModel();

	// OCR text languages (English locked on + CJK toggles) — the Settings
	// sheet's Photo Search section drives it; the main process applies it to
	// background text extraction (switching re-OCRs every photo).
	const { ocrLangs, setOcrLangs, reocrPhotos } = useOcrLangs();

	// App icon (Dock + window) — Settings → Appearance → App Icon. Source
	// of truth is the main process (settings.json `appIcon`).
	const { appIcon, setAppIcon } = useAppIcon();

	// View shortcuts (Cmd+1–5 library views) — Settings → Keyboard drives
	// them; MasonryGrid reads the map for dispatch. localStorage-backed,
	// defaults reproduce today's hardcoded mapping.
	const { viewShortcuts, setViewShortcut, resetViewShortcuts } =
		useViewShortcuts();

	// Built-in tab visibility (Settings → Smart Tabs): Screenshots/Email
	// toggleable, All/Videos locked on. MasonryGrid filters the tab bar;
	// the Settings sheet drives the set.
	const { enabledTabs, setTabEnabled } = useEnabledTabs();

	// Manual Screenshots-tab decisions arrive keyed by content hash; resolve
	// one row's, tolerating missing hashes and hand-edited values.
	function overrideFor(
		hash: unknown,
		overrides: Record<string, unknown>,
	): CategoryOverride | null {
		if (typeof hash !== "string") return null;
		const value = overrides[hash];
		return value === "Screenshots" || value === "Projects" ? value : null;
	}

	const asString = (v: unknown): string | null =>
		typeof v === "string" ? v : null;

	const refreshLibrary = useCallback(async () => {
		try {
			const index = await fetch("/memories-index.json").then((r) => r.json());
			const filenames: string[] = Array.isArray(index.images)
				? index.images
				: [];
			const sourceMtimes: unknown[] = Array.isArray(index.sourceMtimes)
				? index.sourceMtimes
				: [];
			const sources: unknown[] = Array.isArray(index.sources)
				? index.sources
				: [];
			const hints: unknown[] = Array.isArray(index.screenshotHints)
				? index.screenshotHints
				: [];
			// OCR text per row (parallel to images). Email-tab membership is
			// derived from it at refresh time — same fetch, no main-process
			// round trip — so the tab fills in as the OCR tray completes.
			const ocrTexts: unknown[] = Array.isArray(index.ocr) ? index.ocr : [];
			const hashes: unknown[] = Array.isArray(index.hashes) ? index.hashes : [];
			const overrides: Record<string, unknown> =
				index.categoryOverrides && typeof index.categoryOverrides === "object"
					? index.categoryOverrides
					: {};
			const sourcePaths = sources.map(asString);
			const hintFlags = hints.map((h) => h === true);
			const emailMatches = ocrTexts.map((t) =>
				typeof t === "string" ? extractEmailMatches(t) : [],
			);
			setImages(
				filenames.map((filename, i) => ({
					id: filename,
					filename,
					// All videos land in the dedicated Videos tab regardless of
					// the classification; photos resolve through the tiered
					// screenshot signals (override > filename > metadata >
					// source folder).
					category: isVideoFile(filename)
						? "Videos"
						: getCategory({
								filename,
								sourcePath: sourcePaths[i],
								screenshotHint: hintFlags[i],
								override: overrideFor(hashes[i], overrides),
							}),
					modifiedAt:
						typeof sourceMtimes[i] === "number" &&
						Number.isFinite(sourceMtimes[i])
							? sourceMtimes[i]
							: null,
					sourcePath: sourcePaths[i],
					screenshotHint: hintFlags[i],
					hasEmail: (emailMatches[i]?.length ?? 0) > 0,
					emailAddresses: (emailMatches[i] ?? []).map((m) => m.address),
					emailMatches: emailMatches[i] ?? [],
				})),
			);
			setLibraryLoaded(true);
		} catch (err) {
			console.error("Failed to load library:", err);
		}
	}, []);

	// Manual Add to/Remove from Screenshots. Main persists the decision by
	// content hash and broadcasts "library-updated", which re-runs
	// refreshLibrary — the grid re-derives the category from the new index.
	const setCategoryOverride = useCallback(
		async (filename: string, category: CategoryOverride) => {
			try {
				const res = await window.memories.setCategoryOverride(
					filename,
					category,
				);
				if (res?.ok) return;
				setToast({
					message: res?.error || "Could not update the Screenshots category",
					duration: LONG_TOAST_MS,
					tone: "warning",
				});
			} catch {
				setToast({
					message: "Could not update the Screenshots category",
					duration: LONG_TOAST_MS,
					tone: "warning",
				});
			}
		},
		[],
	);

	// Mirror the AI engine's lifecycle (loading → ready/error) into the
	// search bar's status LED.
	const applyModelStatus = useCallback(
		(payload: Extract<StatusPayload, { type: "model" }>) => {
			setModelState(payload.phase === "loading" ? "loading" : payload.phase);
			setModelProgress(payload.progress ?? null);
			setModelFirstRun(payload.firstRun ?? false);
		},
		[],
	);

	// Initial library load + indexer status mirroring
	useEffect(() => {
		void refreshLibrary();
		return window.memories.onStatus((payload: StatusPayload) => {
			if (payload.type === "model") {
				applyModelStatus(payload);
			} else if (payload.type === "library-updated") {
				void refreshLibrary();
			} else if (payload.type === "import") {
				if (payload.phase === "done") {
					// Main broadcasts this at batch end for EVERY import —
					// including watched-folder syncs it started itself. Without
					// it, those auto-imports would leave the progress card stuck
					// on screen forever (only user-initiated paths cleared it).
					setImportProgress(null);
				} else {
					setImportProgress({
						phase: payload.phase,
						filename: payload.filename,
						done: payload.done ?? 0,
						total: payload.total ?? 0,
					});
				}
			} else if (payload.type === "heal") {
				// Startup self-repair of corrupted filename-phrase rows.
				setToast({
					message: healSummary(payload.healed, payload.attempted),
					duration: LONG_TOAST_MS,
					tone: "default",
				});
			} else if (payload.type === "shortcut-error") {
				setToast({
					message: `Global shortcut could not be restored: ${payload.error}`,
					duration: LONG_TOAST_MS,
					tone: "warning",
				});
			} else if (payload.type === "open-settings") {
				// Menu-bar tray "Open Settings…": the window is already
				// focused by main — just open the sheet.
				setSettingsOpen(true);
			}
		});
	}, [applyModelStatus, refreshLibrary]);

	// The AI engine can finish warming before this window mounted (warm model
	// cache); ask the main process for its current state so the LED is right
	// from the very first paint.
	useEffect(() => {
		void window.memories
			.getIndexerStatus()
			.then((status) => {
				if (status?.type === "model") applyModelStatus(status);
			})
			.catch(() => {
				/* bridge is optional */
			});
	}, [applyModelStatus]);

	// Keep the toast visible briefly (duration set per toast)
	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), toast.duration);
		return () => clearTimeout(t);
	}, [toast]);

	// Show the drag hint only while the cursor is over the Import button —
	// a pure CSS hover (group-hover on the wrapper), no timers to manage.
	const runImport = useCallback(async (paths: string[]) => {
		if (paths.length === 0) return;
		setImportProgress({
			phase: "indexing",
			filename: "",
			done: 0,
			total: paths.length,
		});
		let res: ImportResult | null = null;
		try {
			res = await window.memories.importPaths(paths);
		} catch (err: any) {
			setToast({
				message: `Import failed: ${err?.message ?? err}`,
				duration: LONG_TOAST_MS,
				tone: "error",
			});
		} finally {
			setImportProgress(null);
		}
		if (res) {
			const t = importResultToast(res);
			setToast({
				message: t.message,
				// Failure toasts (partial or total) stay up long enough to
				// actually be read — a refused batch now names its reason.
				duration:
					t.tone === "warning" || t.tone === "error" ? LONG_TOAST_MS : TOAST_MS,
				tone: t.tone,
			});
		}
	}, []);

	// Drag & drop (window-level; dropping a file would otherwise navigate
	// the app away — preventDefault in dragover+drop stops that).
	useEffect(() => {
		let depth = 0;

		const onDragEnter = (e: DragEvent) => {
			e.preventDefault();
			depth++;
			setDragging(true);
		};
		const onDragOver = (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		};
		const onDragLeave = (e: DragEvent) => {
			e.preventDefault();
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const onDrop = async (e: DragEvent) => {
			e.preventDefault();
			depth = 0;
			setDragging(false);
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			const paths = files
				.map((f) => {
					try {
						return window.memories.getPathForFile(f);
					} catch {
						return null;
					}
				})
				.filter((p): p is string => Boolean(p));
			await runImport(paths);
		};

		window.addEventListener("dragenter", onDragEnter);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("dragleave", onDragLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragenter", onDragEnter);
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("dragleave", onDragLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, [runImport]);

	const pickPhotos = useCallback(async () => {
		// Total is unknown until the picker returns; the per-file status
		// events carry the real counter once the batch starts.
		setImportProgress({ phase: "indexing", filename: "", done: 0, total: 0 });
		let res: ImportResult | null = null;
		try {
			res = await window.memories.pickPhotos();
		} catch (err: any) {
			setToast({
				message: `Import failed: ${err?.message ?? err}`,
				duration: LONG_TOAST_MS,
				tone: "warning",
			});
		} finally {
			setImportProgress(null);
		}
		if (res) {
			const t = importResultToast(res);
			setToast({
				message: t.message,
				// Failure toasts (partial or total) stay up long enough to
				// actually be read — a refused batch now names its reason.
				duration:
					t.tone === "warning" || t.tone === "error" ? LONG_TOAST_MS : TOAST_MS,
				tone: t.tone,
			});
		} else {
			setToast({
				message: "Import canceled",
				duration: TOAST_MS,
				tone: "default",
			});
		}
	}, []);

	// Keyboard shortcuts: Cmd+, opens Settings, Cmd+I imports photos.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.metaKey) return;
			if (e.key === ",") {
				e.preventDefault();
				setSettingsOpen((o) => !o);
			} else if (e.key === "i" && !e.shiftKey) {
				e.preventDefault();
				void pickPhotos();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [pickPhotos]);

	const gridImages = useMemo(() => images, [images]);

	return (
		<div className="mx-auto flex w-full max-w-full grow flex-col items-center pt-20 sm:pt-24 lg:max-w-6xl">
			{/* Settings control — pinned to the window corner. Importing and
			    watched-folder management live in Settings → Library. The
			    generous page padding above keeps the tabs and search row
			    well below the fixed pill instead of sliding underneath. */}
			<div className="fixed right-4 top-4 z-30 flex items-center gap-2 sm:right-6 sm:top-5">
				<button
					type="button"
					onClick={() => setSettingsOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={settingsOpen}
					title="Settings (⌘,)"
					className={`group flex items-center gap-1.5 rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-3 py-1 text-[11px] font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.25)] dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white ${
						settingsOpen
							? "ring-1 ring-inset ring-slate-400/50 dark:ring-slate-500/60"
							: ""
					}`}
				>
					<IconSettings
						size={12}
						className="shrink-0 text-zinc-500 transition-transform duration-200 group-hover:rotate-45 group-hover:scale-110 dark:text-zinc-400"
						aria-hidden="true"
					/>
					Settings
				</button>
			</div>

			{/* Empty state */}
			{libraryLoaded && images.length === 0 && !importProgress && (
				<div className="flex h-[50vh] w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-2xl border border-slate-400/50 bg-white/40 px-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-zinc-800 dark:bg-neutral-900/50 dark:shadow-none">
					<div className="flex h-16 w-16 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_3px_8px_rgba(15,23,42,0.18)] dark:border-slate-500/45 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)]">
						<IconPhotoPlus
							size={28}
							className="text-zinc-300"
							aria-hidden="true"
						/>
					</div>
					<div>
						<p className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
							No memories yet
						</p>
						<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
							Drop photos or folders into this window to AI-index them with CLIP
							— fully local, no uploads.
						</p>
					</div>
					<button
						type="button"
						onClick={() => void pickPhotos()}
						title="Import Photos (⌘I)"
						className="group flex items-center gap-2 rounded-full bg-gradient-to-b from-sky-500 to-sky-600 px-5 py-2 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(14,165,233,0.4)] transition-all hover:from-sky-400 hover:to-sky-600 active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.25)]"
					>
						<IconPhotoPlus
							size={16}
							className="shrink-0 transition-transform duration-200 group-hover:scale-110"
							aria-hidden="true"
						/>
						Import photos
						<kbd className="rounded border border-white/30 bg-white/15 px-1.5 py-px font-mono text-[10px] font-medium text-white">
							⌘I
						</kbd>
					</button>
				</div>
			)}

			{/* Grid */}
			{images.length > 0 && (
				<MasonryGrid
					initialImages={gridImages}
					modelState={modelState}
					modelProgress={modelProgress}
					modelFirstRun={modelFirstRun}
					gridColumns={gridColumns}
					viewShortcuts={viewShortcuts}
					enabledTabs={enabledTabs}
					crtEffect={crtEffect}
					onSetCategoryOverride={setCategoryOverride}
					onDeleteFailure={(filename) =>
						setToast({
							message: `Could not delete ${filename} — it is still in the library`,
							duration: LONG_TOAST_MS,
							tone: "warning",
						})
					}
				/>
			)}

			{/* AI import progress: “projector” card — spinning phosphor film
			    reel, phase + filename in phosphor mono, frame-cell film-gate
			    progress, film-counter numerals. */}
			{importProgress && (
				<div
					role="status"
					aria-live="polite"
					className="animate-slide-up fixed inset-x-0 bottom-6 z-[70] mx-auto w-[min(92vw,26rem)]"
				>
					<div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/95 via-[#08120c]/95 to-[#040a06]/95 px-4 py-3.5 shadow-[inset_0_0_22px_rgba(84,255,138,0.07),inset_0_1px_0_rgba(255,255,255,0.08),0_12px_32px_rgba(0,0,0,0.6)]">
						{/* Plastic grain over the projector body */}
						<div className="plastic-grain pointer-events-none absolute inset-0" />
						{/* Perforated film edge along the top */}
						<div className="sprocket-band pointer-events-none absolute inset-x-3 top-1.5" />

						<div className="relative flex items-center gap-3">
							{/* Spinning phosphor reel — the machine at work */}
							<div
								className="film-reel film-reel--sm film-reel--phosphor film-reel--spin-fast film-reel--static shrink-0"
								aria-hidden="true"
							>
								<div className="film-reel-ring">
									<span className="film-reel-rim" />
									<span className="film-reel-well" />
									<span className="film-reel-spokes" />
									<span className="film-reel-sprockets" />
									<span className="film-reel-hub">
										<span className="film-reel-hub-cap" />
									</span>
								</div>
							</div>

							<div className="min-w-0 flex-1">
								<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.16em]">
									{PHASE_LABELS[importProgress.phase]}
								</p>
								<p className="phosphor-dim truncate text-sm">
									{importProgress.filename
										? shortName(importProgress.filename)
										: "…"}
								</p>
							</div>
							<span className="phosphor-text shrink-0 font-mono text-sm tabular-nums">
								{importProgress.total > 0
									? `${Math.min(importProgress.done + 1, importProgress.total)}/${importProgress.total}`
									: ""}
							</span>
						</div>

						{importProgress.total > 0 && (
							<div className="relative mt-3 flex items-center gap-2.5">
								<FilmGate
									pct={((importProgress.done + 1) / importProgress.total) * 100}
									cells={28}
									className="h-2 flex-1"
								/>
								<span className="phosphor-dim shrink-0 font-mono text-[11px] tabular-nums">
									{Math.min(
										100,
										Math.round(
											((importProgress.done + 1) / importProgress.total) * 100,
										),
									)}
									%
								</span>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Settings sheet (Library + Appearance + Grid + Shortcuts) */}
			<SettingsSheet
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				theme={theme}
				onThemeChange={setTheme}
				crtEffect={crtEffect}
				onCrtEffectChange={setCrtEffect}
				appIcon={appIcon}
				onAppIconChange={setAppIcon}
				onReplayTour={replayOnboarding}
				gridColumns={gridColumns}
				onGridColumnsChange={setGridColumns}
				videoQuality={videoQuality}
				onVideoQualityChange={setVideoQuality}
				videoCostFacts={costFacts}
				onRefreshVideoCostFacts={refreshCostFacts}
				whisperModel={whisperModel}
				onWhisperModelChange={setWhisperModel}
				ocrLangs={ocrLangs}
				onOcrLangsChange={setOcrLangs}
				onReocrPhotos={reocrPhotos}
				onReanalyzeVideos={reanalyzeVideos}
				suspectedTruncated={suspectedTruncated}
				suspectedTruncatedFiles={suspectedTruncatedFiles}
				onRefreshSuspectedTruncated={refreshSuspectedTruncated}
				viewShortcuts={viewShortcuts}
				onViewShortcutChange={setViewShortcut}
				onResetViewShortcuts={resetViewShortcuts}
				enabledTabs={enabledTabs}
				onTabToggle={setTabEnabled}
				onImport={() => pickPhotos()}
				onNotify={(message, tone) =>
					setToast({
						message,
						duration: tone === "warning" ? LONG_TOAST_MS : TOAST_MS,
						tone,
					})
				}
			/>

			{/* Result toast (amber when a batch partially failed) */}
			{toast && (
				<div
					role="status"
					aria-live="polite"
					title={toast.message}
					className={`fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 max-w-[min(92vw,28rem)] truncate rounded-full border px-5 py-2.5 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_4px_12px_rgba(15,23,42,0.35)] backdrop-blur ${TOAST_TONE[toast.tone]}`}
				>
					{toast.message}
				</div>
			)}

			{/* First-run CRT onboarding (new users only) */}
			{showOnboarding && (
				<Onboarding
					onDone={dismissOnboarding}
					onImport={() => void pickPhotos()}
				/>
			)}

			{/* Drag overlay */}
			{dragging && <DropOverlay />}
		</div>
	);
}
