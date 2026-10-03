#!/usr/bin/env node
"use strict";
// Phase 1 detect bench (plan §Measurement + §Phase 1.1 risk check).
//
// Builds a deterministic multi-cut fixture, then times each detect strategy
// and compares shot-boundary plans against the software baseline (±1 s gate).
//
// Usage:
//   node scripts/bench-detect.js [film.mp4]
//   node scripts/bench-detect.js --fixture-only
//
// Strategies:
//   software-baseline   scale 360, full rate, threshold 0.3 (historic)
//   software-180-fps10  scale 180 + fps=10 (Phase 1.2)
//   hw-videotoolbox     -hwaccel videotoolbox (Phase 1.1)
//   hw-vt-hwdownload    -hwaccel_output_format + hwdownload in filter
//   keyframe-180        I-frame coarse + refine (Phase 1.3)
//   software-180-cache  same as software-180-fps10 with cache (Phase 1.4)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const videoUtils = require("../indexer/video-utils.js");

function arg(flag, fallback) {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === flag) return argv[i + 1];
		if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
	}
	return fallback;
}

function hasFlag(name) {
	return process.argv.slice(2).includes(name);
}

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function makeFixture(ffmpeg, outPath, seconds = 90) {
	// 6 hard cuts on solid color sources, 15 s each → 6 shots, 5 boundaries.
	// Realistic enough for decode cost (720p) and plan-parity checks.
	const colors = ["red", "green", "blue", "yellow", "magenta", "cyan"];
	const seg = Math.floor(seconds / colors.length);
	const args = ["-y"];
	for (const c of colors) {
		args.push("-f", "lavfi", "-i", `color=c=${c}:s=1280x720:d=${seg}:r=30`);
	}
	args.push(
		"-filter_complex",
		colors.map((_, i) => `[${i}:v]`).join("") +
			`concat=n=${colors.length}:v=1:a=0[out]`,
		"-map",
		"[out]",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-preset",
		"veryfast",
		outPath,
	);
	execFileSync(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
	return {
		path: outPath,
		seconds: seg * colors.length,
		cutCount: colors.length - 1,
		expectedBounds: Array.from(
			{ length: colors.length - 1 },
			(_, i) => (i + 1) * seg,
		),
	};
}

function planParity(baseline, other, tolS = 1.0) {
	// Every baseline cut should have a counterpart within tolS in `other`,
	// and vice versa (allowing other to add/drop at most ±0 — strict plan
	// gate from the master plan: ±1 s timestamps).
	const match = (from, to) => {
		const unmatched = [];
		for (const t of from) {
			if (!to.some((u) => Math.abs(u - t) <= tolS)) unmatched.push(t);
		}
		return unmatched;
	};
	return {
		missing: match(baseline, other),
		extra: match(other, baseline),
		baseline,
		other,
	};
}

async function timeDetect(label, fn, repeats = 3) {
	const walls = [];
	let last = null;
	for (let i = 0; i < repeats; i++) {
		const t0 = Date.now();
		last = await fn();
		walls.push(Date.now() - t0);
	}
	return {
		label,
		walls,
		p50: median(walls),
		min: Math.min(...walls),
		max: Math.max(...walls),
		result: last,
	};
}

async function main() {
	const ffmpeg = videoUtils.resolveFfmpeg();
	const fixtureOnly = hasFlag("--fixture-only");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-detect-bench-"));
	const cacheDir = path.join(tmpDir, "cache");
	fs.mkdirSync(cacheDir, { recursive: true });

	let film = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
	let meta;
	if (!film) {
		const out = path.join(tmpDir, "fixture-6cut-720p.mp4");
		console.log(`[bench] generating fixture → ${out}`);
		meta = makeFixture(ffmpeg, out, 90);
		film = meta.path;
		console.log(
			`[bench] fixture ${meta.seconds}s, ${meta.cutCount} cuts at ${meta.expectedBounds.join(", ")}s`,
		);
	} else {
		const st = fs.statSync(film);
		meta = { path: film, seconds: null, cutCount: null, expectedBounds: null, bytes: st.size };
	}
	if (fixtureOnly) {
		console.log(film);
		return;
	}

	const reps = Number(arg("--reps", "3"));
	const strategies = [
		{
			id: "software-baseline",
			opts: {
				hwaccel: "software",
				height: 360,
				fps: 0,
				threshold: 0.3,
				keyframe: false,
				cache: false,
			},
		},
		{
			id: "software-180-fps10",
			opts: {
				hwaccel: "software",
				height: 180,
				fps: 10,
				threshold: 0.3,
				keyframe: false,
				cache: false,
			},
		},
		{
			id: "hw-videotoolbox",
			opts: {
				hwaccel: "videotoolbox",
				height: 360,
				fps: 0,
				threshold: 0.3,
				keyframe: false,
				cache: false,
			},
		},
		{
			id: "hw-vt-hwdownload",
			opts: {
				hwaccel: "videotoolbox",
				hwaccelOutputFormat: true,
				height: 360,
				fps: 0,
				threshold: 0.3,
				keyframe: false,
				cache: false,
			},
		},
		{
			id: "keyframe-180",
			opts: {
				hwaccel: "software",
				height: 180,
				fps: 10,
				threshold: 0.3,
				keyframe: true,
				cache: false,
			},
		},
		{
			id: "hw-vt-180-fps10",
			opts: {
				hwaccel: "videotoolbox",
				height: 180,
				fps: 10,
				threshold: 0.3,
				keyframe: false,
				cache: false,
			},
		},
	];

	const results = [];
	for (const s of strategies) {
		process.stdout.write(`[bench] ${s.id} … `);
		const timed = await timeDetect(
			s.id,
			() => videoUtils.detectScenes(ffmpeg, film, null, null, s.opts),
			reps,
		);
		const b = timed.result.boundaries || [];
		console.log(
			`p50=${timed.p50}ms n=${b.length} engine=${timed.result.engine} bounds=[${b.map((x) => x.toFixed(2)).join(", ")}]`,
		);
		results.push({ ...timed, id: s.id, opts: s.opts, boundaries: b });
	}

	// Cache strategy: run once cold, once hot.
	process.stdout.write("[bench] software-180-cache cold … ");
	const cacheOpts = {
		hwaccel: "software",
		height: 180,
		fps: 10,
		threshold: 0.3,
		keyframe: false,
		cache: true,
		cacheDir,
	};
	const cold0 = Date.now();
	const cold = await videoUtils.detectScenes(ffmpeg, film, null, null, cacheOpts);
	const coldMs = Date.now() - cold0;
	console.log(`${coldMs}ms cached=${cold.cached}`);
	process.stdout.write("[bench] software-180-cache hot … ");
	const hot0 = Date.now();
	const hot = await videoUtils.detectScenes(ffmpeg, film, null, null, cacheOpts);
	const hotMs = Date.now() - hot0;
	console.log(`${hotMs}ms cached=${hot.cached}`);
	results.push({
		id: "software-180-cache-cold",
		p50: coldMs,
		walls: [coldMs],
		result: cold,
		boundaries: cold.boundaries,
	});
	results.push({
		id: "software-180-cache-hot",
		p50: hotMs,
		walls: [hotMs],
		result: hot,
		boundaries: hot.boundaries,
	});

	const base = results.find((r) => r.id === "software-baseline");
	const report = {
		schema: "scm-detect-bench/v1",
		createdAt: new Date().toISOString(),
		film: meta,
		ffmpeg,
		reps,
		strategies: results.map((r) => ({
			id: r.id,
			opts: r.opts,
			p50Ms: r.p50,
			minMs: r.min ?? r.p50,
			maxMs: r.max ?? r.p50,
			wallsMs: r.walls,
			engine: r.result?.engine,
			boundaries: r.boundaries,
			parity: base
				? planParity(base.boundaries, r.boundaries, 1.0)
				: null,
			speedupVsBaseline: base && r.p50 > 0 ? base.p50 / r.p50 : null,
		})),
	};

	console.log("\n=== summary (p50 vs software-baseline) ===");
	for (const s of report.strategies) {
		const sp =
			s.speedupVsBaseline != null
				? `${s.speedupVsBaseline.toFixed(2)}x`
				: "—";
		const miss = s.parity ? s.parity.missing.length : "—";
		const extra = s.parity ? s.parity.extra.length : "—";
		console.log(
			`${s.id.padEnd(24)} p50=${String(s.p50Ms).padStart(6)}ms  ${sp.padStart(7)}  miss=${miss} extra=${extra}  engine=${s.engine}`,
		);
	}

	const outJson = path.join(
		path.resolve(__dirname, ".."),
		"MDs",
		"bench-detect",
		`detect-${new Date().toISOString().slice(0, 10)}.json`,
	);
	fs.mkdirSync(path.dirname(outJson), { recursive: true });
	// Don't stomp an existing same-day file — append a suffix.
	let target = outJson;
	if (fs.existsSync(target)) {
		target = outJson.replace(/\.json$/, `-${Date.now()}.json`);
	}
	fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
	console.log(`\n[bench] report → ${target}`);
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
