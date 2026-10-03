"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	IconChevronDown,
	IconCheck,
	IconDownload,
	IconCloudDownload,
	IconX,
} from "@tabler/icons-react";
import FilmGate from "./FilmGate";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";
import type { ModelInfo, MigratePhase } from "@/types";

interface MigrationProgress {
	phase: MigratePhase;
	done: number;
	total: number;
	modelId: string;
}

interface ModelPreloadState {
	phase: "loading" | "ready" | "error";
	progress: number | null;
}

interface ModelPickerProps {
	models: ModelInfo[] | null;
	activeModelId: string | null;
	migration: MigrationProgress | null;
	/** True while the engine is downloading weights — switching is refused. */
	engineBusy: boolean;
	/** Per-model background weight downloads (modelId → progress). */
	modelPreloads: Record<string, ModelPreloadState>;
	onSetModel: (modelId: string) => Promise<unknown>;
	onPreloadModel: (modelId: string) => Promise<unknown>;
	onPreloadAll: () => Promise<unknown>;
}

// The model sheet: the search-model picker under the search bar, dressed in
// the Settings design system (MDs/Settings-Design-System.md) — platinum
// plastic shell, system type, sky radio-row selection, title bar + status
// bar. The STATE LED hues (ready/busy) stay: they are functional engine
// status, not decoration.
export default function ModelPicker({
	models,
	activeModelId,
	migration,
	engineBusy,
	modelPreloads,
	onSetModel,
	onPreloadModel,
	onPreloadAll,
}: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

	const openPicker = () => {
		const idx = models?.findIndex((m) => m.id === activeModelId) ?? -1;
		setActiveIndex(idx >= 0 ? idx : 0);
		setOpen(true);
	};

	// Focus the roving option when the list opens (and after activeIndex moves).
	useEffect(() => {
		if (!open) return;
		const id = requestAnimationFrame(() => {
			optionRefs.current[activeIndex]?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [open, activeIndex]);

	// Escape closes the sheet and restores focus to the trigger chip.
	const closePicker = useCallback((restoreFocus = true) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				closePicker(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, closePicker]);

	if (migration) {
		return <MigrationPill models={models ?? []} progress={migration} />;
	}
	if (!models || models.length === 0) return null;

	const active = models.find((m) => m.id === activeModelId) ?? models[0];
	const disabled = engineBusy;
	const downloadedCount = models.filter((m) => m.downloaded).length;

	const selectModel = (m: ModelInfo, isActive: boolean) => {
		closePicker(true);
		if (!isActive) void onSetModel(m.id);
	};

	return (
		<div className="relative [font-family:-apple-system,BlinkMacSystemFont,'SF_Pro_Text','SF_Pro_Display','Helvetica_Neue',Helvetica,Arial,sans-serif]">
			<button
				type="button"
				ref={triggerRef}
				onClick={openPicker}
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				title={`AI model: ${active.label}. ${active.description}`}
				className={`flex items-center gap-1.5 rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-3 py-1 font-sans text-[11px] font-semibold text-zinc-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-700 active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.25)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-400 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-zinc-200 ${
					open
						? "ring-1 ring-inset ring-slate-400/50 dark:ring-slate-500/60"
						: ""
				}`}
			>
				<span
					className={`h-1.5 w-1.5 shrink-0 rounded-full ${
						engineBusy
							? "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_5px_rgba(var(--ai-busy-rgb),0.9)]"
							: "bg-[var(--ai-ready)] shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]"
					}`}
					aria-hidden="true"
				/>
				<span>{active.label}</span>
				<IconChevronDown
					size={12}
					className={`shrink-0 text-zinc-500 transition-transform duration-200 dark:text-zinc-400 ${
						open ? "rotate-180" : ""
					}`}
					aria-hidden="true"
				/>
			</button>

			{open && (
				<>
					{/* Click-outside capture */}
					<button
						type="button"
						tabIndex={-1}
						aria-hidden="true"
						className="fixed inset-0 z-40 cursor-default"
						onClick={() => closePicker(false)}
					/>
					<div
						role="listbox"
						aria-label="AI model"
						onKeyDown={(e) => {
							const count = models.length;
							if (!count) return;
							const move = (next: number) => {
								e.preventDefault();
								setActiveIndex(next);
							};
							if (e.key === "ArrowDown") {
								move((activeIndex + 1) % count);
							} else if (e.key === "ArrowUp") {
								move((activeIndex - 1 + count) % count);
							} else if (e.key === "Home") {
								move(0);
							} else if (e.key === "End") {
								move(count - 1);
							}
						}}
						className="absolute right-0 top-full z-50 mt-2 w-[min(36rem,calc(100vw-2rem))] origin-top-right animate-scale-in overflow-hidden rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d9e0e9] to-[#aeb9c6] shadow-[0_18px_50px_rgba(15,23,42,0.35),inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_18px_50px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.1)]"
					>
						{/* Plastic grain + shell highlight (Settings §3.2) */}
						<div className="plastic-grain pointer-events-none absolute inset-0" />
						<div className="pointer-events-none absolute inset-x-10 top-0.5 h-4 rounded-full bg-white/50 blur-md dark:bg-white/10" />
						{/* Title bar (Settings §3.4) */}
						<div className="relative flex items-start justify-between gap-4 border-b border-slate-500/30 px-5 pb-3.5 pt-4 dark:border-slate-600/40">
							<div className="min-w-0">
								<p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
									AI Model
								</p>
								<p className="mt-1 truncate text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
									Search model
								</p>
								<p className="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
									Best video scene search first. Faster-import and high-detail
									alternatives follow. OCR reads visible text separately.
								</p>
							</div>
							<button
								type="button"
								onClick={() => closePicker(true)}
								aria-label="Close model picker"
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-500/30 bg-white/40 text-zinc-500 transition-colors hover:bg-white/80 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
							>
								<IconX size={16} aria-hidden="true" />
							</button>
						</div>
						{/* Body — one radio row per model (Settings §6.1) */}
						<div className="scrollbar-hide relative max-h-[min(64vh,36rem)] space-y-2 overflow-y-auto px-3 py-3">
							{models.map((m, optionIndex) => {
								const isActive = m.id === active.id;
								const preload = modelPreloads[m.id];
								const downloading = preload?.phase === "loading";
								const downloadFailed = preload?.phase === "error";
								const preloadPct =
									preload?.progress != null
										? Math.min(100, Math.round(preload.progress))
										: 0;
								return (
									<div
										key={m.id}
										ref={(el) => {
											optionRefs.current[optionIndex] = el;
										}}
										role="option"
										// Roving tabindex: exactly one option is in the tab order.
										tabIndex={optionIndex === activeIndex ? 0 : -1}
										aria-selected={isActive}
										aria-label={`${m.label}${isActive ? " — active" : ""}`}
										onFocus={() => setActiveIndex(optionIndex)}
										onClick={() => selectModel(m, isActive)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												selectModel(m, isActive);
											}
										}}
										className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
											isActive ? SELECTED_ROW : IDLE_ROW
										}`}
									>
										<span
											className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
												isActive
													? "border-sky-500 bg-sky-500 text-white"
													: "border-zinc-400 text-transparent dark:border-zinc-500"
											}`}
											aria-hidden="true"
										>
											<IconCheck size={12} stroke={3} aria-hidden="true" />
										</span>
										<span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
											{m.label}
										</span>
										{isActive ? (
											<span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
												Active
											</span>
										) : downloading ? (
											<span
												className="shrink-0 font-mono text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-300"
												role="status"
												aria-live="polite"
											>
												{preloadPct}%
											</span>
										) : (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													void onPreloadModel(m.id).catch(() => undefined);
												}}
												title={
													downloadFailed
														? "Download failed — try again"
														: m.downloaded
															? "Downloaded"
															: "Download weights"
												}
												className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
											>
												{m.downloaded && !downloadFailed ? (
													<IconCheck size={12} stroke={3} aria-hidden="true" />
												) : (
													<IconDownload size={13} aria-hidden="true" />
												)}
											</button>
										)}
									</div>
								);
							})}
						</div>
						{/* Status bar (Settings §3.6): live context left, pre-fetch action right. */}
						<div className="relative flex items-center justify-between gap-3 border-t border-slate-500/30 px-5 py-3 dark:border-slate-600/40">
							<p className="truncate font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
								{downloadedCount === models.length
									? "All models downloaded"
									: `${downloadedCount} of ${models.length} downloaded`}
							</p>
							{models.some((m) => !m.downloaded) && (
								<button
									type="button"
									onClick={() => void onPreloadAll()}
									disabled={engineBusy}
									className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold text-sky-700 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300 dark:hover:bg-sky-500/15"
								>
									<IconCloudDownload size={15} aria-hidden="true" />
									Download all
								</button>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

// Replaces the picker chip while a model switch re-embeds the library:
// status LED, target name, progress track. The library-updated broadcast
// at the end of the switch clears it. Kept in the dark projector treatment
// like the import progress card: in-flight work reads as hardware, and the
// FilmGate cells are tuned for a dark track.
function MigrationPill({
	models,
	progress,
}: {
	models: ModelInfo[];
	progress: MigrationProgress;
}) {
	const target = models.find((m) => m.id === progress.modelId);
	const pct =
		progress.total > 0
			? Math.min(100, Math.round((progress.done / progress.total) * 100))
			: 0;

	return (
		<div
			role="status"
			aria-live="polite"
			className="flex w-full max-w-[56rem] items-center gap-3.5 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-5 py-3 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.5)] [font-family:-apple-system,BlinkMacSystemFont,'SF_Pro_Text','SF_Pro_Display','Helvetica_Neue',Helvetica,Arial,sans-serif]"
		>
			<span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]" />
			<div className="min-w-0 flex-1">
				<p className="phosphor-text text-xs font-semibold uppercase tracking-[0.14em]">
					Switching to {target?.label ?? progress.modelId}
				</p>
				<div className="mt-2 h-2">
					<FilmGate pct={pct} cells={20} className="h-full" />
				</div>
			</div>
			<span className="phosphor-text shrink-0 font-mono text-[13px] tabular-nums">
				{pct}%
			</span>
		</div>
	);
}
