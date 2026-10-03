// Shared visual identity for the "why it matched" system: the pill badge
// on each card and the hover score-breakdown tooltip. One source of truth
// so the badge tint and the tooltip accent can never drift apart.

import type { ScoreBreakdown } from "@/lib/memoryRank";

// Mirror of RankedMemory["dominant"] in memoryRank.ts.
export type MatchDominant = "semantic" | "phrase" | "filename" | "ocr";

// ---- Badge tone (the glass pill on the card) -------------------------------
// Dark glass in both themes (the pill sits on a photo), cast toward the
// signal's hue — blue for semantic, green for OCR, amber for filename.

export interface MatchBadgeTone {
	// Border + background of the pill.
	pill: string;
	// Icon hue.
	icon: string;
}

export const MATCH_TONES: Record<string, MatchBadgeTone> = {
	"Visual match": {
		pill: "border-blue-300/25 bg-blue-950/70",
		icon: "text-blue-300",
	},
	"Text on photo": {
		pill: "border-green-300/25 bg-green-950/70",
		icon: "text-green-300",
	},
	"Filename match": {
		pill: "border-amber-300/25 bg-amber-950/70",
		icon: "text-amber-300",
	},
};

export const MATCH_TONE_FALLBACK: MatchBadgeTone = {
	pill: "border-white/10 bg-black/55",
	icon: "text-zinc-300",
};

// ---- Tooltip signal style (the hover breakdown) -----------------------------

export interface MatchSignalStyle {
	label: string;
	// Value text color.
	row: string;
	// Tooltip's left accent border, keyed to the dominant signal.
	accent: string;
}

export const MATCH_SIGNALS: Record<MatchDominant, MatchSignalStyle> = {
	semantic: {
		label: "Semantic",
		row: "text-blue-400",
		accent: "border-l-blue-400",
	},
	phrase: {
		label: "Phrase",
		row: "text-purple-400",
		accent: "border-l-purple-400",
	},
	filename: {
		label: "Filename",
		row: "text-amber-400",
		accent: "border-l-amber-400",
	},
	ocr: {
		label: "OCR text",
		row: "text-green-400",
		accent: "border-l-green-400",
	},
};

// Score rows ordered dominant-first, zero components dropped — the tooltip
// leads with the reason the card is showing the badge at all.
export function orderedBreakdownRows(
	breakdown: ScoreBreakdown,
	dominant?: MatchDominant | null,
): MatchDominant[] {
	const keys: MatchDominant[] = ["semantic", "phrase", "filename", "ocr"];
	const nonzero = keys.filter((k) => breakdown[k] > 0);
	if (!dominant || !nonzero.includes(dominant)) return nonzero;
	return [dominant, ...nonzero.filter((k) => k !== dominant)];
}
