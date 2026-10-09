"use strict";

// Offline YouTube-agent smoke (ELECTRON_SMOKE_YOUTUBE=1 + an isolated
// MEMORIES_DATA_DIR). No network, no yt-dlp: fixture staging pairs stand in
// for pre-fix downloads, and the REAL prod functions (merge, backfill,
// silent-import repair) run against them through ctx.
//
// Covers the 0.2.6 YouTube-tab failures end to end:
//   A. findInfoJsonFor resolves the .info.json sibling for BOTH the merged
//      shape ("... [id].mp4") and the unmerged intermediate shape
//      ("... [id].f398.mp4") — the lookup bug that left youtube.json empty.
//   B. mergeYoutubeIntermediates fuses a video-only .f398.mp4 + .m4a into a
//      merged mp4 WITH an audio stream (the silent-import root cause).
//   C. backfillYoutubeMeta links staging info.jsons to library rows.
//   D. repairSilentYoutubeImports heals a silent library row from staging
//      audio in place (same filename) and drops its empty transcript row.
//   E. With staging audio gone, the repair clears the archive line so one
//      URL re-paste re-downloads instead of archive-skipping.

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./helpers.js");

function runCmd(bin, args, timeoutMs = 120000) {
	return new Promise((resolve, reject) => {
		const { spawn } = require("child_process");
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		try {
			child.stderr.on("data", (d) => {
				err += String(d);
				if (err.length > 4000) err = err.slice(-4000);
			});
		} catch {
			/* ignore */
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already exited */
			}
			reject(new Error(`fixture ffmpeg timed out: ${args.join(" ")}`));
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0)
				reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`));
			else resolve();
		});
	});
}

async function runYoutubeTest(ctx) {
	const {
		importPaths,
		loadLibrary,
		youtube,
		mergeYoutubeIntermediates,
		backfillYoutubeMeta,
		repairSilentYoutubeImports,
		resolveYtDlpFfmpegLocation,
		PHOTOS_DIR,
	} = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	for (const [name, fn] of Object.entries({
		importPaths,
		loadLibrary,
		youtube,
		mergeYoutubeIntermediates,
		backfillYoutubeMeta,
		repairSilentYoutubeImports,
		resolveYtDlpFfmpegLocation,
		PHOTOS_DIR,
	})) {
		if (fn === undefined || fn === null)
			throw new Error(`youtube smoke ctx missing ${name}`);
	}
	const ffmpegLocation = resolveYtDlpFfmpegLocation();
	if (!ffmpegLocation || !fs.existsSync(ffmpegLocation)) {
		throw new Error(
			`no ffmpeg for yt-dlp merge path: ${ffmpegLocation || "(null)"}`,
		);
	}
	// Fixture ffmpeg: same binary family the prod merge uses.
	let fixtureFfmpeg = ffmpegLocation;
	try {
		const st = fs.statSync(fixtureFfmpeg);
		if (!st.isFile()) throw new Error("not a file");
	} catch {
		fixtureFfmpeg = require("ffmpeg-static");
	}
	const { probeHasAudio } = require("../../indexer/video-utils.js");
	const destDir = youtube.stagingDir();
	ensureDir(destDir);

	const ID_MERGE = "dQw4w9WgXcQ";
	const ID_SILENT = "9bZkp7q19f0";
	const ID_NOAUDIO = "kJQP7kiw5Fk";
	const stem = (id, suffix) => `Smoke Uploader - Smoke Title [${id}]${suffix}`;

	// --- Fixtures: video-only .f398.mp4 + tone .m4a + .info.json per id ---
	for (const id of [ID_MERGE, ID_SILENT]) {
		const video = path.join(destDir, stem(id, ".f398.mp4"));
		const audio = path.join(destDir, stem(id, ".f140.m4a"));
		await runCmd(fixtureFfmpeg, [
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=3:size=128x128:rate=10",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-an",
			video,
		]);
		await runCmd(fixtureFfmpeg, [
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=3",
			"-c:a",
			"aac",
			audio,
		]);
		fs.writeFileSync(
			path.join(destDir, stem(id, ".info.json")),
			JSON.stringify({
				id,
				uploader: "Smoke Uploader",
				title: "Smoke Title",
				webpage_url: `https://www.youtube.com/watch?v=${id}`,
			}),
		);
	}
	// ID_NOAUDIO gets only an .info.json (staging audio gone case).
	fs.writeFileSync(
		path.join(destDir, stem(ID_NOAUDIO, ".info.json")),
		JSON.stringify({
			id: ID_NOAUDIO,
			uploader: "Smoke Uploader",
			title: "Gone Audio",
			webpage_url: `https://www.youtube.com/watch?v=${ID_NOAUDIO}`,
		}),
	);

	// --- A. info.json resolution for both filename shapes ---
	const mergedShape = path.join(destDir, stem(ID_MERGE, ".mp4"));
	const directHit = youtube.findInfoJsonFor(mergedShape, destDir);
	if (!directHit || !directHit.endsWith(`[${ID_MERGE}].info.json`)) {
		throw new Error(`merged-shape info lookup failed: ${directHit}`);
	}
	const interHit = youtube.findInfoJsonFor(
		path.join(destDir, stem(ID_MERGE, ".f398.mp4")),
		destDir,
	);
	if (!interHit || !interHit.endsWith(`[${ID_MERGE}].info.json`)) {
		throw new Error(`intermediate-shape info lookup failed: ${interHit}`);
	}

	// --- B. merge intermediates → single file WITH audio ---
	const merged = await mergeYoutubeIntermediates(destDir, [
		path.join(destDir, stem(ID_MERGE, ".f398.mp4")),
	]);
	if (
		merged.length !== 1 ||
		merged[0] !== path.join(destDir, stem(ID_MERGE, ".mp4"))
	) {
		throw new Error(`merge returned wrong list: ${JSON.stringify(merged)}`);
	}
	if (!(await probeHasAudio(fixtureFfmpeg, merged[0]))) {
		throw new Error("merged output has no audio stream");
	}

	// --- C. import the merged file, then backfill links it ---
	const imp = await importPaths(merged);
	if (imp.added.length !== 1) {
		throw new Error(`merged import failed: ${JSON.stringify(imp)}`);
	}
	const libFilename = imp.added[0];
	if (!libFilename.includes(`[${ID_MERGE}]`)) {
		throw new Error(`imported filename lost the id: ${libFilename}`);
	}
	// Simulate the pre-fix state: youtube.json missing despite the import.
	try {
		fs.unlinkSync(youtube.metaFile());
	} catch {
		/* already absent */
	}
	const backfilled = backfillYoutubeMeta();
	if (backfilled < 1) throw new Error("backfill repaired nothing");
	const metaAfter = youtube.loadYoutubeMeta();
	if (!metaAfter[ID_MERGE] || metaAfter[ID_MERGE].filename !== libFilename) {
		throw new Error(
			`backfill wrong entry: ${JSON.stringify(metaAfter[ID_MERGE])}`,
		);
	}
	if (!youtube.youtubeFilenames().includes(libFilename)) {
		throw new Error(
			"youtubeFilenames missing the backfilled row (tab stays empty)",
		);
	}

	// --- D. silent-import repair: import video-only, heal in place ---
	const silentStaging = path.join(destDir, stem(ID_SILENT, ".f398.mp4"));
	const impSilent = await importPaths([silentStaging]);
	if (impSilent.added.length !== 1) {
		throw new Error(`silent import failed: ${JSON.stringify(impSilent)}`);
	}
	const silentFilename = impSilent.added[0];
	const silentLibPath = path.join(PHOTOS_DIR, silentFilename);
	if (await probeHasAudio(fixtureFfmpeg, silentLibPath)) {
		throw new Error("silent fixture unexpectedly has audio (bad fixture)");
	}
	backfillYoutubeMeta();
	const repair = await repairSilentYoutubeImports();
	if (repair.repaired !== 1) {
		throw new Error(
			`repair should heal exactly 1 row: ${JSON.stringify(repair)}`,
		);
	}
	if (!(await probeHasAudio(fixtureFfmpeg, silentLibPath))) {
		throw new Error("library file still silent after repair");
	}
	// Idempotence: a second pass finds nothing to do.
	const repair2 = await repairSilentYoutubeImports();
	if (repair2.repaired !== 0) {
		throw new Error(`repair not idempotent: ${JSON.stringify(repair2)}`);
	}

	// --- E. staging audio gone → archive cleared for re-download ---
	// A pre-fix silent import whose staging audio has since been cleaned:
	// video-only intermediate in staging, no audio counterpart anywhere.
	// NOTE: byte-distinct from the phase-A/D fixtures (4 s, 160x120):
	// import dedupes by content hash, so an identical-bytes file would be
	// skipped as a duplicate instead of exercising the archive-clear path.
	const noAudioStaging = path.join(destDir, stem(ID_NOAUDIO, ".f398.mp4"));
	await runCmd(fixtureFfmpeg, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc=duration=4:size=160x120:rate=10",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-an",
		noAudioStaging,
	]);
	const impNoAudio = await importPaths([noAudioStaging]);
	if (impNoAudio.added.length !== 1) {
		throw new Error(`no-audio import failed: ${JSON.stringify(impNoAudio)}`);
	}
	backfillYoutubeMeta();
	const metaNoAudio = youtube.loadYoutubeMeta();
	if (!metaNoAudio[ID_NOAUDIO]) {
		throw new Error("backfill missed the no-audio row");
	}
	const archiveFile = youtube.archiveFileFor(destDir);
	fs.appendFileSync(archiveFile, `youtube ${ID_NOAUDIO}\n`);
	const repair3 = await repairSilentYoutubeImports();
	if (repair3.clearedForRedownload < 1) {
		throw new Error(
			`missing-audio case should clear the archive: ${JSON.stringify(repair3)}`,
		);
	}
	const archiveLeft = fs.readFileSync(archiveFile, "utf-8");
	if (archiveLeft.includes(ID_NOAUDIO)) {
		throw new Error("archive line was not cleared for re-download");
	}
	// The silent file itself is untouched (nothing to merge with) — the
	// user re-pastes the URL and the fixed downloader merges correctly.
	const noAudioLibPath = path.join(PHOTOS_DIR, impNoAudio.added[0]);
	if (await probeHasAudio(fixtureFfmpeg, noAudioLibPath)) {
		throw new Error("no-audio fixture unexpectedly has audio (bad fixture)");
	}

	console.log(
		"[youtube] merge + info-lookup + backfill + silent-repair + archive-clear all pass",
	);

	// --- F. real download (opt-in via YOUTUBE_REAL_URL): full production
	// path — yt-dlp spawn with --ffmpeg-location, merge, importPaths, the
	// fixed findInfoJsonFor record step — then wait for real transcription
	// so dialogue search has genuine speech evidence. Skipped when unset
	// (CI/battery stay offline).
	const realUrl = process.env.YOUTUBE_REAL_URL;
	if (realUrl) {
		await runRealDownloadPhase(ctx, realUrl, fixtureFfmpeg);
	} else {
		console.log("[youtube] YOUTUBE_REAL_URL unset — skipping live download");
	}
}

async function runRealDownloadPhase(ctx, url, fixtureFfmpeg) {
	const { runYoutubeJob, loadLibrary, youtube } = ctx;
	const { probeHasAudio } = require("../../indexer/video-utils.js");
	const parsed = youtube.parseYouTubeInput(url);
	if (parsed.kind !== "video") {
		throw new Error(`YOUTUBE_REAL_URL is not a video URL: ${url}`);
	}
	console.log(`[youtube] live download: ${url}`);
	const res = await runYoutubeJob({ kind: "video", url });
	if (!res.ok) throw new Error(`live download failed: ${res.error}`);
	if (!Array.isArray(res.files) || res.files.length !== 1) {
		throw new Error(
			`live download should yield 1 file: ${JSON.stringify(res.files)}`,
		);
	}
	const staged = res.files[0];
	if (youtube.isIntermediateStreamFile(require("path").basename(staged))) {
		throw new Error(`live download left an unmerged intermediate: ${staged}`);
	}
	if (!(await probeHasAudio(fixtureFfmpeg, staged))) {
		throw new Error("live download has no audio stream (merge failed)");
	}
	// The fixed record step must have written youtube.json in the job
	// (entries are keyed by video id; the value carries the filename).
	const lib = loadLibrary();
	const idx = (lib.sources || []).findIndex((s) => s === staged);
	if (idx < 0) throw new Error("live download missing from library sources");
	const filename = lib.filenames[idx];
	const meta = youtube.loadYoutubeMeta();
	const found = Object.entries(meta).find(
		([, v]) => v && v.filename === filename,
	);
	if (!found) {
		throw new Error(`youtube.json missing live entry for ${filename}`);
	}
	if (found[0] !== parsed.id) {
		throw new Error(
			`live entry keyed by wrong id: ${found[0]} (want ${parsed.id})`,
		);
	}
	console.log(`[youtube] live import ok: ${filename} (id ${found[0]})`);
	// Wait for genuine transcription (whisper on real speech). The import
	// enqueues it; poll the sidecar for a non-empty row.
	const fs = require("fs");
	const path = require("path");
	const dataDir = process.env.MEMORIES_DATA_DIR;
	const sidecar = path.join(
		dataDir,
		"library",
		`memory-transcripts-${lib.modelId}.json`,
	);
	const t0 = Date.now();
	for (;;) {
		try {
			const parsedSidecar = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
			const row = (parsedSidecar.videos || []).find(
				(v) => v.filename === filename,
			);
			if (row && Array.isArray(row.chunks) && row.chunks.length > 0) {
				const first = row.chunks[0];
				console.log(
					`[youtube] live transcription ok: ${row.chunks.length} chunk(s), first: ${(first.text || "").slice(0, 120)}`,
				);
				return;
			}
		} catch {
			/* sidecar not written yet */
		}
		if (Date.now() - t0 > 15 * 60 * 1000) {
			throw new Error("timed out waiting for live transcription (15m)");
		}
		await new Promise((r) => setTimeout(r, 10000));
	}
}

module.exports = { runYoutubeTest };
