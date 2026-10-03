"use client";

import type { ScoreBreakdown } from "@/lib/memoryRank";
import {
	MATCH_SIGNALS,
	orderedBreakdownRows,
	type MatchDominant,
} from "@/lib/matchTone";

interface ScoreBreakdownTooltipProps {
	breakdown: ScoreBreakdown;
	// The winning signal — tints the tooltip's left accent and floats its
	// row to the top. Absent (non-search context) falls back to a neutral
	// accent with plain component order.
	dominant?: MatchDominant | null;
}

export default function ScoreBreakdownTooltip({
	breakdown,
	dominant,
}: ScoreBreakdownTooltipProps) {
	const total =
		breakdown.semantic + breakdown.phrase + breakdown.filename + breakdown.ocr;
	const rows = orderedBreakdownRows(breakdown, dominant);
	const accent = dominant
		? MATCH_SIGNALS[dominant].accent
		: "border-l-zinc-500";

	return (
		<div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 opacity-0 transition-opacity duration-150 group-hover/tooltip:opacity-100">
			<div
				className={`w-max min-w-24 rounded-lg border border-l-[3px] border-white/10 ${accent} bg-black/85 px-2.5 py-1.5 text-[9px] leading-snug shadow-lg backdrop-blur-md`}
			>
				{rows.map((key, i) => {
					const signal = MATCH_SIGNALS[key];
					const isDominant = i === 0 && dominant === key;
					return (
						<div
							key={key}
							className={`flex items-center justify-between gap-2 ${
								isDominant ? "font-semibold text-zinc-200" : "text-zinc-500"
							}`}
						>
							<span>{signal.label}</span>
							<span className={`font-mono tabular-nums ${signal.row}`}>
								{breakdown[key].toFixed(3)}
							</span>
						</div>
					);
				})}
				<div className="mt-0.5 border-t border-white/10 pt-0.5 text-zinc-400">
					<span className="text-zinc-500">Final </span>
					<span className="font-mono tabular-nums">{total.toFixed(3)}</span>
				</div>
			</div>
		</div>
	);
}
