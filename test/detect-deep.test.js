#!/usr/bin/env node
"use strict";
// Phase 1 deep integration suite (plan §1.1–1.5 gates).
// Real ffmpeg, multi-fixture, cache, budgets, fallbacks. No Electron.
//
//   node test/detect-deep.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const videoUtils = require("../indexer/video-utils.js");
const detectCache = require("../indexer/detect-cache.js");

const ffmpeg = videoUtils.resolveFfmpeg();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-detect-deep-"));
const cacheDir = path.join(tmp, "cache");
fs.mkdirSync(cacheDir, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failed++;
			failures.push({ name, err });
			console.error(`  ✗ ${name}: ${err.message}`);
		});
}

function ffmpegRun(args) {
	execFileSync(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
}

// High-contrast hard cuts. NOTE: pure hue-only color concat (red→green)
// does NOT trip ffmpeg's `scene` filter even at threshold 0 (measured
// 2026-09-25) — the filter is content-dependent. Black↔white reliably
// produces scene_score ~0.4 and is the right synthetic for plan-parity
// gates. Six segments of `segSec` → expected bounds at i*segSec.
function makeHardCuts(out, pattern, segSec) {
	// pattern: "bw" | "colors"
	const tones =
		pattern === "colors"
			? ["red", "green", "blue", "yellow", "magenta", "cyan"]
			: ["white", "black", "white", "black", "white", "black"];
	const args = ["-y"];
	for (const c of tones) {
		args.push("-f", "lavfi", "-i", `color=c=${c}:s=960x540:d=${segSec}:r=30`);
	}
	args.push(
		"-filter_complex",
		tones.map((_, i) => `[${i}:v]`).join("") +
			`concat=n=${tones.length}:v=1:a=0[out]`,
		"-map",
		"[out]",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-preset",
		"veryfast",
		out,
	);
	ffmpegRun(args);
	return {
		path: out,
		segSec,
		pattern,
		nCuts: tones.length - 1,
		expected: Array.from({ length: tones.length - 1 }, (_, i) => (i + 1) * segSec),
	};
}

// Continuous take: one source, no cuts expected.
function makeStatic(out, seconds = 36) {
	ffmpegRun([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=navy:s=960x540:d=${seconds}:r=30`,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-preset",
		"veryfast",
		out,
	]);
	return { path: out, seconds };
}

function near(a, b, tol) {
	return Math.abs(a - b) <= tol;
}

function assertPlanParity(expected, actual, tol = 1.0) {
	for (const e of expected) {
		assert.ok(
			actual.some((a) => near(a, e, tol)),
			`missing cut near ${e}s in [${actual.map((x) => x.toFixed(2)).join(", ")}]`,
		);
	}
	for (const a of actual) {
		assert.ok(
			expected.some((e) => near(a, e, tol)),
			`unexpected cut at ${a.toFixed(2)}s`,
		);
	}
}

async function main() {
	const hard = makeHardCuts(path.join(tmp, "hard-6cut.mp4"), "bw", 10);
	const staticTape = makeStatic(path.join(tmp, "static-36s.mp4"), 36);
	const tiny = makeHardCuts(path.join(tmp, "tiny-6cut.mp4"), "bw", 3);

	console.log("[deep] fixtures", {
		hard: hard.path,
		static: staticTape.path,
		tiny: tiny.path,
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-plan parity — software baseline vs strategies");
	// ------------------------------------------------------------------
	const baselineOpts = {
		hwaccel: "software",
		height: 360,
		fps: 0,
		threshold: 0.3,
		keyframe: false,
		cache: false,
	};
	await check("baseline finds all 5 BW hard cuts ±1 s", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		assert.ok(r.boundaries.length >= 5, `only ${r.boundaries.length} bounds`);
		assertPlanParity(hard.expected, r.boundaries, 1.0);
	});
	await check("software-180-fps10 plan matches baseline ±1 s", async () => {
		const base = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		const alt = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...baselineOpts,
			height: 180,
			fps: 10,
		});
		assertPlanParity(base.boundaries, alt.boundaries, 1.0);
		assertPlanParity(hard.expected, alt.boundaries, 1.0);
	});
	await check("videotoolbox plan matches baseline ±1 s (may fall back)", async () => {
		const base = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		const vt = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...baselineOpts,
			hwaccel: "videotoolbox",
		});
		assert.ok(vt.engine, "engine recorded");
		assertPlanParity(base.boundaries, vt.boundaries, 1.0);
	});
	await check("keyframe refine plan matches baseline ±1 s", async () => {
		const base = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		const kf = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...baselineOpts,
			height: 180,
			fps: 10,
			keyframe: true,
		});
		assertPlanParity(base.boundaries, kf.boundaries, 1.0);
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-plan — static take → interval fallback");
	// ------------------------------------------------------------------
	await check("static take has ~no cuts; buildSegmentPlan interval-covers", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, staticTape.path, null, null, baselineOpts);
		assert.ok(r.boundaries.length <= 1, `unexpected cuts ${r.boundaries}`);
		const plan = await videoUtils.buildSegmentPlan(ffmpeg, staticTape.path, null, null, baselineOpts);
		assert.ok(plan.length >= 8, `interval plan too small: ${plan.length}`);
		assert.ok(plan.length <= 128);
		// midpoints span the tape
		assert.ok(plan[0].t >= 0);
		assert.ok(plan[plan.length - 1].t <= 36);
		for (const seg of plan) {
			assert.ok(seg.dur >= 0.5, "dur floor");
		}
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-plan — budgets + clamp on hard cuts");
	// ------------------------------------------------------------------
	await check("buildSegmentPlan respects eco budget max 32", async () => {
		const plan = await videoUtils.buildSegmentPlan(
			ffmpeg,
			hard.path,
			null,
			videoUtils.VIDEO_QUALITY_PRESETS.eco,
			baselineOpts,
		);
		assert.ok(plan.length >= 1 && plan.length <= 32, `eco plan ${plan.length}`);
		assert.ok(plan.length <= hard.expected.length + 1);
	});
	await check("buildSegmentPlan detailed keeps shots when under budget", async () => {
		const plan = await videoUtils.buildSegmentPlan(
			ffmpeg,
			hard.path,
			null,
			videoUtils.VIDEO_QUALITY_PRESETS.detailed,
			baselineOpts,
		);
		assert.ok(plan.length >= 4, `detailed plan ${plan.length}`);
	});
	await check("tiny clip plan stays finite and in-range", async () => {
		const plan = await videoUtils.buildSegmentPlan(ffmpeg, tiny.path, null, null, baselineOpts);
		assert.ok(plan.length >= 1, "tiny plan empty");
		for (const s of plan) {
			assert.ok(s.t >= 0 && s.t <= 18, `t=${s.t}`);
		}
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-cache — hit / miss / invalidate / concurrent");
	// ------------------------------------------------------------------
	const cacheOpts = {
		...baselineOpts,
		height: 180,
		fps: 10,
		cache: true,
		cacheDir,
	};
	await check("cold detect writes cache; hot detect is cached", async () => {
		const cold = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, cacheOpts);
		assert.strictEqual(cold.cached, false);
		const hot = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, cacheOpts);
		assert.strictEqual(hot.cached, true);
		assert.deepStrictEqual(hot.boundaries, cold.boundaries);
		assert.strictEqual(hot.engine, cold.engine);
		assert.ok(hot.wallMs < 50, `hot wall ${hot.wallMs}ms`);
	});
	await check("config change misses cache (height 180→360)", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...cacheOpts,
			height: 360,
		});
		assert.strictEqual(r.cached, false, "expected miss after config change");
		const again = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...cacheOpts,
			height: 360,
		});
		assert.strictEqual(again.cached, true);
	});
	await check("mtime bump misses cache", async () => {
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(hard.path, future, future);
		const r = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, cacheOpts);
		assert.strictEqual(r.cached, false, "expected miss after mtime");
	});
	await check("cache disabled without cacheDir", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, tiny.path, null, null, {
			...baselineOpts,
			cache: true,
			cacheDir: null,
		});
		assert.strictEqual(r.cached, false);
		assert.ok(Array.isArray(r.boundaries));
	});
	await check("concurrent cold detects both succeed (last writer wins)", async () => {
		const p = path.join(tmp, "hard-copy.mp4");
		fs.copyFileSync(hard.path, p);
		const [a, b] = await Promise.all([
			videoUtils.detectScenes(ffmpeg, p, null, null, cacheOpts),
			videoUtils.detectScenes(ffmpeg, p, null, null, cacheOpts),
		]);
		assert.ok(Array.isArray(a.boundaries) && Array.isArray(b.boundaries));
		const hot = await videoUtils.detectScenes(ffmpeg, p, null, null, cacheOpts);
		assert.strictEqual(hot.cached, true);
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-progress + measurement + errors");
	// ------------------------------------------------------------------
	await check("onProgress emits ≥1 event and ends at 1.0", async () => {
		const events = [];
		await videoUtils.detectScenes(ffmpeg, hard.path, (e) => events.push(e), 72, baselineOpts);
		assert.ok(events.length >= 1, "no progress");
		assert.ok(events[events.length - 1].pct === 1 || events.some((e) => e.pct >= 0.99));
	});
	await check("measured duration within ±2 s of probe", async () => {
		const dur = await videoUtils.probeDuration(ffmpeg, hard.path);
		const r = await videoUtils.detectScenes(ffmpeg, hard.path, null, dur, baselineOpts);
		assert.ok(r.duration != null, "no measured duration");
		assert.ok(Math.abs(r.duration - dur) <= 2, `measured ${r.duration} vs probe ${dur}`);
	});
	await check("missing file → empty plan, no throw", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, path.join(tmp, "nope.mp4"), null, null, baselineOpts);
		assert.deepStrictEqual(r.boundaries, []);
		const plan = await videoUtils.buildSegmentPlan(ffmpeg, path.join(tmp, "nope.mp4"));
		assert.deepStrictEqual(plan, []);
	});
	await check("non-video bytes → empty / safe", async () => {
		const bad = path.join(tmp, "not-video.mp4");
		fs.writeFileSync(bad, "hello world not a video");
		const plan = await videoUtils.buildSegmentPlan(ffmpeg, bad, null, null, baselineOpts);
		assert.ok(Array.isArray(plan));
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-engine fallback");
	// ------------------------------------------------------------------
	await check("videotoolbox+hwdownload falls back to software and keeps plan", async () => {
		const r = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...baselineOpts,
			hwaccel: "videotoolbox",
			hwaccelOutputFormat: true,
		});
		// Either VT+hwdownload worked, or we fell back to software — both OK
		// as long as boundaries match the software plan.
		const base = await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		assertPlanParity(base.boundaries, r.boundaries, 1.0);
		assert.ok(["software", "videotoolbox+hwdownload", "videotoolbox"].includes(r.engine), r.engine);
	});
	await check("explicit software never attempts VT args", async () => {
		const args = videoUtils.buildDetectArgs(
			hard.path,
			videoUtils.resolveDetectOptions({ hwaccel: "software" }),
		);
		assert.ok(!args.includes("-hwaccel"));
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-env wiring (indexer-style)");
	// ------------------------------------------------------------------
	await check("env SCM_DETECT_HEIGHT/FPS/CACHE_DIR drive a cached 180p run", async () => {
		process.env.SCM_DETECT_HEIGHT = "180";
		process.env.SCM_DETECT_FPS = "10";
		process.env.SCM_DETECT_CACHE_DIR = cacheDir;
		process.env.SCM_DETECT_CACHE = "1";
		try {
			const p = path.join(tmp, "hard-env.mp4");
			fs.copyFileSync(hard.path, p);
			const r1 = await videoUtils.detectScenes(ffmpeg, p);
			const r2 = await videoUtils.detectScenes(ffmpeg, p);
			assert.strictEqual(r2.cached, true, "env cacheDir should enable cache");
			assertPlanParity(hard.expected, r1.boundaries, 1.0);
		} finally {
			delete process.env.SCM_DETECT_HEIGHT;
			delete process.env.SCM_DETECT_FPS;
			delete process.env.SCM_DETECT_CACHE_DIR;
			delete process.env.SCM_DETECT_CACHE;
		}
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-cache file integrity");
	// ------------------------------------------------------------------
	await check("cache file schema + JSON parse after many writes", async () => {
		const cachePath = detectCache.detectCachePath(cacheDir);
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		assert.strictEqual(raw.schema, detectCache.CACHE_SCHEMA);
		assert.ok(Object.keys(raw.entries).length >= 2, "entries written");
		for (const e of Object.values(raw.entries)) {
			assert.ok(Array.isArray(e.boundaries));
			assert.ok(typeof e.createdAt === "string");
		}
	});

	// ------------------------------------------------------------------
	console.log("[deep] G-speed smoke (informational)");
	// ------------------------------------------------------------------
	await check("180p+fps10 not slower than 360p baseline on hard fixture", async () => {
		const t0 = Date.now();
		await videoUtils.detectScenes(ffmpeg, hard.path, null, null, baselineOpts);
		const baseMs = Date.now() - t0;
		const t1 = Date.now();
		await videoUtils.detectScenes(ffmpeg, hard.path, null, null, {
			...baselineOpts,
			height: 180,
			fps: 10,
		});
		const altMs = Date.now() - t1;
		// Allow noise: must not be >1.5x slower. Speedup is recorded in bench.
		assert.ok(altMs < baseMs * 1.5 + 200, `180/fps10 ${altMs}ms vs base ${baseMs}ms`);
	});

	console.log(`\n[deep] ${passed} passed, ${failed} failed`);
	if (failed) {
		for (const f of failures) console.error(`  FAIL ${f.name}: ${f.err.stack}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
