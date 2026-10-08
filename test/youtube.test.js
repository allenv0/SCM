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

console.log("youtube.test.js: all assertions passed");
