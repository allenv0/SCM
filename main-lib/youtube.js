"use strict";

// YouTube video agent core (feat/youtube-agent).
// Pure helpers + settings IO for yt-dlp downloads. No electron dependency:
// plain-node unit tested. The main process owns spawning; the renderer owns
// interest matching (saved searches with watch:true) over indexed rows.
//
// Storage:
//   <userData>/library/youtube-staging/   download scratch (yt-dlp writes here)
//   <userData>/library/youtube.json       videoId -> { filename, channel, ... }
// Settings live under settings.json `youtube` key (see DEFAULT_CONFIG).

const fs = require("fs");
const path = require("path");

const YTDLP_PINNED_VERSION = "2026.08.19";
const YTDLP_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download";

// v1 defaults: 720p keeps scene/Whisper costs near the Balanced preset;
// backfill is capped so adding a big channel never floods the library.
const DEFAULT_CONFIG = {
	enabled: true,
	ytDlpVersion: YTDLP_PINNED_VERSION,
	quality: "720p",
	maxPerChannel: 20,
	pollHours: 6,
	storageCapGB: 20,
	channels: [],
};

const QUALITY_HEIGHT = {
	"480p": 480,
	"720p": 720,
	"1080p": 1080,
};

function parseQuality(raw) {
	if (typeof raw === "string" && QUALITY_HEIGHT[raw]) return raw;
	return DEFAULT_CONFIG.quality;
}

function heightForQuality(q) {
	return QUALITY_HEIGHT[parseQuality(q)];
}

// settings.json IO delegates to main-lib/settings.js (injected root via
// initYoutube). Kept here so main.js never hand-rolls the youtube key shape.
let USER_DATA_DIR = null;
function initYoutube({ userDataDir }) {
	USER_DATA_DIR = userDataDir;
}

function stagingDir() {
	if (!USER_DATA_DIR) throw new Error("youtube: initYoutube() not called");
	return path.join(USER_DATA_DIR, "library", "youtube-staging");
}

function metaFile() {
	if (!USER_DATA_DIR) throw new Error("youtube: initYoutube() not called");
	return path.join(USER_DATA_DIR, "library", "youtube.json");
}

function binDir() {
	if (!USER_DATA_DIR) throw new Error("youtube: initYoutube() not called");
	return path.join(USER_DATA_DIR, "bin");
}

function binPath() {
	return path.join(binDir(), "yt-dlp");
}

function parseYoutubeConfig(raw) {
	const out = { ...DEFAULT_CONFIG, channels: [] };
	if (!raw || typeof raw !== "object") return out;
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.ytDlpVersion === "string" && raw.ytDlpVersion)
		out.ytDlpVersion = raw.ytDlpVersion;
	out.quality = parseQuality(raw.quality);
	if (Number.isFinite(Number(raw.maxPerChannel))) {
		out.maxPerChannel = Math.min(
			200,
			Math.max(1, Math.floor(Number(raw.maxPerChannel))),
		);
	}
	if (Number.isFinite(Number(raw.pollHours))) {
		out.pollHours = Math.min(168, Math.max(1, Number(raw.pollHours)));
	}
	if (Number.isFinite(Number(raw.storageCapGB))) {
		out.storageCapGB = Math.min(500, Math.max(1, Number(raw.storageCapGB)));
	}
	if (Array.isArray(raw.channels)) {
		for (const c of raw.channels) {
			if (!c || typeof c !== "object") continue;
			if (typeof c.url !== "string" || !c.url.trim()) continue;
			const url = c.url.trim();
			// Subscriptions are channels AND playlists (tracked the same way:
			// each sync pulls the newest N, archive-skipped). Kind persists
			// so the poll timer re-enqueues the right job shape.
			let kind;
			if (c.kind === "channel" || c.kind === "playlist") {
				kind = c.kind;
			} else {
				const parsed = parseYouTubeInput(url);
				kind =
					parsed.kind === "channel" || parsed.kind === "playlist"
						? parsed.kind
						: "channel";
			}
			out.channels.push({
				url,
				kind,
				label:
					typeof c.label === "string" && c.label.trim()
						? c.label.trim().slice(0, 120)
						: url,
				lastSync: typeof c.lastSync === "string" ? c.lastSync : null,
			});
		}
	}
	return out;
}

function readYoutubeConfig(readSettings) {
	try {
		return parseYoutubeConfig(readSettings().youtube);
	} catch {
		return parseYoutubeConfig(null);
	}
}

// ---------------------------------------------------------------------------
// URL parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

function parseYouTubeInput(input) {
	if (typeof input !== "string" || !input.trim())
		return { kind: "unknown", url: "" };
	const url = input.trim();
	let u;
	try {
		// Bare handles / video ids are common paste shapes; normalize to URLs.
		if (/^@[\w._-]{1,64}$/.test(url)) {
			return { kind: "channel", url: `https://www.youtube.com/${url}` };
		}
		if (/^[\w-]{11}$/.test(url) && !url.includes(".") && !url.includes("/")) {
			return {
				kind: "video",
				url: `https://www.youtube.com/watch?v=${url}`,
				id: url,
			};
		}
		u = new URL(url);
	} catch {
		return { kind: "unknown", url };
	}
	const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
	if (
		host !== "youtube.com" &&
		host !== "youtu.be" &&
		host !== "youtube-nocookie.com"
	) {
		return { kind: "unknown", url };
	}
	if (host === "youtu.be") {
		const id = u.pathname.split("/").filter(Boolean)[0];
		if (id) return { kind: "video", url, id };
		return { kind: "unknown", url };
	}
	const p = u.pathname;
	if (p === "/watch" && u.searchParams.get("v")) {
		return { kind: "video", url, id: u.searchParams.get("v") };
	}
	if (p.startsWith("/shorts/")) {
		const id = p.split("/")[2];
		if (id) return { kind: "video", url, id };
	}
	if (p.startsWith("/live/")) {
		const id = p.split("/")[2];
		if (id) return { kind: "video", url, id };
	}
	if (
		p.startsWith("/@") ||
		p.startsWith("/c/") ||
		p.startsWith("/channel/") ||
		p.startsWith("/user/") ||
		p.endsWith("/videos") ||
		p.endsWith("/streams")
	) {
		return { kind: "channel", url };
	}
	// Real playlists only: /playlist without a list= param names no list,
	// and /results (search pages) + /feed/* are not stable sync sources.
	if (p === "/playlist") {
		if (u.searchParams.get("list")) return { kind: "playlist", url };
		return { kind: "unknown", url };
	}
	if (p === "/results" || p.startsWith("/feed/")) {
		return { kind: "unknown", url };
	}
	// Default ambiguous youtube.com URL to channel (subscription intent).
	if (p === "/" || p === "") return { kind: "channel", url };
	return { kind: "unknown", url };
}

// ---------------------------------------------------------------------------
// yt-dlp argv builders (pure, unit-tested). Callers spawn the resolved
// binary with these args; stdout JSON lines are parsed by main.js.
// ---------------------------------------------------------------------------

function formatSelectorFor(quality) {
	const h = heightForQuality(quality);
	return (
		`bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/` +
		`bv*[height<=${h}]+ba/` +
		`b[height<=${h}][ext=mp4]/b[height<=${h}]/b`
	);
}

function outputTemplateFor(destDir) {
	// Channel + id prefix keeps renames stable and dedupe-friendly:
	// "[uploader] title [id].mp4". Restrict-filenames off (SCM handles unicode).
	return path.join(destDir, "%(uploader)s - %(title)s [%(id)s].%(ext)s");
}

// Single video download. Returns argv (without the binary).
function buildVideoArgs({ url, destDir, quality, archiveFile }) {
	const args = [
		"--no-playlist",
		"--merge-output-format",
		"mp4",
		"-f",
		formatSelectorFor(quality),
		"--write-info-json",
		"--no-write-playlist-metafiles",
		"--no-progress",
		"--concurrent-fragments",
		"4",
		"-o",
		outputTemplateFor(destDir),
	];
	if (archiveFile) {
		args.push("--download-archive", archiveFile);
	}
	args.push(url);
	return args;
}

// List sync (channels + playlists): newest-first, capped,
// archive-skipped. --break-match-filter would abort the whole run on first
// archived item for --newest feeds; --max-downloads is the simpler bound
// for v1. Channels and playlists share the shape — both are multi-item
// feeds, and the archive file dedupes across them by video id.
function buildListArgs({ url, destDir, quality, archiveFile, max }) {
	const args = [
		"--merge-output-format",
		"mp4",
		"-f",
		formatSelectorFor(quality),
		"--write-info-json",
		"--no-write-playlist-metafiles",
		"--no-progress",
		"--concurrent-fragments",
		"4",
		"--playlist-end",
		String(Math.min(200, Math.max(1, max || DEFAULT_CONFIG.maxPerChannel))),
		"-o",
		outputTemplateFor(destDir),
	];
	if (archiveFile) {
		args.push("--download-archive", archiveFile);
	}
	args.push(url);
	return args;
}

function buildChannelArgs(opts) {
	return buildListArgs(opts);
}

function buildPlaylistArgs(opts) {
	return buildListArgs(opts);
}

function archiveFileFor(destDir) {
	return path.join(destDir, ".yt-dlp-archive.txt");
}

// youtube.json helpers (videoId -> metadata). Best-effort; a corrupt file
// resets to {} rather than blocking imports.
function loadYoutubeMeta() {
	try {
		const raw = JSON.parse(fs.readFileSync(metaFile(), "utf-8"));
		if (raw && typeof raw === "object") return raw;
		return {};
	} catch {
		return {};
	}
}

function saveYoutubeMeta(meta) {
	try {
		fs.mkdirSync(path.dirname(metaFile()), { recursive: true });
		const tmp = `${metaFile()}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
		fs.renameSync(tmp, metaFile());
	} catch (err) {
		console.warn(`[youtube] meta save failed: ${err.message}`);
	}
}

function recordYoutubeFile({ videoId, filename, channel, pageUrl, title }) {
	if (!videoId || !filename) return;
	const meta = loadYoutubeMeta();
	meta[videoId] = {
		filename,
		channel: channel || null,
		pageUrl: pageUrl || null,
		title: title || null,
		downloadedAt: new Date().toISOString(),
	};
	saveYoutubeMeta(meta);
}

function youtubeFilenames() {
	const meta = loadYoutubeMeta();
	const out = [];
	for (const v of Object.values(meta)) {
		if (v && typeof v.filename === "string") out.push(v.filename);
	}
	return out;
}

module.exports = {
	YTDLP_PINNED_VERSION,
	YTDLP_RELEASE_BASE,
	DEFAULT_CONFIG,
	QUALITY_HEIGHT,
	parseQuality,
	heightForQuality,
	initYoutube,
	stagingDir,
	metaFile,
	binDir,
	binPath,
	parseYoutubeConfig,
	readYoutubeConfig,
	parseYouTubeInput,
	formatSelectorFor,
	outputTemplateFor,
	buildVideoArgs,
	buildChannelArgs,
	buildPlaylistArgs,
	buildListArgs,
	archiveFileFor,
	loadYoutubeMeta,
	saveYoutubeMeta,
	recordYoutubeFile,
	youtubeFilenames,
};
