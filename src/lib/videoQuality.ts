// Video search quality preference (Settings → Video search): the
// scene-segment density preset for background video analysis. Pure helpers
// live here so parsing and cost estimation are unit-testable without a DOM
// or IPC bridge. Must stay in sync with VIDEO_QUALITY_PRESETS in
// indexer/video-utils.js (the authoritative budget math lives there; the
// mirror below only describes it — test/video-quality.test.ts pins the sync).

export type VideoQualitySetting =
	"eco" | "balanced" | "detailed" | "ultra" | "ultraPro";

export const VIDEO_QUALITY_IDS: VideoQualitySetting[] = [
	"eco",
	"balanced",
	"detailed",
	"ultra",
	"ultraPro",
];

export const DEFAULT_VIDEO_QUALITY: VideoQualitySetting = "balanced";

// Mirror of VIDEO_QUALITY_PRESETS (indexer/video-utils.js): the renderer
// needs the (target, min, max) triples for the Settings cost line without an
// IPC round trip. Pinned in sync by test/video-quality.test.ts.
export interface VideoPresetBudget {
	targetSeconds: number;
	minSegments: number;
	maxSegments: number;
}

export const VIDEO_PRESET_BUDGETS: Record<
	VideoQualitySetting,
	VideoPresetBudget
> = {
	eco: { targetSeconds: 60, minSegments: 4, maxSegments: 32 },
	balanced: { targetSeconds: 30, minSegments: 8, maxSegments: 128 },
	detailed: { targetSeconds: 15, minSegments: 12, maxSegments: 256 },
	ultra: { targetSeconds: 5, minSegments: 16, maxSegments: 1024 },
	ultraPro: { targetSeconds: 2.5, minSegments: 24, maxSegments: 2048 },
};

// One-line cost/benefit blurbs shown under each preset in Settings.
export const VIDEO_QUALITY_BLURBS: Record<VideoQualitySetting, string> = {
	eco: "1 point / minute — fastest",
	balanced: "1 point / 30 s — everyday balance",
	detailed: "1 point / 15 s — slower",
	ultra: "1 point / 5 s — long films cap at 1024",
	ultraPro: "1 point / 2.5 s — 2× Ultra, 2× the cost",
};

/** Parses a stored/bridge value into a valid setting; anything else → "balanced". */
export function parseVideoQuality(raw: unknown): VideoQualitySetting {
	return VIDEO_QUALITY_IDS.includes(raw as VideoQualitySetting)
		? (raw as VideoQualitySetting)
		: DEFAULT_VIDEO_QUALITY;
}

/** Mirror of segmentBudgetFor(durationSeconds, budgetOpts) in
 *  indexer/video-utils.js: one searchable point per `targetSeconds`,
 *  floored at `minSegments` for short clips and capped at `maxSegments` so
 *  worst-case cost stays bounded. */
export function segmentBudgetFor(
	durationSeconds: number,
	budget: VideoPresetBudget,
): number {
	if (!(durationSeconds > 0)) return budget.minSegments;
	return Math.max(
		budget.minSegments,
		Math.min(
			budget.maxSegments,
			Math.ceil(durationSeconds / budget.targetSeconds),
		),
	);
}

// ---------------------------------------------------------------------------
// Enrichment cost estimate (Settings → Video search cost line — honest bill)
// ---------------------------------------------------------------------------

// CORRECTION 2026-09-11 (MDs/bench-2026-09-11/, MDs/Ultra-Pro-Plan.md §3.1):
// the old envelope here (~50–85 min per 90-min Ultra film → 3–5 s/segment)
// descended from LFM2.5-VL's VLM-caption estimate column, not today's SigLIP
// cost. Measured on the reference Mac: ~0.11–0.15 s/segment composite (seek
// 22–51 ms + poster ~0.4 + decode ~2.5 + CLIP 54–104 ms), zero slow-seek
// fallbacks in 140 segments, detect ~11 s per 10 min of film. The runtime
// constant below still carries the old envelope — shrinking it changes the
// Settings cost line (user-facing copy), so that is a product decision, not
// a comment fix. Disk: ~50 KB scene poster + ~2 KB segment-bin row per
// segment (MDs/Transcript-Fusion-Scene-Search-Plan.md).
const SECONDS_PER_SEGMENT: [number, number] = [3, 5];
const DISK_BYTES_PER_SEGMENT = 52 * 1024;

export interface EnrichmentCostEstimate {
	/** Total segments (posters + embedding rows) these videos would get. */
	segments: number;
	/** Background wall-clock envelope in minutes [low, high]. */
	timeMinutes: [number, number];
	/** Poster + segment-row disk bytes (near-deterministic). */
	diskBytes: number;
}

/** Sums the per-video budget for each known duration under a preset.
 *  Durations come per video from memories.videosCostEstimate() — the budget
 *  MUST apply per video: summing durations first would collapse every
 *  film's cap into one shared cap and undercount a multi-film library by up
 *  to the cap ratio (two capped 90-min films are 2×2048 rows, not 2048). */
export function estimateEnrichmentCost(
	durations: number[],
	quality: VideoQualitySetting,
): EnrichmentCostEstimate {
	const budget = VIDEO_PRESET_BUDGETS[quality];
	let segments = 0;
	for (const seconds of durations) {
		if (seconds > 0) segments += segmentBudgetFor(seconds, budget);
	}
	return {
		segments,
		timeMinutes: [
			(segments * SECONDS_PER_SEGMENT[0]) / 60,
			(segments * SECONDS_PER_SEGMENT[1]) / 60,
		],
		diskBytes: segments * DISK_BYTES_PER_SEGMENT,
	};
}

/** "~6–9 h" / "~40–70 min" for the cost line — floors the low end and ceils
 *  the high end so the range never oversells. Collapses to a single value
 *  when rounding makes the ends meet; null when there's nothing to show. */
export function formatTimeRange(minutes: [number, number]): string | null {
	const [low, high] = minutes;
	if (!(high > 0)) return null;
	if (high < 90) {
		const lo = Math.floor(low / 5) * 5;
		const hi = Math.ceil(high / 5) * 5;
		return lo <= 0 || lo >= hi ? `~${hi} min` : `~${lo}–${hi} min`;
	}
	const lo = Math.floor(low / 60);
	const hi = Math.ceil(high / 60);
	return lo <= 0 || lo >= hi ? `~${hi} h` : `~${lo}–${hi} h`;
}

/** "~6.2 h" / "~42 min" — total footage for the cost line. Null when empty. */
export function formatFootage(seconds: number): string | null {
	if (!(seconds > 0)) return null;
	if (seconds < 90 * 60) return `~${Math.max(1, Math.round(seconds / 60))} min`;
	return `~${(Math.round((seconds / 3600) * 10) / 10).toFixed(1)} h`;
}
