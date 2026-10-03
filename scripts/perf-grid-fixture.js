"use strict";

// Synthetic large-library fixture for the grid-virtualization smoke
// (ELECTRON_SMOKE_GRID). Bypasses the import pipeline on purpose: importing
// 50k photos through CLIP would take the better part of an hour, while the
// grid under test only needs ROWS (browse never embeds).
//
// What it writes into $MEMORIES_DATA_DIR/library (== userData/library,
// the app's DATA_DIR: main.js joins app.getPath("userData") + "library"):
//   photos/perf-000000.jpg … perf-<N-1>.jpg  — hard links of one 96px JPEG
//   memories-index.json                      — N rows, dim 128, spread mtimes,
//                                              ocr pre-filled (""), screenshot
//                                              hints false (no backfill work)
//   memory-embeddings.bin / memory-phrase-embeddings.bin — header'd Float32
//     bins of random UNIT vectors. Unit (not zero) is load-bearing:
//     healPhraseBin treats zero-norm rows as corrupt and would queue N
//     re-embeds; random unit rows read as healthy and the post-init
//     maintenance stays quiet (no mid-test library-updated storms).
//
// Usage: MEMORIES_DATA_DIR=$TMP node scripts/perf-grid-fixture.js [N]
// N defaults to 50000 (GRID_PERF_N overrides when set).

const fs = require("fs");
const os = require("os");
const path = require("path");

const DIM = 128;

async function main() {
	const memoriesDir = process.env.MEMORIES_DATA_DIR;
	if (!memoriesDir) throw new Error("MEMORIES_DATA_DIR is required");
	const n = Number(process.argv[2] || process.env.GRID_PERF_N || 50000);
	if (!Number.isInteger(n) || n <= 0)
		throw new Error(`bad N: ${process.argv[2]}`);
	const t0 = Date.now();

	// DATA_DIR joins userData (= MEMORIES_DATA_DIR) with "library".
	const dataDir = path.join(memoriesDir, "library");
	const photosDir = path.join(dataDir, "photos");
	fs.mkdirSync(photosDir, { recursive: true });

	// One template JPEG, then hard-link it N times (same volume → instant;
	// falls back to copy when linking is unavailable).
	const sharp = (await import("sharp")).default;
	const template = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "scm-grid-template-")),
		"tile.jpg",
	);
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 90, g: 120, b: 160 },
		},
	})
		.jpeg({ quality: 60 })
		.toFile(template);
	const pad = String(n - 1).length;
	const images = new Array(n);
	for (let i = 0; i < n; i++) {
		const name = `perf-${String(i).padStart(pad, "0")}.jpg`;
		images[i] = name;
		const dest = path.join(photosDir, name);
		try {
			fs.linkSync(template, dest);
		} catch {
			fs.copyFileSync(template, dest);
		}
		if (i > 0 && i % 10000 === 0)
			console.log(`[grid-fixture] ${i}/${n} files…`);
	}

	// Newest-first order: perf-000000 is "now", rows age ~10.5 min apart so a
	// 50k library spans ~a year (matches newestMediaFirst expectations).
	const now = Date.now();
	const sourceMtimes = new Array(n);
	for (let i = 0; i < n; i++) sourceMtimes[i] = now - i * 630000;

	const index = {
		images,
		dim: DIM,
		sourceMtimes,
		ocr: new Array(n).fill(""),
		// [] = recognized with no usable words: skips the background OCR
		// geometry upgrade (null would re-queue every row through tesseract).
		ocrWords: new Array(n).fill([]),
		screenshotHints: new Array(n).fill(false),
		ocrRevision: 0,
	};
	fs.writeFileSync(
		path.join(dataDir, "memories-index.json"),
		JSON.stringify(index),
	);

	// Random unit vectors, both bins (see header comment for why unit).
	for (const file of [
		"memory-embeddings.bin",
		"memory-phrase-embeddings.bin",
	]) {
		const buf = Buffer.allocUnsafe(8 + n * DIM * 4);
		buf.writeInt32LE(n, 0);
		buf.writeInt32LE(DIM, 4);
		const floats = new Float32Array(buf.buffer, buf.byteOffset + 8, n * DIM);
		for (let r = 0; r < n; r++) {
			let norm = 0;
			const base = r * DIM;
			for (let k = 0; k < DIM; k++) {
				const v = Math.random() * 2 - 1;
				floats[base + k] = v;
				norm += v * v;
			}
			norm = Math.sqrt(norm) || 1;
			for (let k = 0; k < DIM; k++) floats[base + k] /= norm;
		}
		fs.writeFileSync(path.join(dataDir, file), buf);
		console.log(`[grid-fixture] wrote ${file}`);
	}

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(
		`[grid-fixture] ${n} rows + bins ready in ${elapsed}s (${dataDir})`,
	);
}

main().catch((err) => {
	console.error(`[grid-fixture] FAILED: ${err.message}`);
	process.exit(1);
});
