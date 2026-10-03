"use strict";

// Model-switch smoke (ELECTRON_SMOKE_MIGRATE=1, ELECTRON_SMOKE_MIGRATE_TO
// defaulting to siglip-base-patch16-384): import two known-color photos under
// the CLIP default, migrate the library to the target model, verify ranking,
// persisted bins, calibration, and that the source model's bins survive for
// a switch-back — then switch back and verify again. Must run with a temp
// MEMORIES_DATA_DIR.
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx.

const fs = require("fs");
const path = require("path");
const { solidJpg } = require("./helpers.js");

async function runMigrateTest(ctx) {
	const {
		getModel,
		app,
		importPaths,
		loadLibrary,
		askIndexer,
		cosine,
		reembedToModel,
		migrationSettled,
		binInfo,
		thresholdsFor,
		modelDownloaded,
		embedFileFor,
		preloadAllModels,
	} = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error(
			"ELECTRON_SMOKE_MIGRATE requires MEMORIES_DATA_DIR (a temp dir)",
		);
	}
	const target =
		process.env.ELECTRON_SMOKE_MIGRATE_TO || "siglip-base-patch16-384";
	if (!getModel(target)) throw new Error(`Unknown migrate target: ${target}`);

	const tmp = fs.mkdtempSync(
		path.join(app.getPath("temp"), "memories-migrate-"),
	);
	const blue = path.join(tmp, "blue-square.jpg");
	const red = path.join(tmp, "red-square.jpg");
	await solidJpg(tmp, "blue-square.jpg", [40, 80, 220], 96);
	await solidJpg(tmp, "red-square.jpg", [220, 60, 50], 96);

	// A video row is the migration's sharpest edge: it must be re-embedded
	// through the ffmpeg path (embed-video), never decoded as a photo. This
	// test imports one so the video-migration regression is caught here.
	let haveVideo = false;
	const videoPath = path.join(tmp, "green-clip.mp4");
	try {
		const ffmpeg = require("../../indexer/video-utils.js").resolveFfmpeg();
		const cp = require("child_process");
		const gen = cp.spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=96x96:d=2",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				videoPath,
			],
			{ encoding: "utf8" },
		);
		haveVideo = gen.status === 0 && fs.existsSync(videoPath);
		if (!haveVideo)
			console.warn("[migrate] video generation failed; skipping video checks");
	} catch {
		console.warn("[migrate] no ffmpeg; skipping video checks");
	}

	const files = [blue, red, ...(haveVideo ? [videoPath] : [])];
	const expect = files.length;
	const res = await importPaths(files);
	if (res.added.length !== expect) {
		throw new Error(`migrate import failed: ${JSON.stringify(res)}`);
	}

	let l = loadLibrary();
	const startModel = l.modelId;
	if (target === startModel) {
		throw new Error(
			`ELECTRON_SMOKE_MIGRATE_TO (${target}) must differ from the library's model (${startModel})`,
		);
	}
	const startDim = l.dim;
	console.log(
		`[migrate] imported ${expect} files under ${startModel} (dim ${startDim})`,
	);

	const ranked = async (query) => {
		const q = await askIndexer({ type: "embed-query", text: query });
		if (!q.vec) throw new Error(`query embed failed: ${query}`);
		const scores = l.filenames
			.map((filename, i) => ({
				filename,
				score: cosine(q.vec, l.embeddings[i]),
			}))
			.sort((a, b) => b.score - a.score);
		return { top: scores[0].filename, scores };
	};

	const before = await ranked("a blue square");
	if (!before.top.includes("blue-square")) {
		throw new Error(
			`pre-migration ranking wrong: ${JSON.stringify(before.scores)}`,
		);
	}
	console.log(`[migrate] pre-migration "a blue square" → ${before.top}`);

	// The switch itself: respawns the pool in the target model, re-embeds
	// every row, flips the index, calibrates thresholds.
	const out = await reembedToModel(target);
	// A delta switch resolves at the flip (reused rows + background tail):
	// wait for the tail before asserting settled state. The settled total is
	// reused + filled, which must equal the full row count.
	if (out.delta) {
		await migrationSettled();
		const settled = (out.reused || 0) + (out.pending || 0);
		if (settled !== expect) {
			throw new Error(
				`delta migration covered ${settled}/${expect}: ${JSON.stringify(out)}`,
			);
		}
	} else if (out.reembedded !== expect) {
		throw new Error(
			`migration reembedded ${out.reembedded}/${expect}: ${JSON.stringify(out.failures)}`,
		);
	}
	l = loadLibrary();
	if (l.modelId !== target)
		throw new Error(`modelId not flipped: ${l.modelId}`);
	if (l.filenames.length !== expect || l.embeddings.length !== expect) {
		throw new Error(
			`library rows lost after migration: ${l.filenames.length}/${l.embeddings.length}`,
		);
	}
	// No row may be a zero vector after migration — the video path must have
	// produced real embeddings, not silent failures (the bug this guards).
	for (let i = 0; i < expect; i++) {
		let norm = 0;
		for (let k = 0; k < l.embeddings[i].length; k++)
			norm += l.embeddings[i][k] ** 2;
		if (norm < 1e-4) {
			throw new Error(`row ${l.filenames[i]} is a zero vector after migration`);
		}
	}
	const targetInfo = binInfo(target);
	if (!targetInfo || targetInfo.rows !== expect || targetInfo.dim !== l.dim) {
		throw new Error(
			`target bins wrong after migration: ${JSON.stringify(targetInfo)}`,
		);
	}
	const sourceInfo = binInfo(startModel);
	if (!sourceInfo || sourceInfo.rows !== expect) {
		throw new Error(
			`source model bins lost (switch-back impossible): ${JSON.stringify(sourceInfo)}`,
		);
	}
	if (!thresholdsFor(target)) {
		throw new Error("target thresholds not calibrated after migration");
	}
	console.log(
		`[migrate] ${startModel} → ${target} OK (dim ${l.dim}, reembedded ${out.reembedded}, ` +
			`thresholds ${JSON.stringify(thresholdsFor(target))})`,
	);

	// Ranking must still separate blue from red in the NEW model.
	const after = await ranked("a blue square");
	if (!after.top.includes("blue-square")) {
		throw new Error(
			`post-migration ranking wrong: ${JSON.stringify(after.scores)}`,
		);
	}
	console.log(
		`[migrate] post-migration "a blue square" → ${after.top} (${after.scores[0].score.toFixed(3)})`,
	);

	if (haveVideo) {
		const afterGreen = await ranked("a green square");
		if (!afterGreen.top.includes("green-clip")) {
			throw new Error(
				`post-migration video ranking wrong: ${JSON.stringify(afterGreen.scores)}`,
			);
		}
		console.log(
			`[migrate] post-migration "a green square" → ${afterGreen.top} ` +
				`(${afterGreen.scores[0].score.toFixed(3)})`,
		);
	}

	// Switch back — the undo path a user would take. The start model's bins
	// were written by the original import, so this MUST now flip instantly
	// (reembedded 0) instead of re-embedding — the whole point of the
	// "switching is instant" fast path.
	const back = await reembedToModel(startModel);
	if (back.instant !== true || back.reembedded !== 0) {
		throw new Error(
			`switch-back not instant: reembedded ${back.reembedded}/${expect} (${JSON.stringify(back.failures)})`,
		);
	}
	l = loadLibrary();
	if (l.modelId !== startModel)
		throw new Error(`switch-back modelId wrong: ${l.modelId}`);
	console.log(
		`[migrate] switch-back to ${startModel} instant-flipped OK (dim ${l.dim})`,
	);

	// The core guarantee behind this whole change: switching away and back
	// never loses the ORIGINAL model. Its weights must still be detected as
	// downloaded, and BOTH models' embedding bins must still be on disk.
	if (!modelDownloaded(startModel)) {
		throw new Error(
			`modelDownloaded(${startModel}) false after round-trip — original model lost`,
		);
	}
	if (!fs.existsSync(embedFileFor(target))) {
		throw new Error(
			`target model bin ${embedFileFor(target)} missing after round-trip`,
		);
	}
	if (!fs.existsSync(embedFileFor(startModel))) {
		throw new Error(
			`original model bin ${embedFileFor(startModel)} missing after round-trip`,
		);
	}
	console.log(
		`[migrate] round-trip preserved both models: ${startModel} bin + ${target} bin on disk`,
	);

	// Retirement path: a removed 512-d MobileCLIP library is represented in
	// memory as a pending migration to the live default. It deliberately has
	// the replacement model id already (so its worker can warm), so this must
	// NOT take reembedToModel's normal same-id no-op. Remove the compatible
	// target bin to prove the path actually embeds every row rather than using
	// the instant-switch cache.
	fs.unlinkSync(embedFileFor(startModel));
	l.pendingModelMigration = {
		fromId: "mobileclip2-s2",
		targetId: startModel,
	};
	l.dim = 512;
	l.textMean = null;
	l.embeddings = [];
	l.phrases = [];
	const retired = await reembedToModel(startModel);
	if (retired.reembedded !== expect || retired.failures.length !== 0) {
		throw new Error(
			`retired-model migration failed: ${JSON.stringify(retired)}`,
		);
	}
	if (l.pendingModelMigration !== null || l.dim !== getModel(startModel).dim) {
		throw new Error(
			"retired-model migration did not clear its guard or restore the target dimension",
		);
	}
	console.log(
		`[migrate] retired MobileCLIP compatibility migration → ${startModel} re-embedded ${retired.reembedded}/${expect}`,
	);

	// "Download all models": preloading every model must resolve, mark each
	// as downloaded, and never touch the active library.
	const preloaded = await preloadAllModels();
	for (const r of preloaded) {
		if (r.error) {
			throw new Error(`preload-all failed for ${r.modelId}: ${r.error}`);
		}
		if (r.skipped) continue;
		if (!r.downloaded) {
			throw new Error(
				`preload-all claims ${r.modelId} not downloaded after run`,
			);
		}
	}
	if (loadLibrary().modelId !== startModel) {
		throw new Error("preload-all changed the active model");
	}
	console.log(
		`[migrate] preload-all OK: ${preloaded.map((r) => `${r.modelId}${r.skipped ? " (cached)" : ""}`).join(", ")}`,
	);
	console.log("[migrate] OK");
}

module.exports = { runMigrateTest };
