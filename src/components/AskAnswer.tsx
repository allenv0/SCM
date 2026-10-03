"use client";

import { useState } from "react";
import {
	IconAlertTriangle,
	IconChevronDown,
	IconChevronUp,
	IconLoader2,
	IconMessageQuestion,
	IconQuote,
	IconSettings,
	IconSquare,
	IconX,
} from "@tabler/icons-react";
import type { AskEvidenceRow, AskResult, AskStats } from "@/types";
import type { AskProgress } from "@/hooks/useAsk";

interface AskAnswerProps {
	/** The cleaned question (scope token stripped). */
	query: string;
	/** The in-flight / landed Ask result (null = first frame). */
	result: AskResult | null;
	asking: boolean;
	/** Token text streamed so far (null once the invoke resolves). */
	streamed: string | null;
	/** Evidence arriving ahead of the final result (chips go live early). */
	liveEvidence: AskEvidenceRow[] | null;
	/** Live process readout (retrieval numbers, cold-start, stream counters). */
	progress: AskProgress | null;
	/** Abort the in-flight generation (keeps the partial text). */
	onStop: () => void;
	/** Citation chip click → open the evidence row in the lightbox. */
	onSelectEvidence: (index: number) => void;
	/** Dismiss (X) — clears the result and the query. */
	onDismiss: () => void;
}

const KIND_LABEL: Record<AskEvidenceRow["kind"], string> = {
	dialogue: "Spoken",
	ocr: "On-screen text",
	keyword: "Filename",
};

// Process readout (MDs/Ask-Mode-Plan.md): one summary line always, phase
// breakdown behind a chevron. Live numbers elsewhere carry `~`; everything
// here is measured (retrieval) or from the sidecar's own timings — token
// parts render only when the build reported them.
function ProcessDetails({ stats }: { stats: AskStats }) {
	const [expanded, setExpanded] = useState(false);
	const matches = stats.dialogueHits + stats.ocrHits + stats.keywordHits;
	const summary: string[] = [];
	if (typeof stats.predictedTokens === "number") {
		summary.push(`${stats.predictedTokens} tokens`);
	}
	if (typeof stats.elapsedMs === "number") {
		summary.push(`${(stats.elapsedMs / 1000).toFixed(1)}s`);
	}
	if (typeof stats.promptTokens === "number") {
		summary.push(
			`prompt ${stats.promptTokens.toLocaleString()}` +
				(typeof stats.ctxTokens === "number"
					? `/${stats.ctxTokens.toLocaleString()}`
					: ""),
		);
	}
	summary.push(`${stats.filesScanned} files`);
	const engine: string[] = [];
	if (stats.modelLabel) engine.push(stats.modelLabel);
	if (typeof stats.sizeBytes === "number") {
		engine.push(`${(stats.sizeBytes / 1e9).toFixed(1)}GB`);
	}
	if (typeof stats.coldStart === "boolean") {
		engine.push(stats.coldStart ? "cold start" : "warm (resident)");
	}
	if (typeof stats.ctxTokens === "number") {
		engine.push(`ctx ${stats.ctxTokens.toLocaleString()}`);
	}
	if (stats.accelerator) engine.push(stats.accelerator);
	if (typeof stats.threads === "number") {
		engine.push(`${stats.threads} threads`);
	}
	const generation: string[] = [];
	if (typeof stats.promptTokens === "number") {
		generation.push(`prompt ${stats.promptTokens.toLocaleString()} tok`);
	}
	if (typeof stats.predictedTokens === "number") {
		generation.push(
			`${stats.predictedTokens} out` +
				(typeof stats.tokensPerSec === "number"
					? ` @ ${stats.tokensPerSec} tok/s`
					: ""),
		);
	}
	if (typeof stats.elapsedMs === "number") {
		generation.push(`${(stats.elapsedMs / 1000).toFixed(1)}s`);
	}
	return (
		<div className="mt-2 font-mono text-[10px] leading-relaxed text-zinc-500">
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-label={
						expanded ? "Hide process details" : "Show process details"
					}
					aria-expanded={expanded}
					className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
				>
					{expanded ? (
						<IconChevronUp size={11} aria-hidden="true" />
					) : (
						<IconChevronDown size={11} aria-hidden="true" />
					)}
				</button>
				<span>{summary.join(" · ")}</span>
			</div>
			{expanded && (
				<div className="mt-1 space-y-0.5 pl-5">
					<p>
						retrieval — {stats.filesScanned} files → {matches} matches (
						{stats.dialogueHits} spoken · {stats.ocrHits} on-screen ·{" "}
						{stats.keywordHits} filename) · {stats.tier} tier ·{" "}
						{stats.retrievalMs}ms
					</p>
					{engine.length > 0 && <p>engine — {engine.join(" · ")}</p>}
					{generation.length > 0 && (
						<p>generation — {generation.join(" · ")}</p>
					)}
				</div>
			)}
		</div>
	);
}

// The Ask answer card (MDs/Ask-Mode-Plan.md): sits above the grid in Ask
// mode, mirroring the phosphor-LCD language of the import progress card.
// The evidence grid below renders the same rows in citation order — a chip
// click opens that row in the lightbox, so every claim is one click from
// its source.
export default function AskAnswer({
	query,
	result,
	asking,
	streamed,
	liveEvidence,
	progress,
	onStop,
	onSelectEvidence,
	onDismiss,
}: AskAnswerProps) {
	const evidence = result?.evidence ?? liveEvidence ?? [];
	const streaming = asking && streamed !== null && streamed.length > 0;
	const liveLine = (() => {
		if (!asking) return null;
		if (streaming) {
			// The hook throttles this label (~4Hz) so tok/s never jitters.
			return progress?.liveLabel ?? "Answering…";
		}
		if (progress?.spawning) {
			return `Starting ${progress.modelLabel ?? "local engine"}…`;
		}
		const stats = progress?.stats;
		if (stats) {
			const matches = stats.dialogueHits + stats.ocrHits + stats.keywordHits;
			return `${stats.filesScanned} files → ${matches} matches · ${stats.tier} · ${stats.retrievalMs}ms`;
		}
		return "Reading your library…";
	})();
	const body = (() => {
		if (asking) {
			return (
				<div>
					{streaming ? (
						<p className="text-sm leading-relaxed text-zinc-200">{streamed}</p>
					) : null}
					<div className="mt-1.5 flex items-center gap-2 text-sm text-zinc-400">
						<IconLoader2
							size={15}
							className="animate-spin"
							aria-hidden="true"
						/>
						{/* Staged progress: evidence → (cold-start) → tokens, so
						    the label never claims "reading" while generating. */}
						<span>{liveLine ?? "Reading your library…"}</span>
						<button
							type="button"
							onClick={onStop}
							aria-label="Stop generating"
							className="ml-1 flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/15 hover:text-white"
						>
							<IconSquare size={9} aria-hidden="true" />
							Stop
						</button>
					</div>
				</div>
			);
		}
		if (!result) return null;
		if (result.ok && result.answer) {
			return (
				<p className="text-sm leading-relaxed text-zinc-200">{result.answer}</p>
			);
		}
		if (result.ok) {
			return (
				<p className="text-sm leading-relaxed text-zinc-400">
					No matching text or dialogue found for this question
					{evidence.length > 0
						? " — the closest hits are below."
						: " in this scope."}
				</p>
			);
		}
		if (result.reason === "not-installed") {
			return (
				<p className="flex items-start gap-2 text-sm leading-relaxed text-amber-300">
					<IconSettings
						size={15}
						className="mt-0.5 shrink-0"
						aria-hidden="true"
					/>
					<span>
						LLMs need the local AI model (a one-time ~1.1GB download) — set it
						up in Settings → LLMs Chat.
					</span>
				</p>
			);
		}
		if (result.reason === "disabled") {
			return (
				<p className="text-sm leading-relaxed text-amber-300">
					LLMs are off — enable them in Settings → LLMs Chat.
				</p>
			);
		}
		if (result.reason === "stopped") {
			return (
				<div className="text-sm leading-relaxed">
					{result.partial ? (
						<p className="text-zinc-200">{result.partial}</p>
					) : null}
					<p className="mt-1.5 text-zinc-400">
						Stopped — showing what arrived.
					</p>
				</div>
			);
		}
		return (
			<p className="flex items-start gap-2 text-sm leading-relaxed text-rose-300">
				<IconAlertTriangle
					size={15}
					className="mt-0.5 shrink-0"
					aria-hidden="true"
				/>
				<span>{result.error || "LLMs failed — try again."}</span>
			</p>
		);
	})();

	return (
		<div
			role="status"
			aria-live="polite"
			className="animate-slide-up relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/95 via-[#08120c]/95 to-[#040a06]/95 px-4 py-3.5 shadow-[inset_0_0_22px_rgba(84,255,138,0.07),inset_0_1px_0_rgba(255,255,255,0.08),0_12px_32px_rgba(0,0,0,0.6)]"
		>
			<div className="plastic-grain pointer-events-none absolute inset-0" />
			<div className="sprocket-band pointer-events-none absolute inset-x-3 top-1.5" />

			<div className="relative flex items-start gap-3">
				<IconMessageQuestion
					size={16}
					className="mt-0.5 shrink-0 text-[var(--ai-ready)]"
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.16em]">
						LLMs
					</p>
					<p className="phosphor-dim mt-0.5 truncate text-[13px]">{query}</p>
					{body && <div className="mt-2">{body}</div>}
					{!asking && evidence.length > 0 && (
						<div className="mt-2.5 flex flex-wrap gap-1.5">
							{evidence.map((row, i) => (
								<button
									key={`${row.filename}:${i}`}
									type="button"
									onClick={() => onSelectEvidence(i)}
									title={`${KIND_LABEL[row.kind]} — ${row.filename}${row.tierLabel ? ` (${row.tierLabel})` : ""}`}
									className="flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-300 transition-colors hover:bg-white/15 hover:text-white"
								>
									<IconQuote size={10} aria-hidden="true" />[{i + 1}]
									<span className="max-w-36 truncate">{row.filename}</span>
								</button>
							))}
						</div>
					)}
					{!asking && result?.stats && <ProcessDetails stats={result.stats} />}
				</div>
				<button
					type="button"
					onClick={onDismiss}
					aria-label="Dismiss answer"
					className="shrink-0 rounded-full bg-white/5 p-1 text-zinc-400 transition-colors hover:bg-white/15 hover:text-white"
				>
					<IconX size={14} aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
