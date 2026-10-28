// Phase 1 (youtube): pure move of main.js:8254-9231 (2026-10-10).
// No behavior change: same queue, timers, handlers, and channels. Shared
// refs back into main.js (importPaths, PHOTOS_DIR) arrive via
// main/context.js and are read AT CALL TIME (ctx.*), so registration order
// is unchanged. Everything else is required directly — this module never
// requires main.js (no cycle).
import { BrowserWindow } from "electron";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import * as youtube from "../../main-lib/youtube.ts";
import { trackChild } from "../../main-lib/child-registry.ts";
import { readSettings, writeSettings } from "../../main-lib/settings.ts";
import {
	loadLibrary,
	loadTranscripts,
	saveTranscripts,
} from "../../main-lib/library-store.ts";

// ---------------------------------------------------------------------------
// YouTube video agent (feat/youtube-agent): yt-dlp downloads -> importPaths.
// Downloads land in library/youtube-staging, then flow through the existing
// import pipeline (hash-dedupe, embeds, scenes, Whisper, OCR). Matching is
// renderer-side: saved searches with watch:true filter rank results to
// youtube.json filenames and jump to timecodes. Main only downloads,
// imports, and reports status.
// ---------------------------------------------------------------------------

interface YoutubeJob {
	jobId: string;
	kind: string;
	url: string;
	label: string;
	status: string;
	error: string | null;
	files: string[];
}

interface YoutubeQueueEntry {
	jobId: string;
	kind: string;
	url: string;
	label: string;
}

const youtubeJobs = new Map<string, YoutubeJob>(); // jobId -> { jobId, kind, url, label, status, error?, files? }
const youtubeQueue: YoutubeQueueEntry[] = []; // [{ jobId, kind, url, label }]
let youtubeInFlight = false;
let youtubePollTimer: NodeJS.Timeout | null = null;

function youtubeBroadcast() {
	try {
		const payload = youtubeStatus();
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", payload);
		}
	} catch {
		/* broadcast is best-effort */
	}
}

function youtubeStatus() {
	let cfg: any;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		cfg = youtube.parseYoutubeConfig(null);
	}
	return {
		type: "youtube",
		phase: youtubeInFlight ? "downloading" : "idle",
		pending: youtubeQueue.length,
		active: youtubeInFlight,
		jobs: [...youtubeJobs.values()].slice(-20),
		channels: cfg.channels,
		quality: cfg.quality,
		enabled: cfg.enabled,
		maxPerChannel: cfg.maxPerChannel,
		pollHours: cfg.pollHours,
		storageCapGB: cfg.storageCapGB,
		binaryReady: youtubeBinaryReady(),
	};
}

function youtubeBinaryReady() {
	try {
		if (fs.existsSync(youtube.binPath())) return true;
	} catch {
		/* fall through to PATH check */
	}
	for (const p of ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"]) {
		try {
			if (fs.existsSync(p)) return true;
		} catch {
			/* next */
		}
	}
	return false;
}

function resolveYtDlpBinary() {
	// Prefer the app-managed pinned binary; fall back to a system yt-dlp
	// (Homebrew) so existing installs work before the first fetch.
	try {
		const managed = youtube.binPath();
		if (fs.existsSync(managed)) return managed;
	} catch {
		/* fall through */
	}
	for (const p of [
		"/opt/homebrew/bin/yt-dlp",
		"/usr/local/bin/yt-dlp",
		"yt-dlp",
	]) {
		try {
			if (p !== "yt-dlp" && fs.existsSync(p)) return p;
		} catch {
			/* next */
		}
	}
	return "yt-dlp"; // PATH lookup; spawn reports ENOENT cleanly when absent
}

// ffmpeg location for yt-dlp's --ffmpeg-location: without it a GUI launch
// (Finder PATH without Homebrew) downloads video-only .fXXX.mp4 + .m4a
// intermediates that never merge — importing silent videos with zero
// transcript chunks. Mirrors indexerEnv()'s packaged-ffmpeg preference,
// then ffmpeg-static (dev), then well-known system paths.
function resolveYtDlpFfmpegLocation() {
	try {
		if (
			process.resourcesPath &&
			fs.existsSync(path.join(process.resourcesPath, "ffmpeg"))
		) {
			return path.join(process.resourcesPath, "ffmpeg");
		}
	} catch {
		/* fall through */
	}
	try {
		// Deliberately-lazy require (unchanged): optional dev dependency.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (optional dev dependency — absent in packaged runs)
		const statik = require("ffmpeg-static");
		if (statik && fs.existsSync(statik)) return statik;
	} catch {
		/* fall through */
	}
	for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
		try {
			if (fs.existsSync(p)) return p;
		} catch {
			/* next */
		}
	}
	return null;
}

const YTDLP_VERSION_RE = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const YTDLP_CHECKSUMS = "SHA2-256SUMS";
const YTDLP_MIN_BYTES = 10 * 1024 * 1024;

async function fetchYtDlpSha256(ver: string): Promise<string> {
	const url = `${youtube.YTDLP_RELEASE_BASE}/${ver}/${YTDLP_CHECKSUMS}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "SCM-youtube-agent" },
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`checksum http ${res.status}`);
	const text = await res.text();
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
		if (match?.[1] && match[2]?.trim() === "yt-dlp_macos") {
			return match[1].toLowerCase();
		}
	}
	throw new Error(`checksum missing for yt-dlp_macos ${ver}`);
}

function downloadYtDlpBinary(version: unknown) {
	// Fetch-on-first-use: keeps the DMG small; mirrors the weights/OCR-pack
	// pattern. macOS universal asset; chmod +x only after the SHA-256 in
	// yt-dlp's own SHA2-256SUMS asset matches.
	const ver =
		typeof version === "string" && version
			? version
			: youtube.YTDLP_PINNED_VERSION;
	if (!YTDLP_VERSION_RE.test(ver)) {
		return Promise.resolve({
			ok: false,
			error: `invalid yt-dlp version: ${ver}`,
		});
	}
	const asset = "yt-dlp_macos";
	const url = `${youtube.YTDLP_RELEASE_BASE}/${ver}/${asset}`;
	const dest = youtube.binPath();
	return (async () => {
		let expected: string;
		try {
			expected = await fetchYtDlpSha256(ver);
		} catch (err) {
			return {
				ok: false,
				error: `checksum unavailable — refusing unverified download: ${
					(err as { message?: string }).message || err
				}`,
			};
		}
		return await new Promise<{ ok: boolean; error?: string; path?: string }>(
			(resolve) => {
				try {
					fs.mkdirSync(path.dirname(dest), { recursive: true });
				} catch {
					resolve({ ok: false, error: "mkdir failed" });
					return;
				}
				const tryGet = (u: string, redirects: number) => {
					try {
						// Per-scheme pick: both node builtins, same request API.
						const mod: typeof https | typeof http = u.startsWith("https:")
							? https
							: http;
						const req = mod.get(
							u,
							{ headers: { "User-Agent": "SCM-youtube-agent" } },
							(res: any) => {
								if (
									res.statusCode >= 300 &&
									res.statusCode < 400 &&
									res.headers.location &&
									redirects > 0
								) {
									res.resume();
									tryGet(res.headers.location, redirects - 1);
									return;
								}
								if (res.statusCode !== 200) {
									res.resume();
									resolve({ ok: false, error: `http ${res.statusCode}` });
									return;
								}
								const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
								const out = fs.createWriteStream(tmp, { mode: 0o755 });
								const hash = crypto.createHash("sha256");
								res.on("data", (chunk: Buffer) => hash.update(chunk));
								res.on("error", (err: Error) => {
									try {
										out.destroy();
										fs.unlinkSync(tmp);
									} catch {
										/* best-effort */
									}
									resolve({ ok: false, error: String(err.message || err) });
								});
								res.pipe(out);
								out.on("finish", () => {
									out.close(() => {
										try {
											const size = fs.statSync(tmp).size;
											if (size < YTDLP_MIN_BYTES) {
												throw new Error(
													`binary suspiciously small (${size} bytes)`,
												);
											}
											const actual = hash.digest("hex");
											if (actual !== expected) {
												throw new Error("SHA-256 mismatch");
											}
											fs.chmodSync(tmp, 0o755);
											fs.renameSync(tmp, dest);
											resolve({ ok: true, path: dest });
										} catch (err) {
											try {
												fs.unlinkSync(tmp);
											} catch {
												/* best-effort */
											}
											resolve({
												ok: false,
												error: String(
													(err as { message?: string }).message || err,
												),
											});
										}
									});
								});
								out.on("error", (err) => {
									try {
										fs.unlinkSync(tmp);
									} catch {
										/* best-effort */
									}
									resolve({ ok: false, error: String(err.message || err) });
								});
							},
						);
						req.on("error", (err: { message?: string }) =>
							resolve({ ok: false, error: String(err.message || err) }),
						);
						req.setTimeout(120000, () => {
							try {
								req.destroy(new Error("timeout"));
							} catch {
								/* settled */
							}
						});
					} catch (err) {
						resolve({
							ok: false,
							error: String((err as { message?: string }).message || err),
						});
					}
				};
				tryGet(url, 5);
			},
		);
	})();
}

function enqueueYoutubeJob(kind: string, url: string, label?: string | null) {
	const jobId = `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const job: YoutubeJob = {
		jobId,
		kind,
		url,
		label: label || url,
		status: "queued",
		error: null,
		files: [],
	};
	youtubeJobs.set(jobId, job);
	youtubeQueue.push({ jobId, kind, url, label: job.label });
	pumpYoutubeQueue();
	youtubeBroadcast();
	return job;
}

function pumpYoutubeQueue() {
	if (youtubeInFlight) return;
	const next = youtubeQueue.shift();
	if (!next) return;
	youtubeInFlight = true;
	const job = youtubeJobs.get(next.jobId);
	if (job) job.status = "downloading";
	youtubeBroadcast();
	runYoutubeJob(next)
		.then((res) => {
			const j = youtubeJobs.get(next.jobId);
			if (j) {
				j.status = res.ok ? "done" : "error";
				j.error = res.ok ? null : res.error || "download failed";
				j.files = res.files || [];
			}
		})
		.catch((err) => {
			const j = youtubeJobs.get(next.jobId);
			if (j) {
				j.status = "error";
				j.error = String((err as { message?: string }).message || err);
			}
		})
		.finally(() => {
			youtubeInFlight = false;
			youtubeBroadcast();
			if (youtubeQueue.length > 0) pumpYoutubeQueue();
		});
}

function snapshotStagingFiles(dir: string) {
	const before = new Map<string, number>();
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (!/\.(mp4|mkv|webm|mov|m4v)$/i.test(entry)) continue;
			try {
				before.set(entry, fs.statSync(path.join(dir, entry)).mtimeMs);
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* staging may not exist yet */
	}
	return before;
}

function newStagingFiles(dir: string, before: Map<string, number>) {
	const out: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (!/\.(mp4|mkv|webm|mov|m4v)$/i.test(entry)) continue;
			const full = path.join(dir, entry);
			try {
				const st = fs.statSync(full);
				if (!before.has(entry) || st.mtimeMs > (before.get(entry) as number))
					out.push(full);
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	return out.sort();
}

// Merge yt-dlp pre-merge intermediates (video-only .fXXX.mp4 + audio .m4a)
// into a final merged .mp4 with audio, using the bundled ffmpeg. Returns
// the import list with intermediates replaced by their merged output.
// Groups by [videoId]: when a final merged file already exists for an id,
// its intermediates are dropped (yt-dlp leftovers, never imported as
// silent videos). When only intermediates exist, the largest video stream
// + the audio stream are merged to "<prefix> [id].mp4" (stream-copy video,
// AAC audio). Failures keep the original list — a silent import beats no
// import, and the failure is logged.
// Merge one video-only stream + one audio stream into a single mp4
// (video stream-copied, audio re-encoded to AAC). Resolves when the output
// exists and is non-empty; rejects with the ffmpeg tail otherwise. Shared
// by the download-time intermediate merge and the silent-import repair.
function mergeVideoAudio(
	ffmpegBin: string,
	videoPath: string,
	audioPath: string,
	outPath: string,
) {
	return new Promise<void>((resolveMerge, rejectMerge) => {
		try {
			const child = spawn(
				ffmpegBin,
				[
					"-y",
					"-i",
					videoPath,
					"-i",
					audioPath,
					"-c:v",
					"copy",
					"-c:a",
					"aac",
					"-shortest",
					outPath,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			// Tracked (2026-10-19): a raw spawn here was invisible to
			// runWillQuitCleanup, so a quit mid-merge orphaned the ffmpeg
			// child — the 2026-09-28 lesson, in the main process.
			trackChild(child, "yt-merge-ffmpeg");
			let errText = "";
			try {
				child.stderr.on("data", (d: unknown) => {
					errText += String(d);
					if (errText.length > 2000) errText = errText.slice(-2000);
				});
			} catch {
				/* ignore */
			}
			const timer = setTimeout(
				() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already exited */
					}
					rejectMerge(new Error("ffmpeg merge timed out"));
				},
				1000 * 60 * 20,
			);
			child.on("error", (err: Error) => {
				clearTimeout(timer);
				rejectMerge(err);
			});
			child.on("close", (code: number) => {
				clearTimeout(timer);
				if (code !== 0) {
					rejectMerge(new Error(`ffmpeg exit ${code}: ${errText.slice(-300)}`));
					return;
				}
				try {
					if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
						resolveMerge();
					} else {
						rejectMerge(new Error("merge produced no output"));
					}
				} catch (err) {
					rejectMerge(err);
				}
			});
		} catch (err) {
			rejectMerge(err);
		}
	});
}

async function mergeYoutubeIntermediates(destDir: string, files: string[]) {
	const byId = new Map<string, string[]>();
	for (const f of files) {
		const id = youtube.videoIdFromFilename(f);
		if (!id) continue;
		let group = byId.get(id);
		if (!group) {
			group = [];
			byId.set(id, group);
		}
		group.push(f);
	}
	if (byId.size === 0) return files;
	let ffmpeg: string | null;
	try {
		ffmpeg = resolveYtDlpFfmpegLocation();
		if (ffmpeg && !fs.existsSync(ffmpeg)) ffmpeg = null;
	} catch {
		ffmpeg = null;
	}
	const out: string[] = [];
	let mergedAny = false;
	for (const [id, group] of byId) {
		const finals = group.filter((f) => !youtube.isIntermediateStreamFile(f));
		if (finals.length > 0) {
			// Merged output exists — drop the intermediates for this id.
			out.push(...finals);
			continue;
		}
		// Only intermediates: pick the video + audio streams.
		const videos = group
			.filter((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f))
			.sort((a, b) => {
				try {
					return fs.statSync(b).size - fs.statSync(a).size;
				} catch {
					return 0;
				}
			});
		let audios: string[] = [];
		try {
			for (const entry of fs.readdirSync(destDir)) {
				if (!/\.(m4a|opus|mp3|aac|webm)$/i.test(entry)) continue;
				if (!entry.includes(`[${id}]`)) continue;
				const full = path.join(destDir, entry);
				try {
					if (fs.statSync(full).isFile()) audios.push(full);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* destDir unreadable */
		}
		audios = audios.sort((a, b) => {
			try {
				return fs.statSync(b).size - fs.statSync(a).size;
			} catch {
				return 0;
			}
		});
		const video = videos[0];
		const audio = audios[0];
		if (!video || !audio || !ffmpeg) {
			out.push(...group);
			continue;
		}
		const mergedName = path
			.basename(video)
			.replace(/\.f\d+[^.]*(\.[^.]+)$/, "$1");
		const finalName =
			mergedName === path.basename(video)
				? path.basename(video).replace(/\.[^.]+$/, ".mp4")
				: mergedName;
		const mergedPath = path.join(destDir, finalName);
		try {
			if (!fs.existsSync(mergedPath) || fs.statSync(mergedPath).size === 0) {
				await mergeVideoAudio(ffmpeg, video, audio, mergedPath);
				console.log(
					`[youtube] merged intermediates for [${id}] → ${finalName}`,
				);
			}
			out.push(mergedPath);
			mergedAny = true;
			// Remove the video-only intermediate so a later job never
			// imports the silent stream by mistake (audio + info stay).
			for (const f of group) {
				if (f === mergedPath) continue;
				if (/\.f\d+[^.]*\.(mp4|mkv|webm|mov|m4v)$/i.test(path.basename(f))) {
					try {
						fs.unlinkSync(f);
					} catch {
						/* best-effort */
					}
				}
			}
		} catch (err) {
			console.warn(
				`[youtube] merge failed for [${id}]: ${(err as { message?: string }).message}`,
			);
			out.push(...group);
		}
	}
	// Files without a parsable [id] pass through untouched.
	for (const f of files) {
		if (!youtube.videoIdFromFilename(f)) out.push(f);
	}
	return mergedAny ? [...new Set(out)].sort() : files;
}

// Backfill youtube.json for videos downloaded before the metadata fix
// (or imported while the record step missed the .info.json sibling).
// Scans staging *.info.json files, matches each id against library
// filenames containing "[id]", and records { filename, channel, ... }.
// Runs at startup and lazily on youtube-files; returns the repair count.
function backfillYoutubeMeta() {
	let repaired = 0;
	try {
		const destDir = youtube.stagingDir();
		const meta: Record<string, any> = youtube.loadYoutubeMeta();
		const knownFilenames = new Set(
			Object.values(meta).map((v) => v && v.filename),
		);
		let infos: string[] = [];
		try {
			infos = fs.readdirSync(destDir).filter((e) => e.endsWith(".info.json"));
		} catch {
			return 0;
		}
		let lib: ReturnType<typeof loadLibrary> | null = null;
		try {
			lib = loadLibrary();
		} catch {
			lib = null;
		}
		const libFilenames = (lib && lib.filenames) || [];
		for (const entry of infos) {
			let info: {
				id?: unknown;
				uploader?: string | null;
				channel?: string | null;
				webpage_url?: string | null;
				title?: string | null;
			} | null = null;
			try {
				info = JSON.parse(fs.readFileSync(path.join(destDir, entry), "utf-8"));
			} catch {
				continue;
			}
			if (!info || !info.id) continue;
			const id = String(info.id);
			if (meta[id]) continue;
			const needle = `[${id}]`;
			const match =
				libFilenames.find((n: unknown) => String(n).includes(needle)) ||
				[...knownFilenames].find((n) => String(n).includes(needle));
			// Fall back to the merged output name even when the library row
			// still carries the old .fXXX intermediate filename.
			let filename: string | null = match || null;
			if (!filename) {
				try {
					const candidates = fs
						.readdirSync(destDir)
						.filter((e) => e.includes(needle));
					const merged = candidates.find(
						(e) =>
							/\.(mp4|mkv|webm|mov|m4v)$/i.test(e) &&
							!youtube.isIntermediateStreamFile(e),
					);
					if (merged) filename = merged;
				} catch {
					/* ignore */
				}
			}
			if (!filename) continue;
			// Only record rows that actually exist in the library (or are
			// the merged staging output waiting for import) — never ghosts.
			const inLibrary = (libFilenames as string[]).includes(filename);
			let stagingExists = false;
			try {
				stagingExists = fs.existsSync(path.join(destDir, filename));
			} catch {
				/* ignore */
			}
			if (!inLibrary && !stagingExists) continue;
			youtube.recordYoutubeFile({
				videoId: id,
				filename,
				channel: info.uploader || info.channel || null,
				pageUrl: info.webpage_url || null,
				title: info.title || null,
			});
			repaired++;
		}
		if (repaired > 0) {
			console.log(
				`[youtube] backfilled ${repaired} video(s) into youtube.json`,
			);
		}
	} catch (err) {
		console.warn(
			`[youtube] backfill failed: ${(err as { message?: string }).message}`,
		);
	}
	return repaired;
}

// Repair YouTube library rows imported as silent video-only files (the
// pre-fix downloads that never merged: .fXXX.mp4 with no audio stream, so
// transcription recorded zero chunks and dialogue search is empty for
// them). For each youtube.json row whose library file has no audio:
//   - staging audio present  → merge (stream-copy video + AAC) into a temp
//     file, verify it has audio, then replace the library file IN PLACE
//     (same filename, so index/embeddings/segments stay aligned) and drop
//     the empty transcript row so backfillTranscription re-queues it;
//   - staging audio gone     → clear the id from .yt-dlp-archive.txt so one
//     URL re-paste re-downloads fresh (merging correctly now).
// Only youtube.json rows are ever touched — user photos are out of scope —
// and any merge/verify failure keeps the original file. Idempotent: a
// repaired file has audio and is skipped on the next launch. Runs at
// startup after backfillYoutubeMeta, before backfillTranscription.
async function repairSilentYoutubeImports() {
	const result = { repaired: 0, clearedForRedownload: 0 };
	try {
		const destDir = youtube.stagingDir();
		const meta: Record<string, any> = youtube.loadYoutubeMeta();
		const ids = Object.keys(meta);
		if (ids.length === 0) return result;
		const lib = loadLibrary();
		const libSet = new Set(lib.filenames || []);
		let ffmpegBin: string | null = null;
		try {
			ffmpegBin = resolveYtDlpFfmpegLocation();
			if (ffmpegBin && !fs.existsSync(ffmpegBin)) ffmpegBin = null;
		} catch {
			ffmpegBin = null;
		}
		// Lazy require (unchanged): ffmpeg-process is heavy; the probe rides it
		// only when the repair path actually runs.
		let probeHasAudio:
			((ffmpegBin: string, path: string) => Promise<boolean>) | null = null;
		try {
			probeHasAudio =
				// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (ffmpeg-process is heavy; the repair path uses it per-file)
				require("../../indexer/ffmpeg-process.js").probeHasAudio || null;
		} catch {
			probeHasAudio = null;
		}
		if (!ffmpegBin || !probeHasAudio) return result;
		for (const id of ids) {
			const row = meta[id];
			const filename =
				row && typeof row.filename === "string" ? row.filename : null;
			if (!filename || !libSet.has(filename)) continue;
			const libPath = path.join(ctx.photosDir, filename);
			let hasAudio = false;
			try {
				hasAudio = await probeHasAudio(ffmpegBin, libPath);
			} catch {
				continue;
			}
			if (hasAudio) continue;
			// Silent YouTube import — find the staging audio for this id.
			let audio: string | null = null;
			try {
				const candidates: string[] = [];
				for (const entry of fs.readdirSync(destDir)) {
					if (!/\.(m4a|opus|mp3|aac|webm)$/i.test(entry)) continue;
					if (!entry.includes(`[${id}]`)) continue;
					const full = path.join(destDir, entry);
					try {
						if (fs.statSync(full).isFile()) candidates.push(full);
					} catch {
						/* ignore */
					}
				}
				candidates.sort((a, b) => {
					try {
						return fs.statSync(b).size - fs.statSync(a).size;
					} catch {
						return 0;
					}
				});
				audio = candidates[0] || null;
			} catch {
				audio = null;
			}
			if (!audio) {
				// No audio left to merge with — clear the archive line so a
				// re-paste of the URL re-downloads instead of archive-skipping.
				try {
					const archiveFile = youtube.archiveFileFor(destDir);
					const raw = fs.readFileSync(archiveFile, "utf-8");
					const kept = raw
						.split("\n")
						.filter((line) => line.trim() !== "" && !line.includes(id));
					const dropped = raw.split("\n").length - kept.length;
					if (dropped > 0) {
						fs.writeFileSync(archiveFile, kept.join("\n") + "\n");
						result.clearedForRedownload++;
						console.log(
							`[youtube] no staging audio for [${id}] — archive cleared, re-paste the URL to re-download`,
						);
					}
				} catch {
					/* archive missing/unreadable — nothing to clear */
				}
				continue;
			}
			try {
				const tmpOut = path.join(destDir, `.repair-${id}-${Date.now()}.mp4`);
				await mergeVideoAudio(ffmpegBin, libPath, audio, tmpOut);
				let mergedHasAudio = false;
				try {
					mergedHasAudio = await probeHasAudio(ffmpegBin, tmpOut);
				} catch {
					mergedHasAudio = false;
				}
				if (!mergedHasAudio) {
					try {
						fs.unlinkSync(tmpOut);
					} catch {
						/* best-effort */
					}
					console.warn(
						`[youtube] repair merge for [${id}] has no audio — keeping original`,
					);
					continue;
				}
				fs.renameSync(tmpOut, libPath);
				// Drop the poisoned empty transcript row so the transcription
				// backfill re-queues this file (same boot, real audio now).
				try {
					const c = loadTranscripts(loadLibrary().modelId);
					if (c && c.videos instanceof Map) c.videos.delete(filename);
					if (c && c.utterances instanceof Map) c.utterances.delete(filename);
					if (c && c.progress && typeof c.progress === "object")
						delete c.progress[filename];
					void saveTranscripts();
				} catch {
					/* transcript reset is best-effort; backfill still skips empty rows only when present */
				}
				result.repaired++;
				console.log(`[youtube] repaired silent import [${id}] → ${filename}`);
			} catch (err) {
				console.warn(
					`[youtube] repair failed for [${id}]: ${(err as { message?: string }).message}`,
				);
			}
		}
		if (result.repaired > 0 || result.clearedForRedownload > 0) {
			console.log(
				`[youtube] silent-import repair: ${result.repaired} merged, ${result.clearedForRedownload} cleared for re-download`,
			);
		}
	} catch (err) {
		console.warn(
			`[youtube] silent-import repair failed: ${(err as { message?: string }).message}`,
		);
	}
	return result;
}

function runYoutubeJob({ kind, url }: { kind: string; url: string }) {
	return new Promise<{
		ok: boolean;
		error?: string;
		files?: string[];
		imported?: unknown;
	}>((resolve) => {
		let cfg: any;
		try {
			cfg = youtube.readYoutubeConfig(readSettings);
		} catch {
			cfg = youtube.parseYoutubeConfig(null);
		}
		let destDir: string | null = null;
		try {
			destDir = youtube.stagingDir();
			fs.mkdirSync(destDir, { recursive: true });
		} catch (err) {
			resolve({
				ok: false,
				error: `staging mkdir: ${(err as { message?: string }).message}`,
			});
			return;
		}
		const archiveFile = youtube.archiveFileFor(destDir);
		const ffmpegLocation = resolveYtDlpFfmpegLocation();
		// Channels and playlists are both multi-item feeds (list argv);
		// only single videos take the --no-playlist path.
		const args =
			kind === "video"
				? youtube.buildVideoArgs({
						url,
						destDir,
						quality: cfg.quality,
						archiveFile,
						ffmpegLocation,
					})
				: youtube.buildListArgs({
						url,
						destDir,
						quality: cfg.quality,
						archiveFile,
						max: cfg.maxPerChannel,
						ffmpegLocation,
					});
		const before = snapshotStagingFiles(destDir);
		const bin = resolveYtDlpBinary();
		let child: ChildProcess | null = null;
		try {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			// Tracked (2026-10-19): a raw spawn here was invisible to
			// runWillQuitCleanup, so a quit mid-download left yt-dlp running
			// (reparented to PID 1), still downloading into the staging dir.
			trackChild(child, "yt-dlp");
		} catch (err) {
			const e = err as { code?: string; message?: string };
			resolve({
				ok: false,
				error:
					e.code === "ENOENT"
						? "yt-dlp not installed"
						: String(e.message || err),
			});
			return;
		}
		let tail = "";
		const onData = (d: unknown) => {
			tail += String(d);
			if (tail.length > 8000) tail = tail.slice(-8000);
		};
		try {
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
		} catch {
			/* ignore */
		}
		const timer = setTimeout(
			() => {
				try {
					child?.kill("SIGKILL");
				} catch {
					/* already exited */
				}
			},
			1000 * 60 * 60,
		); // 1h hard cap per job
		child.on("error", (err: { code?: string; message?: string }) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				error:
					err.code === "ENOENT"
						? "yt-dlp not installed"
						: String(err.message || err),
			});
		});
		child.on("close", async (code: number) => {
			clearTimeout(timer);
			let files = newStagingFiles(destDir as string, before);
			if (code !== 0 && files.length === 0) {
				const hint = tail.trim().split("\n").slice(-3).join(" ").slice(0, 300);
				resolve({ ok: false, error: hint || `yt-dlp exit ${code}` });
				return;
			}
			if (files.length === 0) {
				// Archive-skipped (already downloaded) is a success with no files.
				resolve({ ok: true, files: [] });
				return;
			}
			// Merge fallback: if yt-dlp left unmerged .fXXX intermediates
			// (no ffmpeg at download time), merge each video+audio pair now
			// with the bundled ffmpeg before importing — otherwise the
			// library gets a silent video-only file with zero transcript.
			try {
				const merged = await mergeYoutubeIntermediates(
					destDir as string,
					files,
				);
				if (merged && merged.length > 0) files = merged;
			} catch (err) {
				console.warn(
					`[youtube] intermediate merge failed: ${(err as { message?: string }).message}`,
				);
			}
			try {
				const res = await ctx.importPaths(files);
				// Record videoId metadata from sibling .info.json files
				// (handles both merged and .fXXX intermediate shapes).
				for (const f of files) {
					try {
						const infoPath = youtube.findInfoJsonFor(f, destDir as string);
						if (!infoPath) continue;
						const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
						if (info && info.id) {
							const lib = loadLibrary();
							const idx = lib.sources
								? lib.sources.findIndex((s: unknown) => s === f)
								: -1;
							const filename = idx >= 0 ? lib.filenames[idx] : path.basename(f);
							youtube.recordYoutubeFile({
								videoId: String(info.id),
								filename,
								channel: info.uploader || info.channel || null,
								pageUrl: info.webpage_url || url,
								title: info.title || null,
							});
						}
					} catch {
						/* metadata is best-effort */
					}
				}
				resolve({ ok: true, files, imported: res });
			} catch (err) {
				resolve({
					ok: false,
					error: String((err as { message?: string }).message || err),
					files,
				});
			}
		});
	});
}

function ensureYoutubePollTimer() {
	if (youtubePollTimer) return;
	let cfg: any;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		return;
	}
	if (!cfg.enabled || cfg.channels.length === 0) return;
	const ms = Math.max(1, cfg.pollHours) * 3600 * 1000;
	youtubePollTimer = setInterval(() => {
		try {
			const c: any = youtube.readYoutubeConfig(readSettings);
			if (!c.enabled) return;
			for (const ch of c.channels) {
				enqueueYoutubeJob(
					ch.kind === "playlist" ? "playlist" : "channel",
					ch.url,
					ch.label,
				);
			}
			const next: any = youtube.parseYoutubeConfig({ ...c });
			next.channels = c.channels.map((ch: unknown) => ({
				...(ch as Record<string, unknown>),
				lastSync: new Date().toISOString(),
			}));
			writeSettings({ youtube: next });
		} catch {
			/* polling must never throw */
		}
	}, ms);
	if (youtubePollTimer.unref) youtubePollTimer.unref();
}

handle("memories:youtube-status", () => youtubeStatus());

handle("memories:youtube-ensure-binary", async () => {
	if (youtubeBinaryReady()) return { ok: true, skipped: true };
	let cfg: any;
	try {
		cfg = youtube.readYoutubeConfig(readSettings);
	} catch {
		cfg = youtube.parseYoutubeConfig(null);
	}
	const res = await downloadYtDlpBinary(cfg.ytDlpVersion);
	youtubeBroadcast();
	return res;
});

handle("memories:youtube-add", async (_event: unknown, payload: unknown) => {
	const p = payload as {
		url?: string;
		channel?: string;
		input?: string;
		label?: string;
	} | null;
	const rawUrl = (p && (p.url || p.channel || p.input)) || payload;
	const parsed = youtube.parseYouTubeInput(
		typeof rawUrl === "string" ? rawUrl : "",
	);
	if (parsed.kind !== "channel" && parsed.kind !== "playlist") {
		return { ok: false, error: "not a channel or playlist URL" };
	}
	const cfg: any = youtube.readYoutubeConfig(readSettings);
	if (cfg.channels.some((c: { url: string }) => c.url === parsed.url)) {
		return { ok: true, skipped: true, channels: cfg.channels };
	}
	const label =
		p && typeof p.label === "string" && p.label.trim()
			? p.label.trim().slice(0, 120)
			: parsed.url;
	const next: any = youtube.parseYoutubeConfig({
		...cfg,
		channels: [
			...cfg.channels,
			{ url: parsed.url, kind: parsed.kind, label, lastSync: null },
		],
	});
	writeSettings({ youtube: next });
	enqueueYoutubeJob(parsed.kind, parsed.url, label);
	ensureYoutubePollTimer();
	return { ok: true, channels: next.channels };
});

handle("memories:youtube-remove", async (_event: unknown, url: unknown) => {
	const u = url as string | { url?: string } | null;
	const target = typeof u === "string" ? u : u && u.url;
	if (!target) return { ok: false, error: "Missing channel URL" };
	const cfg: any = youtube.readYoutubeConfig(readSettings);
	const next: any = youtube.parseYoutubeConfig({
		...cfg,
		channels: cfg.channels.filter((c: { url: string }) => c.url !== target),
	});
	writeSettings({ youtube: next });
	return { ok: true, channels: next.channels };
});

handle(
	"memories:youtube-download",
	async (_event: unknown, payload: unknown) => {
		const p = payload as { url?: string; input?: string } | null;
		const rawUrl = (p && (p.url || p.input)) || payload;
		const str = typeof rawUrl === "string" ? rawUrl : "";
		const parsed = youtube.parseYouTubeInput(str);
		if (parsed.kind !== "video") {
			// Channel/playlist URLs route to the subscription path (sync now).
			if (parsed.kind === "channel" || parsed.kind === "playlist") {
				const job = enqueueYoutubeJob(parsed.kind, parsed.url, parsed.url);
				return { ok: true, jobId: job.jobId };
			}
			return { ok: false, error: "not a YouTube video URL" };
		}
		const job = enqueueYoutubeJob("video", parsed.url, parsed.url);
		return { ok: true, jobId: job.jobId };
	},
);

handle(
	"memories:youtube-set-config",
	async (_event: unknown, patch: unknown) => {
		const cur: any = youtube.readYoutubeConfig(readSettings);
		const next: any = youtube.parseYoutubeConfig({
			...cur,
			...(patch && typeof patch === "object" ? patch : {}),
		});
		writeSettings({ youtube: next });
		ensureYoutubePollTimer();
		youtubeBroadcast();
		return { ok: true, config: next };
	},
);

handle("memories:youtube-files", async () => {
	try {
		// Lazily repair youtube.json for downloads that landed before the
		// metadata fix — otherwise the YouTube tab filters to an empty set
		// even though the videos are indexed in the library.
		try {
			backfillYoutubeMeta();
		} catch {
			/* best-effort */
		}
		const meta: Record<string, any> = youtube.loadYoutubeMeta();
		return { ok: true, files: youtube.youtubeFilenames(), meta };
	} catch (err) {
		return {
			ok: false,
			error: String((err as { message?: string }).message || err),
		};
	}
});

export {
	backfillYoutubeMeta,
	repairSilentYoutubeImports,
	mergeYoutubeIntermediates,
	resolveYtDlpFfmpegLocation,
	runYoutubeJob,
};
