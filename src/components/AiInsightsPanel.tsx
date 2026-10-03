"use client";

import { useEffect, useState } from "react";
import { IconBrain, IconLoader, IconTextScan2 } from "@tabler/icons-react";
import type { AiInsights } from "@/types";

interface AiInsightsPanelProps {
	/** The filename of the currently viewed photo. */
	filename: string;
	/** Whether the panel is visible. */
	open: boolean;
}

// A score bar that visualizes how strongly the image matches a concept.
// The bar fills from left; the hue goes from cool (low) to warm (high).
function ScoreBar({ score }: { score: number }) {
	const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
	return (
		<div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
			<div
				className="h-full rounded-full transition-all duration-500"
				style={{
					width: `${pct}%`,
					background:
						pct > 70
							? "var(--ai-ready, #10b981)"
							: pct > 40
								? "#f59e0b"
								: "#64748b",
				}}
			/>
		</div>
	);
}

// The "AI Insights" panel: a slide-in sidebar inside the lightbox that
// reveals what the AI "sees" in the current photo — filename keywords,
// OCR text, visual concept matches, and the model that processed it.
export default function AiInsightsPanel({
	filename,
	open,
}: AiInsightsPanelProps) {
	const [data, setData] = useState<AiInsights | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setData(null);
		void window.memories.getAiInsights(filename).then((result) => {
			// Stale-response guard: switching photos quickly under the
			// lightbox must not let an earlier resolve overwrite a later one.
			if (cancelled) return;
			setData(result);
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [filename, open]);

	if (!open) return null;

	return (
		<div
			className="animate-slide-in-right absolute right-0 top-0 z-30 flex h-full w-72 flex-col border-l border-white/10 bg-gradient-to-b from-[#0e1418]/95 via-[#0b1215]/95 to-[#080d10]/95 backdrop-blur-xl dark:border-white/10 sm:w-80"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header */}
			<div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
				<IconBrain
					size={16}
					className="text-[var(--ai-ready, #10b981)]"
					aria-hidden="true"
				/>
				<p className="phosphor-text text-[11px] font-semibold uppercase tracking-wider">
					AI Insights
				</p>
			</div>

			{/* Body */}
			<div className="scrollbar-hide flex-1 overflow-y-auto px-4 py-3">
				{loading ? (
					<div className="flex items-center gap-2 py-6 text-center">
						<IconLoader
							size={16}
							className="animate-spin text-zinc-400"
							aria-hidden="true"
						/>
						<p className="text-[11px] text-zinc-400">Analyzing…</p>
					</div>
				) : !data ? (
					<p className="py-6 text-center text-[11px] text-zinc-500">
						No insights available for this image.
					</p>
				) : (
					<div className="space-y-4">
						{/* Model info */}
						<div>
							<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
								Processed by
							</p>
							<p className="mt-1 font-mono text-[11px] text-zinc-300">
								{data.modelName}
							</p>
						</div>

						{/* Filename keywords */}
						{data.keywords.length > 0 && (
							<div>
								<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
									Keywords
								</p>
								<div className="mt-1.5 flex flex-wrap gap-1">
									{data.keywords.map((kw) => (
										<span
											key={kw}
											className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
										>
											{kw}
										</span>
									))}
								</div>
							</div>
						)}

						{/* OCR text */}
						{data.ocrText && (
							<div>
								<div className="flex items-center gap-1.5">
									<IconTextScan2
										size={13}
										className="text-zinc-400"
										aria-hidden="true"
									/>
									<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
										Visible text
									</p>
								</div>
								<p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
									{data.ocrText}
								</p>
							</div>
						)}

						{/* Visual concepts */}
						{data.concepts.length > 0 && (
							<div>
								<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
									Visual concepts
								</p>
								<div className="mt-2 space-y-2">
									{data.concepts.map((c) => (
										<div key={c.query}>
											<div className="flex items-center justify-between gap-2">
												<p className="truncate text-[11px] text-zinc-300">
													{c.query}
												</p>
												<span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
													{Math.round(c.score * 100)}%
												</span>
											</div>
											<ScoreBar score={c.score} />
										</div>
									))}
								</div>
							</div>
						)}

						{data.concepts.length === 0 &&
							data.keywords.length === 0 &&
							!data.ocrText && (
								<p className="py-4 text-center text-[11px] text-zinc-500">
									No AI data found for this image yet.
								</p>
							)}
					</div>
				)}
			</div>

			{/* Hint */}
			<div className="border-t border-white/10 px-4 py-2">
				<p className="text-center text-[10px] text-zinc-500">
					Press ⌘I to hide
				</p>
			</div>
		</div>
	);
}
