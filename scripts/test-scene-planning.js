#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase-5 planning-math unit tests — the pure, deterministic half of the
// long-movie coverage suite. No Electron, no ffmpeg: every function tested
// here is a pure transform in indexer/video-utils.js, so this runs in
// milliseconds and pins the exact budget/distribution/clamp contract.
//
//   Run:  bun run test:planning   (or:  node scripts/test-scene-planning.js)
//
// The integration half (real enrichment pipeline, backfill round trips,
// renderer tray) lives in main.js as ELECTRON_SMOKE_PHASE4=1.
// ---------------------------------------------------------------------------
"use strict";

const {
	SEGMENT_TARGET_SECONDS,
	MIN_SEGMENTS,
	MAX_SEGMENTS,
	VIDEO_QUALITY_PRESETS,
	VIDEO_QUALITY_IDS,
	DEFAULT_VIDEO_QUALITY,
	parseVideoQuality,
	budgetForQuality,
	segmentBudgetFor,
	sampleShotsEvenly,
	buildIntervalPlan,
	clampPlan,
} = require("../indexer/video-utils.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
console.log("[planning] constants");
// ---------------------------------------------------------------------------
check("target 30 s / floor 8 / ceiling 128", () => {
	if (SEGMENT_TARGET_SECONDS !== 30)
		throw new Error(`target=${SEGMENT_TARGET_SECONDS}`);
	if (MIN_SEGMENTS !== 8) throw new Error(`min=${MIN_SEGMENTS}`);
	if (MAX_SEGMENTS !== 128) throw new Error(`max=${MAX_SEGMENTS}`);
});

// ---------------------------------------------------------------------------
console.log("[planning] segmentBudgetFor — the duration-aware budget table");
// ---------------------------------------------------------------------------
check("10 s clip → floor 8", () => {
	if (segmentBudgetFor(10) !== 8)
		throw new Error(`10s → ${segmentBudgetFor(10)}`);
});
check("120 s clip → floor 8 (ceil(4) beaten by the floor)", () => {
	if (segmentBudgetFor(120) !== 8)
		throw new Error(`120s → ${segmentBudgetFor(120)}`);
});
check("600 s (10 min) → 20 (one point per 30 s)", () => {
	if (segmentBudgetFor(600) !== 20)
		throw new Error(`600s → ${segmentBudgetFor(600)}`);
});
check("2700 s (45 min) → 90", () => {
	if (segmentBudgetFor(2700) !== 90)
		throw new Error(`2700s → ${segmentBudgetFor(2700)}`);
});
check("5400 s (90 min) → 128 (ceiling — was 32)", () => {
	if (segmentBudgetFor(5400) !== 128)
		throw new Error(`5400s → ${segmentBudgetFor(5400)}`);
});
check("10800 s (3 h) → still bounded at 128", () => {
	if (segmentBudgetFor(10800) !== 128)
		throw new Error(`10800s → ${segmentBudgetFor(10800)}`);
});
check("edge values → floor 8 (0, negative, NaN, null)", () => {
	for (const v of [0, -5, NaN, null, undefined, "nope"]) {
		if (segmentBudgetFor(v) !== 8)
			throw new Error(`${String(v)} → ${segmentBudgetFor(v)}`);
	}
});
check("omitted budget opts preserve legacy behavior exactly", () => {
	for (const secs of [10, 120, 600, 2700, 5400, 10800]) {
		const a = segmentBudgetFor(secs);
		const b = segmentBudgetFor(secs, VIDEO_QUALITY_PRESETS.balanced);
		if (a !== b) throw new Error(`${secs}s: default ${a} vs balanced ${b}`);
	}
});

// ---------------------------------------------------------------------------
console.log("[planning] video quality presets — Settings → Video search");
// ---------------------------------------------------------------------------
check(
	"preset table ships eco/balanced/detailed/ultra/ultraPro, default balanced",
	() => {
		if (DEFAULT_VIDEO_QUALITY !== "balanced")
			throw new Error(`default=${DEFAULT_VIDEO_QUALITY}`);
		if (
			JSON.stringify([...VIDEO_QUALITY_IDS].sort()) !==
			JSON.stringify(["balanced", "detailed", "eco", "ultra", "ultraPro"])
		) {
			throw new Error(`ids=${JSON.stringify(VIDEO_QUALITY_IDS)}`);
		}
	},
);
check("parseVideoQuality falls back to balanced on garbage", () => {
	if (parseVideoQuality("eco") !== "eco") throw new Error("eco rejected");
	if (parseVideoQuality("detailed") !== "detailed")
		throw new Error("detailed rejected");
	if (parseVideoQuality("ultra") !== "ultra") throw new Error("ultra rejected");
	if (parseVideoQuality("ultraPro") !== "ultraPro")
		throw new Error("ultraPro rejected");
	for (const v of ["max", "", null, undefined, 42, "ULTRA", "ultra-pro"]) {
		if (parseVideoQuality(v) !== "balanced")
			throw new Error(`${String(v)} → ${parseVideoQuality(v)}`);
	}
});
check(
	"eco < balanced < detailed < ultra < ultraPro (90 min film → 32 / 128 / 256 / 1024 / 2048)",
	() => {
		const eco = segmentBudgetFor(5400, budgetForQuality("eco"));
		const balanced = segmentBudgetFor(5400, budgetForQuality("balanced"));
		const detailed = segmentBudgetFor(5400, budgetForQuality("detailed"));
		const ultra = segmentBudgetFor(5400, budgetForQuality("ultra"));
		const ultraPro = segmentBudgetFor(5400, budgetForQuality("ultraPro"));
		if (eco !== 32) throw new Error(`eco 5400s → ${eco} (expected 32)`);
		if (balanced !== 128)
			throw new Error(`balanced 5400s → ${balanced} (expected 128)`);
		if (detailed !== 256)
			throw new Error(`detailed 5400s → ${detailed} (expected 256)`);
		if (ultra !== 1024)
			throw new Error(`ultra 5400s → ${ultra} (expected 1024)`);
		if (ultraPro !== 2048)
			throw new Error(`ultraPro 5400s → ${ultraPro} (expected 2048)`);
		if (!(
			eco < balanced &&
			balanced < detailed &&
			detailed < ultra &&
			ultra < ultraPro
		)) {
			throw new Error(
				`not ordered: ${eco} < ${balanced} < ${detailed} < ${ultra} < ${ultraPro}`,
			);
		}
	},
);
check(
	"preset floors hold on short clips (10 s → eco 4 / balanced 8 / detailed 12 / ultra 16 / ultraPro 24)",
	() => {
		if (segmentBudgetFor(10, budgetForQuality("eco")) !== 4)
			throw new Error("eco floor");
		if (segmentBudgetFor(10, budgetForQuality("balanced")) !== 8)
			throw new Error("balanced floor");
		if (segmentBudgetFor(10, budgetForQuality("detailed")) !== 12)
			throw new Error("detailed floor");
		if (segmentBudgetFor(10, budgetForQuality("ultra")) !== 16)
			throw new Error("ultra floor");
		if (segmentBudgetFor(10, budgetForQuality("ultraPro")) !== 24)
			throw new Error("ultraPro floor");
	},
);
check("ultra 10 min clip → 120 (one point per 5 s, under the cap)", () => {
	if (segmentBudgetFor(600, budgetForQuality("ultra")) !== 120) {
		throw new Error(
			`ultra 600s → ${segmentBudgetFor(600, budgetForQuality("ultra"))}`,
		);
	}
});
check("ultraPro 10 min clip → 240 (one point per 2.5 s, under the cap)", () => {
	if (segmentBudgetFor(600, budgetForQuality("ultraPro")) !== 240) {
		throw new Error(
			`ultraPro 600s → ${segmentBudgetFor(600, budgetForQuality("ultraPro"))}`,
		);
	}
});
check(
	"ultraPro 2 h film → 2048 (cap; 2880 wanted — the density the cap buys)",
	() => {
		if (segmentBudgetFor(7200, budgetForQuality("ultraPro")) !== 2048) {
			throw new Error(
				`ultraPro 7200s → ${segmentBudgetFor(7200, budgetForQuality("ultraPro"))}`,
			);
		}
	},
);
check("unknown preset resolves to the balanced triple", () => {
	const b = budgetForQuality("nope");
	if (b.targetSeconds !== 30 || b.minSegments !== 8 || b.maxSegments !== 128) {
		throw new Error(JSON.stringify(b));
	}
});

// ---------------------------------------------------------------------------
console.log("[planning] sampleShotsEvenly — uniform TIME coverage");
// ---------------------------------------------------------------------------
// A 90-min film with a shot every 18 s (300 shots). The old front-biased
// slice(0,32) kept only the opening ~9.6 min; the fix must span end to end.
const shots300 = Array.from({ length: 300 }, (_, i) => ({ t: i * 18, dur: 1 }));
const sampled = sampleShotsEvenly(shots300, 5400, 128);

check("exactly `budget` shots sampled (128)", () => {
	if (sampled.length !== 128) throw new Error(`got ${sampled.length}`);
});
check("sorted ascending, no shot reused", () => {
	const ts = sampled.map((s) => s.t);
	for (let i = 1; i < ts.length; i++) {
		if (ts[i] <= ts[i - 1])
			throw new Error(`not strictly ascending at ${i} (${ts[i]})`);
	}
	if (new Set(ts).size !== ts.length) throw new Error("duplicate shots");
});
check("reaches the FINAL act (old front-biased code stopped at ~576 s)", () => {
	const first = sampled[0].t;
	const last = sampled[sampled.length - 1].t;
	if (last < 5250)
		throw new Error(`last shot at ${last}s — final act uncovered`);
	if (first > 150)
		throw new Error(`first shot at ${first}s — opening uncovered`);
	console.log(
		`       coverage span ${first.toFixed(0)}s → ${last.toFixed(0)}s of 5400s`,
	);
});
check(
	"every shot lands inside its ~42 s slot (nearest-midpoint semantics)",
	() => {
		const slot = 5400 / 128;
		for (let i = 0; i < sampled.length; i++) {
			const target = slot * i + slot / 2;
			if (Math.abs(sampled[i].t - target) > slot / 2 + 9) {
				throw new Error(
					`shot ${i} at ${sampled[i].t}s vs slot center ${target.toFixed(1)}s`,
				);
			}
		}
	},
);
check("deterministic — same input, same output", () => {
	const again = sampleShotsEvenly(shots300, 5400, 128);
	if (JSON.stringify(again) !== JSON.stringify(sampled))
		throw new Error("nondeterministic");
});
check("all shots kept (in order) when under budget", () => {
	const few = [
		{ t: 1, dur: 1 },
		{ t: 5, dur: 1 },
		{ t: 9, dur: 1 },
	];
	const out = sampleShotsEvenly(few, 10, 8);
	if (out.length !== 3) throw new Error(`got ${out.length}`);
	if (out[0].t !== 1 || out[2].t !== 9) throw new Error("order lost");
});
check(
	"small deterministic case: shots at 0..600, budget 4 → [100,200,400,500]",
	() => {
		const shots = [0, 100, 200, 300, 400, 500, 600].map((t) => ({ t, dur: 1 }));
		const out = sampleShotsEvenly(shots, 600, 4).map((s) => s.t);
		if (JSON.stringify(out) !== JSON.stringify([100, 200, 400, 500])) {
			throw new Error(`got ${JSON.stringify(out)}`);
		}
	},
);
check("never yields more than the budget (defensive, budget > shots)", () => {
	const one = [{ t: 42, dur: 1 }];
	const out = sampleShotsEvenly(one, 100, 8);
	if (out.length > 1) throw new Error(`got ${out.length}`);
});

// ---------------------------------------------------------------------------
console.log("[planning] buildIntervalPlan — boundary-less fallback");
// ---------------------------------------------------------------------------
check("90 min / 128 → 42.1875 s slices with exact midpoints", () => {
	const plan = buildIntervalPlan(5400, 128);
	const seg = 5400 / 128;
	if (plan.length !== 128) throw new Error(`len ${plan.length}`);
	if (Math.abs(plan[0].t - seg / 2) > 1e-6)
		throw new Error(`first t ${plan[0].t}`);
	if (Math.abs(plan[127].t - (5400 - seg / 2)) > 1e-6)
		throw new Error(`last t ${plan[127].t}`);
	if (Math.abs(plan[64].t - (64 * seg + seg / 2)) > 1e-6)
		throw new Error(`mid t ${plan[64].t}`);
	for (const s of plan)
		if (Math.abs(s.dur - seg) > 1e-6) throw new Error(`dur ${s.dur}`);
});
check("short clip / floor 8 → 8 slices covering the whole clip", () => {
	const plan = buildIntervalPlan(10, 8);
	if (plan.length !== 8) throw new Error(`len ${plan.length}`);
	if (plan[0].t < 0.1 || plan[7].t > 9.9) throw new Error("coverage broken");
});

// ---------------------------------------------------------------------------
console.log("[planning] clampPlan — end-margin + dur floor");
// ---------------------------------------------------------------------------
check("t never seeks past duration − 0.5 s; dur floored at 0.5", () => {
	const plan = clampPlan(
		[
			{ t: 5399.8, dur: 0.2 },
			{ t: -3, dur: 4 },
		],
		5400,
	);
	if (plan[0].t !== 5399.5)
		throw new Error(`t ${plan[0].t} (expected clamp to end margin)`);
	if (plan[0].dur !== 0.5) throw new Error(`dur ${plan[0].dur}`);
	if (plan[1].t !== 0) throw new Error(`negative t clamped to ${plan[1].t}`);
	if (plan[1].dur !== 4) throw new Error(`dur ${plan[1].dur}`);
});
check("t already inside the margin stays untouched", () => {
	const plan = clampPlan([{ t: 5399, dur: 0.2 }], 5400);
	if (plan[0].t !== 5399) throw new Error(`t ${plan[0].t}`);
});
check("null duration → no-op (empty plan safe)", () => {
	const plan = clampPlan([], null);
	if (plan.length !== 0) throw new Error("should stay empty");
});

// ---------------------------------------------------------------------------
if (failed > 0) {
	console.error(
		`[planning] FAILED — ${failed} check(s) failed, ${passed} passed`,
	);
	process.exit(1);
}
console.log(`[planning] OK (${passed} checks)`);
