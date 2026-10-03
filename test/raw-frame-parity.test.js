"use strict";

// Plan 0.5 gate: Top-K / pixel parity between the legacy JPEG path
// (extractFrameAt → file → decodeToRaw) and the raw-pipe path
// (extractFrameRaw → buffer → decodeToRaw). Same timestamps, same scale
// filters, same CLIP resize. Synthetic testsrc2 footage (no real film in
// repo); cosine on post-resize RGB must stay ≥ 0.999 (JPEG-only delta).
//
// Run: node test/raw-frame-parity.test.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const videoUtils = require("../indexer/video-utils.js");
const core = require("../indexer/build-memory-embeddings-core.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failed++;
			console.error(`  ✗ ${name}: ${err.message}`);
		});
}

function cosine(a, b) {
	assert.equal(a.length, b.length, "vector length mismatch");
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
	const ffmpeg = videoUtils.resolveFfmpeg();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raw-parity-"));
	const film = path.join(tmp, "t.mp4");
	const synth = spawnSync(
		ffmpeg,
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=640x360:rate=30:duration=3",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"28",
			"-pix_fmt",
			"yuv420p",
			film,
		],
		{ encoding: "utf8", timeout: 60000 },
	);
	if (synth.status !== 0 || !fs.existsSync(film)) {
		console.error("[raw-parity] FATAL: film synthesis failed");
		process.exit(1);
	}

	const sharp = require("sharp");
	const t = 1.0;
	const inputSize = 224;

	console.log("[raw-frame-parity] JPEG path vs raw-pipe path");

	await check(
		"extractFrameRaw at width=480 returns sized rgb24 buffer",
		async () => {
			const frame = await videoUtils.extractFrameRaw(ffmpeg, film, t, 480);
			assert.equal(frame.channels, 3);
			assert.ok(frame.width > 0 && frame.height > 0, "missing dims");
			assert.equal(
				frame.data.length,
				frame.width * frame.height * 3,
				"rgb24 size mismatch",
			);
			assert.ok(
				frame.width <= 480 && frame.height <= 480,
				"scale filter not applied",
			);
		},
	);

	await check("extractFrameRaw at width=224 is exactly 224×224", async () => {
		const frame = await videoUtils.extractFrameRaw(ffmpeg, film, t, 224);
		assert.equal(frame.width, 224);
		assert.equal(frame.height, 224);
		assert.equal(frame.data.length, 224 * 224 * 3);
	});

	await check(
		"extractFrames returns 3 raw 224×224 frames (no destDir)",
		async () => {
			const frames = await videoUtils.extractFrames(ffmpeg, film);
			assert.equal(frames.length, 3);
			for (const f of frames) {
				assert.equal(f.width, 224);
				assert.equal(f.height, 224);
				assert.equal(f.data.length, 224 * 224 * 3);
			}
		},
	);

	await check("decodeToRaw accepts both path and raw frame", async () => {
		const jpgPath = path.join(tmp, "f.jpg");
		await videoUtils.extractFrameAt(ffmpeg, film, t, jpgPath, 480);
		const fromFile = await core.decodeToRaw(jpgPath, sharp, inputSize);
		const frame = await videoUtils.extractFrameRaw(ffmpeg, film, t, 480);
		const fromRaw = await core.decodeToRaw(frame, sharp, inputSize);
		assert.equal(fromFile.width, fromRaw.width);
		assert.equal(fromFile.height, fromRaw.height);
		assert.equal(fromFile.channels, fromRaw.channels);
	});

	await check("post-resize pixel cosine JPEG vs raw ≥ 0.999", async () => {
		const jpgPath = path.join(tmp, "f2.jpg");
		await videoUtils.extractFrameAt(ffmpeg, film, t, jpgPath, 480);
		const fromFile = await core.decodeToRaw(jpgPath, sharp, inputSize);
		const frame = await videoUtils.extractFrameRaw(ffmpeg, film, t, 480);
		const fromRaw = await core.decodeToRaw(frame, sharp, inputSize);
		const cos = cosine(fromFile.data, fromRaw.data);
		assert.ok(
			cos >= 0.999,
			`cosine ${cos.toFixed(6)} < 0.999 (JPEG-only delta should be tiny)`,
		);
		console.log(`      (cosine ${cos.toFixed(6)})`);
	});

	await check("poster encode from raw frame writes a valid JPEG", async () => {
		const frame = await videoUtils.extractFrameRaw(ffmpeg, film, t, 480);
		const posterPath = path.join(tmp, "poster.jpg");
		await sharp(frame.data, {
			raw: {
				width: frame.width,
				height: frame.height,
				channels: frame.channels || 3,
			},
			limitInputPixels: false,
		})
			.jpeg({ quality: 82 })
			.toFile(posterPath);
		const meta = await sharp(posterPath).metadata();
		assert.equal(meta.format, "jpeg");
		assert.equal(meta.width, frame.width);
		assert.equal(meta.height, frame.height);
	});

	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error("[raw-frame-parity] FATAL:", err);
	process.exit(1);
});
