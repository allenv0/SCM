"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPhotoPlus, IconSettings } from "@tabler/icons-react";
import FilmGate from "@/components/FilmGate";
import MasonryGrid from "@/components/MasonryGrid";
import DropOverlay from "@/components/DropOverlay";
import SettingsSheet from "@/components/SettingsSheet";
import Onboarding from "@/onboarding/Onboarding";
import { useOnboarding } from "@/onboarding/useOnboarding";
import { usePrefsStore } from "@/stores/usePrefsStore";
import { useLibraryStore, type ToastTone } from "@/stores/useLibraryStore";
import type { CategoryOverride } from "@/lib/categories";
import { shortName, importResultToast } from "@/lib/importToast";
import { matchAccelerator } from "@/lib/viewShortcuts";
import type {
	ImportPhase,
	ImportResult,
	ModelPhase,
	StatusPayload,
} from "@/types";

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
	// Library + prefs live in zustand stores (see src/stores/); App keeps
	// only session/UI state (drag, progress, toast, model, sheet).
	const images = useLibraryStore((s) => s.images);
	const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
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

	// Prefs (appearance, grid, video/whisper/OCR, icon, shortcuts, tabs)
	// live in the prefs store; the Settings sheet + grid read them via
	// selectors (prop drilling narrows in Phase 4b).
	const crtEffect = usePrefsStore((s) => s.crtEffect);
	const gridColumns = usePrefsStore((s) => s.gridColumns);
	const shortcuts = usePrefsStore((s) => s.shortcuts);
	const enabledTabs = usePrefsStore((s) => s.enabledTabs);
	const refreshLibrary = useLibraryStore((s) => s.refreshLibrary);
	const storeSetCategoryOverride = useLibraryStore(
		(s) => s.setCategoryOverride,
	);

	// Manual Add to/Remove from Screenshots (grid callback): the store owns
	// the bridge call; App owns the failure toast.
	const setCategoryOverride = useCallback(
		async (filename: string, category: CategoryOverride) => {
			await storeSetCategoryOverride(filename, category, (message) =>
				setToast({ message, duration: LONG_TOAST_MS, tone: "warning" }),
			);
		},
		[storeSetCategoryOverride],
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

	// Initial library load + indexer status mirroring. Prefs bootstrap
	// (bridge reads + OS-preference listener) runs first so the sheet
	// never flashes defaults; it is idempotent under double-mount.
	useEffect(() => {
		usePrefsStore.getState().initializePrefs();
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
			} else if (payload.type === "prune-aborted") {
				// A mass-missing library is almost always an unmounted volume
				// or a half-restored backup. The main process refuses to prune;
				// say so instead of leaving the user with a silently empty grid.
				setToast({
					message: `Library cleanup paused: ${payload.missing} of ${payload.total} files are missing. Nothing was deleted.`,
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

	// Keyboard shortcuts: Settings toggle + Import photos (Settings →
	// Keyboard; recordable, default ⌘, / ⌘I). The shared matcher handles
	// Caps Lock and IME correctly, and while the viewer is open its
	// dispatcher consumes its own combos first (stopPropagation), so ⌘I
	// toggles AI Insights there instead of double-firing this import.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const settingsAccel = shortcuts["toggle-settings"];
			if (settingsAccel && matchAccelerator(e, settingsAccel)) {
				e.preventDefault();
				setSettingsOpen((o) => !o);
				return;
			}
			const importAccel = shortcuts["import-photos"];
			if (importAccel && matchAccelerator(e, importAccel)) {
				e.preventDefault();
				void pickPhotos();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [shortcuts, pickPhotos]);

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
					shortcuts={shortcuts}
					enabledTabs={enabledTabs}
					crtEffect={crtEffect}
					onSetCategoryOverride={setCategoryOverride}
					onDeleteFailure={(filename, reason) =>
						setToast({
							message: reason
								? `Could not delete ${filename} — ${reason}`
								: `Could not delete ${filename} — it is still in the library`,
							duration: LONG_TOAST_MS,
							tone: "warning",
						})
					}
					onModelFailure={(message) =>
						setToast({
							message: `Could not switch model — ${message}`,
							duration: LONG_TOAST_MS,
							tone: "error",
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
				onReplayTour={replayOnboarding}
				onOpenYoutubeInterest={() => setSettingsOpen(false)}
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
