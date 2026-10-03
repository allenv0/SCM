"use client";

import { IconSearch, IconX, IconPin } from "@tabler/icons-react";
import FilmGate from "@/components/FilmGate";
import type { ModelPhase } from "@/types";

interface MemorySearchProps {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	placeholder?: string;
	onPrewarm?: () => void;
	// Save-the-search-as-a-tab: the pill shows while a query is typed and
	// not already saved, and calls onSaveSearch when clicked.
	onSaveSearch?: () => void;
	savedSearch?: boolean;
	// AI engine lifecycle mirrored from the main process (App owns the
	// authoritative state; the corner LED + progress row render it here).
	modelState?: ModelPhase | "idle";
	modelProgress?: number | null;
	modelFirstRun?: boolean;
}

// Per-state AI status look: a physical front-panel LED + tiny mono label in
// the search bezel. Hue carries the STATE semantics (green ready / amber
// busy / red error / gray standby) — the same language as the ModelPicker
// chip. Only the busy LED blinks, like a hard-disk activity light.
const STATUS_STYLE: Record<
	ModelPhase | "idle",
	{ dot: string; label: string }
> = {
	ready: {
		dot: "bg-[var(--ai-ready)] shadow-[0_0_6px_rgba(var(--ai-ready-rgb),0.8)]",
		label: "AI ready",
	},
	loading: {
		dot: "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]",
		label: "AI warm-up",
	},
	error: {
		dot: "bg-[var(--ai-error)] shadow-[0_0_6px_rgba(var(--ai-error-rgb),0.8)]",
		label: "AI offline",
	},
	idle: {
		dot: "bg-[var(--ai-idle)] shadow-[0_0_4px_rgba(var(--ai-idle-rgb),0.5)]",
		label: "AI standby",
	},
};

export default function MemorySearch({
	value,
	onChange,
	disabled = false,
	placeholder = "Describe a memory…",
	onPrewarm,
	onSaveSearch,
	savedSearch = false,
	modelState = "idle",
	modelProgress = null,
	modelFirstRun = false,
}: MemorySearchProps) {
	const isDownloading = modelState === "loading";

	const statusLabel =
		modelState === "ready"
			? "AI ready — semantic search enabled"
			: modelState === "loading"
				? modelProgress != null
					? `Downloading AI model… ${Math.round(modelProgress)}%`
					: "Preparing AI engine…"
				: modelState === "error"
					? "AI offline — keyword search only"
					: "AI engine standby — keyword search only";

	const statusStyle = STATUS_STYLE[modelState];

	return (
		<div className="w-full max-w-[56rem] shrink-0">
			<div className="relative rounded-3xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_12px_28px_rgba(15,23,42,0.22),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-6px_12px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_16px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-6px_14px_rgba(0,0,0,0.5)]">
				<div className="plastic-grain pointer-events-none absolute inset-0 rounded-3xl" />
				<div className="pointer-events-none absolute inset-x-6 top-2 h-6 rounded-full bg-white/50 blur-md dark:bg-white/10" />
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-3xl bg-gradient-to-t from-black/15 to-transparent" />

				{/* Inner bezel */}
				<div className="relative flex items-center gap-3 rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] px-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
					<IconSearch
						size={20}
						className="shrink-0 text-zinc-500 dark:text-zinc-400"
						aria-hidden="true"
					/>
					<input
						type="search"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onFocus={() => onPrewarm?.()}
						disabled={disabled}
						placeholder={placeholder}
						aria-label="Search memories"
						className="min-w-0 flex-1 bg-transparent py-2.5 text-base text-zinc-700 outline-none placeholder:text-zinc-500 dark:text-zinc-200 dark:placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
					/>
					{/* Front-panel status LED + label */}
					<span
						role="status"
						title={statusLabel}
						className="flex shrink-0 items-center gap-1.5 pl-1"
					>
						<span className={`h-2 w-2 rounded-full ${statusStyle.dot}`} />
						<span className="hidden font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 sm:inline dark:text-zinc-400">
							{statusStyle.label}
						</span>
						<span className="sr-only">{statusLabel}</span>
					</span>
					{value.trim() && onSaveSearch && !savedSearch && (
						<button
							onClick={onSaveSearch}
							disabled={disabled}
							aria-label="Save this search as a tab"
							title="Save as a tab"
							className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-3 text-xs font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.25)] dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white"
						>
							<IconPin size={14} className="shrink-0" aria-hidden="true" />
							<span className="hidden sm:inline">Save as tab</span>
						</button>
					)}
					{value && (
						<button
							onClick={() => onChange("")}
							disabled={disabled}
							aria-label="Clear search"
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200/70 text-zinc-600 transition-colors hover:bg-zinc-300 dark:bg-zinc-700/70 dark:text-zinc-300 dark:hover:bg-zinc-600"
						>
							<IconX size={18} aria-hidden="true" />
						</button>
					)}
				</div>

				{/* Model warm-up — a small phosphor LCD window set into the
				    plastic shell: amber LED, mono label, film-gate progress. */}
				{isDownloading && (
					<div
						role="status"
						aria-live="polite"
						className="relative flex flex-col gap-2.5 px-4 pb-4 pt-3"
					>
						<div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-4 py-2.5 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_12px_rgba(0,0,0,0.4)]">
							<span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]" />
							<div className="min-w-0 flex-1">
								<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.14em]">
									{modelProgress != null
										? "Downloading AI model"
										: "Preparing AI engine"}
								</p>
								{modelFirstRun && modelProgress != null && (
									<p className="phosphor-dim mt-0.5 text-[11px] leading-tight">
										First run downloads the CLIP model (~435MB) — one-time,
										fully local &amp; offline
									</p>
								)}
							</div>
							{modelProgress != null && (
								<>
									<FilmGate
										pct={modelProgress}
										cells={16}
										className="h-2 w-28 shrink-0 sm:w-40"
									/>
									<span className="phosphor-text shrink-0 font-mono text-[11px] tabular-nums">
										{Math.round(modelProgress)}%
									</span>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
