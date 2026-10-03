"use strict";

// Bench: per-segment enrichment cost split (Plan §3.0, settles Plan §8.2 —
// is a segment really ~176 ms (86 CLIP + ~80 seek + ~10 I/O), or does the
// slow-seek tail dominate the way Ultra-Pro-Plan §2.3/§3.1 implies?).
// Replicates enrichVideo's serial per-segment work with per-stage timers:
//
//   extractFrameRaw → poster encode (sharp) → decodeToRaw → embedRawImage
//
//   node scripts/bench-enrich.js [--video <path>] [--duration 600]
//        [--presets balanced,ultra] [--deep-seeks 0.6,0.9] [--out <json>]
//
// With no --video, synthesizes a cut-heavy 720p mp4 via ffmpeg lavfi so seeks
// at every depth are measurable and the run is reproducible. Results JSON is
// flushed after each preset.

const fs = require("fs");
const os = require("os");
const path = require("path");
const videoUtils = require("../indexer/video-utils.js");
const core = require("../indexer/build-memory-embeddings-core.js");
const { loadStack, median, pct, argValue } = require("./bench-common.js");

const now = () => performance.now();

function stats(xs) {
	return {
		count: xs.length,
		medianMs: median(xs),
		p95Ms: pct(xs, 0.95),
		maxMs: xs.length ? Math.max(...xs) : null,
	};
}

function fmtMs(x) {
	return x == null ? "—" : x.toFixed(1);
}

async function main() {
	const videoArg = argValue("--video", null);
	const durationArg = Number(argValue("--duration", "600"));
	const presets = (argValue("--presets", "balanced,ultra") || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const deepSeeks = (argValue("--deep-seeks", "0.6,0.9") || "")
		.split(",")
		.map(Number)
		.filter((x) => x > 0 && x < 1);
	const outPath = argValue("--out", null);

	// video-utils only logs fast/slow seek detail under this flag; count lines.
	process.env.SCM_DEBUG_FFMPEG = "1";
	const warnCounts = { slowSeekFallback: 0, fastSeekFailed: 0 };
	const origWarn = console.warn.bind(console);
	console.warn = (...args) => {
		const line = args.join(" ");
		if (line.includes("slow-seek fallback used")) warnCounts.slowSeekFallback++;
		if (line.includes("fast seek failed")) warnCounts.fastSeekFailed++;
		origWarn(...args);
	};

	const ffmpeg = videoUtils.resolveFfmpeg();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-bench-enrich-"));
	const postersDir = path.join(tmp, "posters");
	fs.mkdirSync(postersDir, { recursive: true });

	let film = videoArg;
	if (!film) {
		// Cut-heavy film: ~120 alternating 5 s chunks (2 hard cuts would leave
		// the shot-based plan at 3 segments — real films have hundreds of
		// shots, and the segment count is what the budget samples from).
		const chunks = Math.max(4, Math.round(durationArg / 5));
		const chunkDur = durationArg / chunks;
		const sources = ["testsrc2", "smptehdbars", "rgbtestsrc"];
		film = path.join(tmp, `bench-film-${durationArg}s.mp4`);
		console.log(
			`[bench] synthesizing ${durationArg}s 720p film (${chunks}×${chunkDur.toFixed(1)}s alternating cuts)…`,
		);
		const t0 = now();
		const args = [];
		for (let i = 0; i < chunks; i++) {
			args.push(
				"-f",
				"lavfi",
				"-i",
				`${sources[i % sources.length]}=size=1280x720:rate=30:duration=${chunkDur}`,
			);
		}
		args.push(
			"-filter_complex",
			`concat=n=${chunks}:v=1:a=0`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"28",
			"-pix_fmt",
			"yuv420p",
			film,
		);
		const res = require("child_process").spawnSync(ffmpeg, args, {
			encoding: "utf8",
			timeout: 10 * 60 * 1000,
		});
		if (res.status !== 0 || !fs.existsSync(film)) {
			throw new Error(
				`film synthesis failed: ${String(res.stderr).slice(-500)}`,
			);
		}
		console.log(
			`[bench] film ready in ${((now() - t0) / 1000).toFixed(1)}s → ${film}`,
		);
	}

	const stack = await loadStack();
	const { config, extractor, RawImage, sharp, dim } = stack;

	const duration = await videoUtils.probeDuration(ffmpeg, film);
	console.log(
		`[bench] film duration: ${duration ? duration.toFixed(1) : "?"}s`,
	);

	const results = {
		meta: {
			date: new Date().toISOString(),
			node: process.version,
			film: path.basename(film),
			durationS: duration,
			synthesized: !videoArg,
			presets,
			deepSeeks,
			inputSize: config.inputSize,
			dim,
		},
		presets: {},
		deepSeekProbes: [],
	};

	const outDir = path.dirname(outPath || "/tmp/scm-bench/enrich.json");
	const out = outPath || path.join(outDir, `enrich-${Date.now()}.json`);
	fs.mkdirSync(outDir, { recursive: true });
	const flush = (stage) => {
		fs.writeFileSync(out, JSON.stringify(results, null, 2));
		console.log(`[bench] stage "${stage}" flushed → ${out}`);
	};

	for (const preset of presets) {
		const budget = videoUtils.budgetForQuality(preset);
		console.log(
			`\n[bench] preset "${preset}" (target ${budget.targetSeconds}s, ` +
				`${budget.minSegments}-${budget.maxSegments} segs): detect pass…`,
		);
		const tDetect0 = now();
		const plan = await videoUtils.buildSegmentPlan(ffmpeg, film, null, budget);
		const detectMs = now() - tDetect0;
		console.log(
			`  detect: ${(detectMs / 1000).toFixed(1)}s for ${plan.length} segments`,
		);

		const segments = [];
		let slowSuspect = 0;
		for (let gi = 0; gi < plan.length; gi++) {
			const seg = plan[gi];
			const t0 = now();
			const frame = await videoUtils.extractFrameRaw(ffmpeg, film, seg.t, 480);
			const ffMs = now() - t0;
			if (ffMs > 1000) slowSuspect++;

			const p0 = now();
			await sharp(frame.data, {
				raw: {
					width: frame.width,
					height: frame.height,
					channels: frame.channels || 3,
				},
				limitInputPixels: false,
			})
				.jpeg({ quality: 82 })
				.toFile(path.join(postersDir, `bench-scene-${gi}.jpg`));
			const posterMs = now() - p0;

			const d0 = now();
			const raw = await core.decodeToRaw(frame, sharp, config.inputSize);
			const decodeMs = now() - d0;

			const e0 = now();
			await core.embedRawImage(
				extractor,
				RawImage,
				raw,
				dim,
				config.visionPool,
			);
			const embedMs = now() - e0;

			segments.push({
				gi,
				t: seg.t,
				ffMs,
				posterMs,
				decodeMs,
				embedMs,
				compositeMs: ffMs + posterMs + decodeMs + embedMs,
			});
			if ((gi + 1) % 25 === 0) {
				console.log(`  … ${gi + 1}/${plan.length} segments`);
			}
		}

		const stage = (key) => stats(segments.map((s) => s[key]));
		const composite = stage("compositeMs");
		results.presets[preset] = {
			segmentCount: plan.length,
			detectMs,
			detectMsPerSegment: detectMs / Math.max(1, plan.length),
			ffmpegSeek: stage("ffMs"),
			posterEncode: stage("posterMs"),
			decode: stage("decodeMs"),
			clipEmbed: stage("embedMs"),
			composite,
			slowSeekSuspects: slowSuspect,
			warnCounts: { ...warnCounts },
			segments,
		};
		console.log(
			`  per segment: seek ${fmtMs(stage("ffMs").medianMs)} (p95 ${fmtMs(
				stage("ffMs").p95Ms,
			)}, max ${fmtMs(stage("ffMs").maxMs)}) · poster ${fmtMs(
				stage("posterMs").medianMs,
			)} · decode ${fmtMs(stage("decodeMs").medianMs)} · clip ${fmtMs(
				stage("embedMs").medianMs,
			)} → composite ${fmtMs(composite.medianMs)} ms (p95 ${fmtMs(composite.p95Ms)})`,
		);
		console.log(
			`  slow-seek suspects (>1 s): ${slowSuspect}/${plan.length} · warns: ` +
				`slow-fallback=${warnCounts.slowSeekFallback} fast-failed=${warnCounts.fastSeekFailed}`,
		);
		flush(preset);
	}

	if (deepSeeks.length) {
		console.log(
			`\n[bench] deep-seek probes (fast path expected; O(t) if it trips slow)…`,
		);
		for (const frac of deepSeeks) {
			const at = (duration ?? 0) * frac;
			const t0 = now();
			try {
				await videoUtils.extractFrameRaw(ffmpeg, film, at, 480);
				const ms = now() - t0;
				results.deepSeekProbes.push({ frac, atS: at, ms, ok: true });
				console.log(
					`  seek @${(frac * 100).toFixed(0)}% (t=${at.toFixed(0)}s): ${fmtMs(ms)} ms`,
				);
			} catch (err) {
				results.deepSeekProbes.push({
					frac,
					atS: at,
					ms: now() - t0,
					ok: false,
					error: String(err.message || err),
				});
				console.log(
					`  seek @${(frac * 100).toFixed(0)}%: FAILED — ${err.message}`,
				);
			}
		}
		flush("deep-seeks");
	}

	console.log(`\n[bench] results → ${out}`);
	fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(`[bench] FATAL: ${err.stack || err}`);
	process.exit(1);
});
