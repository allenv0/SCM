"use strict";

const assert = require("node:assert/strict");
const {
	parseYouTubeInput,
	parseYoutubeConfig,
	parseQuality,
	formatSelectorFor,
	buildVideoArgs,
	buildChannelArgs,
	buildPlaylistArgs,
	buildListArgs,
	isIntermediateStreamFile,
	videoIdFromFilename,
	findInfoJsonFor,
	DEFAULT_CONFIG,
} = require("../main-lib/youtube.js");

// --- URL parsing ---
assert.equal(
	parseYouTubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind,
	"video",
);
assert.equal(
	parseYouTubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ").id,
	"dQw4w9WgXcQ",
);
assert.equal(parseYouTubeInput("https://youtu.be/dQw4w9WgXcQ").kind, "video");
assert.equal(
	parseYouTubeInput("https://www.youtube.com/shorts/dQw4w9WgXcQ").kind,
	"video",
);
assert.equal(
	parseYouTubeInput("https://www.youtube.com/@SomeChannel").kind,
	"channel",
);
assert.equal(parseYouTubeInput("@SomeChannel").kind, "channel");
assert.equal(
	parseYouTubeInput("https://www.youtube.com/channel/UC123").kind,
	"channel",
);
assert.equal(parseYouTubeInput("dQw4w9WgXcQ").kind, "video");
assert.equal(parseYouTubeInput("https://example.com/x").kind, "unknown");
assert.equal(parseYouTubeInput("").kind, "unknown");
assert.equal(parseYouTubeInput(null).kind, "unknown");

// --- playlists: real lists only ---
assert.equal(
	parseYouTubeInput("https://www.youtube.com/playlist?list=PL1234567890abcd")
		.kind,
	"playlist",
);
assert.equal(
	parseYouTubeInput("https://www.youtube.com/playlist").kind,
	"unknown",
);
assert.equal(
	parseYouTubeInput("https://www.youtube.com/results?search_query=cats").kind,
	"unknown",
);
assert.equal(
	parseYouTubeInput("https://www.youtube.com/feed/subscriptions").kind,
	"unknown",
);

// --- config ---
assert.deepEqual(parseYoutubeConfig(null), DEFAULT_CONFIG);
assert.equal(parseYoutubeConfig({ quality: "1080p" }).quality, "1080p");
assert.equal(parseYoutubeConfig({ quality: "bogus" }).quality, "720p");
assert.equal(parseQuality("480p"), "480p");
assert.equal(parseQuality("xx"), "720p");
const cfg = parseYoutubeConfig({
	maxPerChannel: 9999,
	channels: [{ url: "https://www.youtube.com/@a", label: "A" }, { url: "" }],
});
assert.equal(cfg.maxPerChannel, 200);
assert.equal(cfg.channels.length, 1);
// Subscription records keep their kind (channels + playlists alike).
const cfg2 = parseYoutubeConfig({
	channels: [
		{ url: "https://www.youtube.com/@a" },
		{ url: "https://www.youtube.com/playlist?list=PL123" },
	],
});
assert.equal(cfg2.channels[0].kind, "channel");
assert.equal(cfg2.channels[1].kind, "playlist");

// --- argv builders ---
assert.ok(formatSelectorFor("720p").includes("height<=720"));
assert.ok(formatSelectorFor("bogus").includes("height<=720"));
const vArgs = buildVideoArgs({
	url: "https://www.youtube.com/watch?v=abc",
	destDir: "/tmp/yt",
	quality: "720p",
	archiveFile: "/tmp/yt/.yt-dlp-archive.txt",
});
assert.ok(vArgs.includes("--no-playlist"));
assert.ok(vArgs.includes("--write-info-json"));
assert.ok(vArgs.includes("--download-archive"));
assert.ok(vArgs.includes("https://www.youtube.com/watch?v=abc"));

const cArgs = buildChannelArgs({
	url: "https://www.youtube.com/@a",
	destDir: "/tmp/yt",
	quality: "480p",
	archiveFile: null,
	max: 5,
});
assert.ok(cArgs.includes("--playlist-end"));
assert.equal(cArgs[cArgs.indexOf("--playlist-end") + 1], "5");
assert.ok(!cArgs.includes("--download-archive"));

// Playlists take the list path too — never the single-video --no-playlist.
const pArgs = buildPlaylistArgs({
	url: "https://www.youtube.com/playlist?list=PL123",
	destDir: "/tmp/yt",
	quality: "720p",
	archiveFile: "/tmp/yt/.yt-dlp-archive.txt",
	max: 10,
});
assert.ok(!pArgs.includes("--no-playlist"));
assert.ok(pArgs.includes("--playlist-end"));
assert.equal(pArgs[pArgs.indexOf("--playlist-end") + 1], "10");
assert.ok(pArgs.includes("--download-archive"));
assert.deepEqual(
	buildListArgs({
		url: "https://www.youtube.com/@a",
		destDir: "/tmp/yt",
		quality: "720p",
		archiveFile: null,
		max: 3,
	}),
	buildChannelArgs({
		url: "https://www.youtube.com/@a",
		destDir: "/tmp/yt",
		quality: "720p",
		archiveFile: null,
		max: 3,
	}),
);

// --- ffmpeg-location (GUI PATH fix): yt-dlp must merge even when ffmpeg
// is not on the Finder's PATH, or downloads land as silent .fXXX video-only
// files with zero transcript chunks.
const ffArgs = buildVideoArgs({
	url: "https://www.youtube.com/watch?v=abc",
	destDir: "/tmp/yt",
	quality: "720p",
	archiveFile: null,
	ffmpegLocation: "/opt/homebrew/bin/ffmpeg",
});
assert.ok(ffArgs.includes("--ffmpeg-location"));
assert.equal(
	ffArgs[ffArgs.indexOf("--ffmpeg-location") + 1],
	"/opt/homebrew/bin/ffmpeg",
);
const noFfArgs = buildVideoArgs({
	url: "https://www.youtube.com/watch?v=abc",
	destDir: "/tmp/yt",
	quality: "720p",
	archiveFile: null,
});
assert.ok(!noFfArgs.includes("--ffmpeg-location"));
const ffList = buildListArgs({
	url: "https://www.youtube.com/@a",
	destDir: "/tmp/yt",
	quality: "720p",
	archiveFile: null,
	max: 3,
	ffmpegLocation: "/x/ffmpeg",
});
assert.ok(ffList.includes("--ffmpeg-location"));

// --- intermediate stream detection + info.json resolution ---
assert.equal(
	isIntermediateStreamFile("Uploader - Title [dQw4w9WgXcQ].f398.mp4"),
	true,
);
assert.equal(
	isIntermediateStreamFile("Uploader - Title [dQw4w9WgXcQ].f140-10.m4a"),
	true,
);
assert.equal(
	isIntermediateStreamFile("Uploader - Title [dQw4w9WgXcQ].mp4"),
	false,
);
assert.equal(
	videoIdFromFilename("Uploader - Title [dQw4w9WgXcQ].f398.mp4"),
	"dQw4w9WgXcQ",
);
assert.equal(videoIdFromFilename("no-id-here.mp4"), null);
// findInfoJsonFor handles the .fXXX intermediate shape: sibling lookup
// strips only the last extension first, then the stream suffix.
{
	const fs = require("fs");
	const os = require("os");
	const path = require("path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-info-"));
	const info = path.join(dir, "Uploader - Title [dQw4w9WgXcQ].info.json");
	fs.writeFileSync(info, JSON.stringify({ id: "dQw4w9WgXcQ" }));
	assert.equal(
		findInfoJsonFor(path.join(dir, "Uploader - Title [dQw4w9WgXcQ].mp4"), dir),
		info,
	);
	assert.equal(
		findInfoJsonFor(
			path.join(dir, "Uploader - Title [dQw4w9WgXcQ].f398.mp4"),
			dir,
		),
		info,
	);
	fs.rmSync(dir, { recursive: true, force: true });
}

// --- main-process wiring (source-text contract: the offline electron smoke
// in scripts/e2e/youtube.js drives the real functions; these asserts pin
// the seams it needs so a rename breaks here, not silently in the smoke).
{
	const path = require("path");
	const main = require("fs").readFileSync(
		path.join(__dirname, "..", "main.js"),
		"utf-8",
	);
	for (const seam of [
		"function mergeVideoAudio(",
		"function mergeYoutubeIntermediates(",
		"function backfillYoutubeMeta(",
		"function repairSilentYoutubeImports(",
		"function resolveYtDlpFfmpegLocation(",
		"--ffmpeg-location",
		"findInfoJsonFor(f, destDir)",
		"await repairSilentYoutubeImports()",
		"process.env.ELECTRON_SMOKE_YOUTUBE",
		"runYoutubeTest({",
		"runYoutubeJob,",
	]) {
		assert.ok(main.includes(seam), `main.js missing wiring: ${seam}`);
	}
	const e2e = require("fs").readFileSync(
		path.join(__dirname, "..", "scripts", "e2e", "youtube.js"),
		"utf-8",
	);
	assert.ok(e2e.includes("runYoutubeTest"), "e2e driver missing");
	const battery = require("fs").readFileSync(
		path.join(__dirname, "..", "scripts", "smoke-all.sh"),
		"utf-8",
	);
	assert.ok(
		battery.includes("ELECTRON_SMOKE_YOUTUBE=1"),
		"battery missing youtube step",
	);
}

console.log("youtube.test.js: all assertions passed");
