import { expect, test } from "bun:test";
import {
	DEFAULT_VIDEO_QUALITY,
	estimateEnrichmentCost,
	formatFootage,
	formatTimeRange,
	segmentBudgetFor,
	VIDEO_PRESET_BUDGETS,
	VIDEO_QUALITY_IDS,
	parseVideoQuality,
} from "../src/lib/videoQuality";
// The authoritative triples live in the main process (CJS) — importing them
// here is what makes the sync test below a real guard, not a tautology.
import { VIDEO_QUALITY_PRESETS } from "../indexer/video-utils.js";

// The renderer-side parse must accept exactly the five preset ids the
// main process stores (indexer/video-utils.js VIDEO_QUALITY_PRESETS).
test("parseVideoQuality accepts eco, balanced, detailed, ultra, and ultraPro", () => {
	expect(parseVideoQuality("eco")).toBe("eco");
	expect(parseVideoQuality("balanced")).toBe("balanced");
	expect(parseVideoQuality("detailed")).toBe("detailed");
	expect(parseVideoQuality("ultra")).toBe("ultra");
	expect(parseVideoQuality("ultraPro")).toBe("ultraPro");
});

test("parseVideoQuality falls back to balanced on garbage", () => {
	expect(parseVideoQuality(null)).toBe("balanced");
	expect(parseVideoQuality(undefined)).toBe("balanced");
	expect(parseVideoQuality("")).toBe("balanced");
	expect(parseVideoQuality("max")).toBe("balanced");
	expect(parseVideoQuality("ECO")).toBe("balanced");
	expect(parseVideoQuality(2)).toBe("balanced");
});

test("preset ids and default stay in sync with the main-process table", () => {
	expect([...VIDEO_QUALITY_IDS].sort()).toEqual([
		"balanced",
		"detailed",
		"eco",
		"ultra",
		"ultraPro",
	]);
	expect(DEFAULT_VIDEO_QUALITY).toBe("balanced");
});

test("budget mirror stays in sync with the main-process triples", () => {
	for (const id of VIDEO_QUALITY_IDS) {
		expect(VIDEO_PRESET_BUDGETS[id]).toEqual(VIDEO_QUALITY_PRESETS[id]);
	}
});

// ---------------------------------------------------------------------------
// Cost estimator (Settings → Video search cost line — MDs/Ultra-Pro-Plan.md §4)
// ---------------------------------------------------------------------------

test("estimateEnrichmentCost applies the budget per video, not to the sum", () => {
	// Two capped 90-min films under ultraPro: 2048 rows EACH. Summing the
	// durations first (10800 s) would collapse both caps into one shared cap
	// and undercount 2×.
	const est = estimateEnrichmentCost([5400, 5400], "ultraPro");
	expect(est.segments).toBe(4096);
	// Each segment bills 3–5 s of background time and ~52 KB of disk.
	expect(est.timeMinutes[0]).toBeCloseTo((4096 * 3) / 60, 5);
	expect(est.timeMinutes[1]).toBeCloseTo((4096 * 5) / 60, 5);
	expect(est.diskBytes).toBe(4096 * 52 * 1024);
});

test("estimateEnrichmentCost floors short clips and skips invalid durations", () => {
	// A 10 s clip floors at 24 segments under ultraPro; 0/negative lengths
	// (unmeasured) contribute nothing.
	expect(estimateEnrichmentCost([10, 0, -5], "ultraPro").segments).toBe(24);
	expect(estimateEnrichmentCost([], "ultraPro").segments).toBe(0);
});

test("renderer segmentBudgetFor mirrors the indexer math", () => {
	// 90-min film: ultraPro wants ceil(5400/2.5) = 2160, capped at 2048.
	expect(segmentBudgetFor(5400, VIDEO_PRESET_BUDGETS.ultraPro)).toBe(2048);
	// 2 h film: 2880 wanted, still capped.
	expect(segmentBudgetFor(7200, VIDEO_PRESET_BUDGETS.ultraPro)).toBe(2048);
	// 10-min clip: 240, under the cap.
	expect(segmentBudgetFor(600, VIDEO_PRESET_BUDGETS.ultraPro)).toBe(240);
	// Invalid duration → floor.
	expect(segmentBudgetFor(0, VIDEO_PRESET_BUDGETS.ultraPro)).toBe(24);
});

test("time range formatting floors low, ceils high, never oversells", () => {
	// 102 min–170 min (a capped film's envelope) → hours, conservative ends.
	expect(formatTimeRange([102, 170])).toBe("~1–3 h");
	// Small ranges stay in minutes.
	expect(formatTimeRange([12, 20])).toBe("~10–20 min");
	// Single-value collapse when rounding makes the ends meet.
	expect(formatTimeRange([65, 65])).toBe("~65 min");
	expect(formatTimeRange([120, 120])).toBe("~2 h");
	// Nothing to show.
	expect(formatTimeRange([0, 0])).toBe(null);
});

test("footage formatting picks minutes or hours", () => {
	expect(formatFootage(2520)).toBe("~42 min");
	expect(formatFootage(22320)).toBe("~6.2 h");
	expect(formatFootage(0)).toBe(null);
});
