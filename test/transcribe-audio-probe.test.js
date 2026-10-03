"use strict";

// ---------------------------------------------------------------------------
// Audio-probe + stub-repair tests — the "Dialogue shows nothing" regression.
//
//   Run:  node test/transcribe-audio-probe.test.js
//         bun run test:transcribe-audio-probe
//
// Background: before the whisper engine existed, every video was recorded
// with ZERO transcript chunks — indistinguishable from a truly silent film,
// so the launch backfill skipped them forever and Dialogue stayed empty.
// The repair probes each empty entry for an audio stream and re-queues only
// those WITH audio (silent films keep their legitimate empty).
//
//   1. probeHasAudio on generated fixtures (silent vs tone, missing file)
//   2. repairCandidates pure planning (empties listed, non-empty skipped)
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const videoUtils = require("../indexer/video-utils.js");
const { repairCandidates } = require("../indexer/transcript-store-utils.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
	try {
		const r = fn();
		if (r && typeof r.then === "function") {
			return r.then(
				() => {
					passed++;
					console.log(`  ✓ ${name}`);
				},
				(err) => {
					failed++;
					console.error(`  ✗ ${name}: ${err.message}`);
				},
			);
		}
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
	return null;
}

function ffmpegBin() {
	try {
		const p = require("../node_modules/ffmpeg-static");
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* fall through */
	}
	return null;
}

async function main() {
	const ffmpeg = ffmpegBin();
	if (!ffmpeg) {
		console.log(
			"[audio-probe] no ffmpeg-static — probe tests need the binary, failing loudly",
		);
		failed++;
		console.log(
			`\n[transcribe-audio-probe] ${passed} passed, ${failed} failed`,
		);
		process.exitCode = 1;
		return;
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-audio-probe-"));
	const silent = path.join(dir, "silent.mp4");
	const tone = path.join(dir, "tone.mp4");
	try {
		// Silent: color video, no audio stream at all.
		let r = spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:s=160x120:d=2",
				"-c:v",
				"mpeg4",
				"-an",
				silent,
			],
			{ timeout: 60000 },
		);
		assert.equal(r.status, 0, "silent fixture build failed");
		// Tone: same video + sine audio stream.
		r = spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=red:s=160x120:d=2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=2",
				"-shortest",
				"-c:v",
				"mpeg4",
				"-c:a",
				"aac",
				tone,
			],
			{ timeout: 60000 },
		);
		assert.equal(r.status, 0, "tone fixture build failed");

		// ---------------------------------------------------------------------------
		console.log("[audio-probe] probeHasAudio");
		// ---------------------------------------------------------------------------
		await check(
			"silent video → false (legitimate empty, never retried)",
			async () => {
				assert.equal(await videoUtils.probeHasAudio(ffmpeg, silent), false);
			},
		);

		await check(
			"video with audio stream → true (repair candidate)",
			async () => {
				assert.equal(await videoUtils.probeHasAudio(ffmpeg, tone), true);
			},
		);

		await check("missing file → false, never throws", async () => {
			assert.equal(
				await videoUtils.probeHasAudio(ffmpeg, path.join(dir, "nope.mp4")),
				false,
			);
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// ---------------------------------------------------------------------------
	console.log("[audio-probe] repairCandidates (pure planning)");
	// ---------------------------------------------------------------------------
	check("lists only zero-chunk entries, in order", () => {
		const videos = new Map([
			["a.mp4", []],
			["b.mp4", [{ t0: 0, t1: 10, off: 0, n: 1, text: "hello world today" }]],
			["c.mp4", []],
		]);
		assert.deepEqual(repairCandidates(videos), ["a.mp4", "c.mp4"]);
	});

	check("empty map / non-Map → [] (startup-safe)", () => {
		assert.deepEqual(repairCandidates(new Map()), []);
		assert.deepEqual(repairCandidates(null), []);
		assert.deepEqual(repairCandidates("nope"), []);
	});

	check("all-filled sidecar → [] (nothing to repair)", () => {
		const videos = new Map([
			["a.mp4", [{ t0: 0, t1: 10, off: 0, n: 1, text: "hello world today" }]],
		]);
		assert.deepEqual(repairCandidates(videos), []);
	});

	console.log(`\n[transcribe-audio-probe] ${passed} passed, ${failed} failed`);
	// NOTE: exitCode (not exit()) — this process may share the address
	// space with native modules in future extensions; natural drain only.
	process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
	console.error(
		`[transcribe-audio-probe] harness error: ${err.stack || err.message}`,
	);
	process.exitCode = 1;
});
