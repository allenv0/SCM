"use strict";

// Video frame extraction for the indexer worker. Uses a bundled ffmpeg
// binary (ffmpeg-static in dev; resources/ffmpeg in the packaged app, passed
// as FFMPEG_PATH). Exposes:
//   VIDEO_EXTENSIONS — accepted import extensions
//   resolveFfmpeg()  — the binary path (throws a clear error if missing)
//   probeDuration()  — seconds as a float, from `ffmpeg -i` stderr
//   extractFrames()  — N evenly spaced raw RGB frames (in-memory buffers)
//   extractFrameRaw()— one raw RGB24 frame as {data,width,height,channels}
//   extractFrameAt() — one JPEG at destPath (poster / legacy path)
//   extractPoster()  — one JPEG at destPath (width >= 224 for the grid)

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const detectCache = require("./detect-cache.js");

// ---------------------------------------------------------------------------
// Orphan-proof ffmpeg tracking (2026-09-28 ffmpeg-CPU fix).
//
// Every ffmpeg child spawned through this module is registered here so a
// worker restart / pool stop / app quit can SIGKILL grandchildren instead of
// orphaning them to PID 1 (the old `worker.process.kill()` only killed the
// Node worker; its ffmpeg children survived with no timers left to stop
// them — the 500%+ CPU after "done" and after app close).
//
// The worker also reports spawn/exit to main via setFfmpegReporter() so main
// can kill by PID even AFTER the worker is dead (main-side PID map survives
// the worker). See indexer.js / transcribe-worker.js wiring + main.js
// killTrackedFfmpegPids().
// ---------------------------------------------------------------------------
const activeFfmpegChildren = new Set();
let ffmpegReporter = null;

function setFfmpegReporter(fn) {
	ffmpegReporter = typeof fn === "function" ? fn : null;
}

function reportFfmpeg(event) {
	if (!ffmpegReporter) return;
	try {
		ffmpegReporter(event);
	} catch {
		/* reporting must never fail the spawn */
	}
}

function trackFfmpegChild(child, label) {
	if (!child || typeof child.pid !== "number") return child;
	activeFfmpegChildren.add(child);
	try {
		reportFfmpeg({
			type: "ffmpeg-spawn",
			pid: child.pid,
			label: String(label || "ffmpeg"),
		});
	} catch {
		/* best-effort */
	}
	const untrack = () => {
		if (activeFfmpegChildren.has(child)) activeFfmpegChildren.delete(child);
		try {
			reportFfmpeg({ type: "ffmpeg-exit", pid: child.pid });
		} catch {
			/* best-effort */
		}
	};
	child.on("close", untrack);
	child.on("error", untrack);
	// Safety: if the event loop drains without close/error (killed externally),
	// the set entry is dropped on the next spawn/kill sweep — see killAllFfmpeg.
	return child;
}

function spawnFfmpeg(ffmpeg, args, opts) {
	const child = spawn(ffmpeg, args, opts);
	return trackFfmpegChild(
		child,
		`ffmpeg ${Array.isArray(args) ? args.slice(0, 4).join(" ") : ""}`.slice(0, 120),
	);
}

// SIGKILL every tracked ffmpeg child. Called from worker shutdown /
// kill-ffmpeg IPC / process exit handlers. Returns the number of PIDs
// signaled. Never throws; already-exited children are skipped.
function killAllFfmpeg(reason) {
	let killed = 0;
	for (const child of [...activeFfmpegChildren]) {
		const pid = child.pid;
		try {
			// Skip children that already exited (exitCode/signal set, no pid).
			if (child.exitCode !== null || child.signalCode !== null) {
				activeFfmpegChildren.delete(child);
				continue;
			}
			try {
				child.kill("SIGKILL");
				killed++;
			} catch {
				/* already gone — fall through to PID kill */
			}
			// Belt-and-braces: if the handle is stale but the OS process
			// lives on, signal by PID directly.
			if (typeof pid === "number") {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* ESRCH = already gone, EPERM = not ours — both fine */
				}
			}
		} finally {
			activeFfmpegChildren.delete(child);
		}
	}
	if (killed > 0 || reason) {
		try {
			console.warn(
				`[video] killAllFfmpeg(${reason || "unknown"}): signaled ${killed} child(ren)`,
			);
		} catch {
			/* logging must never throw */
		}
	}
	return killed;
}

function getActiveFfmpegCount() {
	return activeFfmpegChildren.size;
}

// Last-resort self-cleanup: if THIS worker process is going down, do not
// leave ffmpeg behind. 'exit' handlers must be synchronous — kill() is.
try {
	if (typeof process.on === "function") {
		process.on("exit", () => {
			for (const child of [...activeFfmpegChildren]) {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}
		});
	}
} catch {
	/* handler install is best-effort */
}

// Everything ffmpeg can decode becomes searchable + posterable. Playability
// in the renderer is a separate, narrower set (src/lib/media.ts).
const VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".m4v",
	".webm",
	".mkv",
	".avi",
	".ts",
	".m2ts",
	".mts",
	".mpg",
	".mpeg",
	".wmv",
	".flv",
	".3gp",
	".MP4",
	".MOV",
	".M4V",
	".WEBM",
	".MKV",
	".AVI",
	".TS",
	".M2TS",
	".MTS",
	".MPG",
	".MPEG",
	".WMV",
	".FLV",
	".3GP",
]);

// Clip boundaries past the true duration would make ffmpeg fail or emit a
// black frame; safety margin used when timestamping extractions.
const EDGE_MARGIN = 0.5; // seconds off each end
const MAX_DURATION = 24 * 60 * 60; // sanity cap for pathological files
const FRAME_FRACTIONS = [0.2, 0.5, 0.8];

function resolveFfmpeg() {
	if (process.env.FFMPEG_PATH) {
		const p = process.env.FFMPEG_PATH;
		if (fs.existsSync(p)) return p;
		throw new Error(`FFMPEG_PATH set but missing: ${p}`);
	}
	// Packaged app: the binary is copied to Contents/Resources/ffmpeg
	// (package.json "build.extraResources").
	if (process.resourcesPath) {
		const p = path.join(process.resourcesPath, "ffmpeg");
		if (fs.existsSync(p)) return p;
	}
	try {
		const p = require("ffmpeg-static");
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* fall through to the error below */
	}
	throw new Error(
		"No ffmpeg binary available (set FFMPEG_PATH or install ffmpeg-static)",
	);
}

function runFfmpeg(ffmpeg, args, timeoutMs = 120000) {
	return new Promise((resolve, reject) => {
		const child = spawnFfmpeg(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`ffmpeg timed out after ${timeoutMs}ms: ${stderr.slice(-500)}`,
				),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
		});
	});
}

// Binary-safe twin of runFfmpeg: stdout is collected as Buffer chunks (utf8
// concat would corrupt rawvideo), stderr stays a string for diagnostics.
function runFfmpegBuffer(ffmpeg, args, timeoutMs = 120000) {
	return new Promise((resolve, reject) => {
		const child = spawnFfmpeg(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let stderr = "";
		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`ffmpeg timed out after ${timeoutMs}ms: ${stderr.slice(-500)}`,
				),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
		});
	});
}

// Output-stream WxH from a rawvideo encode's stderr (the INPUT line may
// report a different size once -vf scale has run). Falls back to 224x224
// for the fixed scale=224:224 path when the Output section is missing.
//
// SAR/DAR tolerance (2026-09-26 poison-pill fix): ffmpeg prints
// `480x270 [SAR 1:1 DAR 16:9]` when SAR is known but bare `480x270, q=2-31`
// for scaled bt709 outputs with unknown SAR — the old regex required the
// `[` and returned null for those, so EVERY segment of such files skipped
// and the file re-queued on every launch forever ("Embedding scenes" loop).
function parseRawFrameSize(stderr, width) {
	const outIdx = stderr.lastIndexOf("Output #");
	const section = outIdx >= 0 ? stderr.slice(outIdx) : stderr;
	const m = section.match(/Video:\s*rawvideo[\s\S]*?,\s*(\d{1,5})x(\d{1,5})(?:\s*\[|,|\s|$)/);
	if (m) return { width: +m[1], height: +m[2] };
	if (width != null && width <= 224) return { width: 224, height: 224 };
	return null;
}

// Duration in seconds, parsed from `ffmpeg -i` metadata output. Returns null
// when the file has no decodable duration (unusual but not fatal). Note:
// `ffmpeg -i` with no output always exits 1 — that is the normal probe
// shape, so the exit code is deliberately ignored here.
async function probeDuration(ffmpeg, filePath) {
	const { stderr } = await new Promise((resolve, reject) => {
		const child = spawnFfmpeg(ffmpeg, ["-i", filePath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("ffmpeg probe timed out"));
		}, 30000);
		child.on("error", reject);
		child.on("close", () => {
			clearTimeout(timer);
			resolve({ stdout: out, stderr: err });
		});
	});
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) return null;
	const hours = parseInt(m[1], 10);
	const minutes = parseInt(m[2], 10);
	const seconds = parseFloat(m[3]);
	let total = hours * 3600 + minutes * 60 + seconds;
	if (!Number.isFinite(total) || total <= 0) return null;
	return Math.min(total, MAX_DURATION);
}

// Whether the file carries at least one audio stream, parsed from the same
// `ffmpeg -i` metadata output probeDuration reads. A silent/muted video has
// no `Audio:` stream line — its empty transcript is legitimate and must
// never be retried. A stub-era empty (recorded before the whisper engine
// existed) WITH an audio stream is poison and must be re-queued (see
// repairUntranscribedWithAudio in main.js). Resolves false (not throws) on
// probe failure — an undecodable file is not evidence of speech.
async function probeHasAudio(ffmpeg, filePath) {
	let stderr;
	try {
		const { stderr: err } = await new Promise((resolve, reject) => {
			const child = spawnFfmpeg(ffmpeg, ["-i", filePath], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let errText = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (errText += d));
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("ffmpeg audio probe timed out"));
			}, 30000);
			child.on("error", reject);
			child.on("close", () => {
				clearTimeout(timer);
				resolve({ stdout: out, stderr: errText });
			});
		});
		stderr = err;
	} catch {
		return false;
	}
	return /^\s*Stream #\d+:\d+.*Audio:/m.test(stderr);
}

// Timestamps at fractions of the duration, clamped inside [0, duration - 0.5].
function sampleTimestamps(duration, fractions) {
	const end = duration - EDGE_MARGIN;
	if (end <= 0) return [0];
	return fractions.map((f) => Math.max(0, Math.min(end, duration * f)));
}

// Extract one JPEG frame at `atSeconds`. Returns the output file path.
// Fast-seek (`-ss` before `-i`) is instant but has a known ffmpeg bug on some
// containers (MPEG-TS): it can encode ZERO frames while still exiting 0.
// So the result is verified on disk, and a slow decode-from-start seek
// (`-ss` after `-i`) is retried before the frame is declared failed.
//
// Never-stall contract (long-film fix): the slow path decodes from 0→t, so
// its cost is O(t) — a single segment deep in a 2–3 h film can take minutes.
// Callers (enrichVideo) catch per-segment failures and SKIP the segment, so
// this throws rather than hanging: fast and slow attempts each have their
// own timeout (overridable via `opts`), and the slow fallback is logged with
// its timestamp so a frozen tray can be attributed to ffmpeg vs CLIP.
async function extractFrameAt(
	ffmpeg,
	filePath,
	atSeconds,
	destPath,
	width,
	opts = {},
) {
	const fastTimeoutMs =
		Number(opts?.fastTimeoutMs) > 0 ? Number(opts.fastTimeoutMs) : 90000;
	const slowTimeoutMs =
		Number(opts?.slowTimeoutMs) > 0 ? Number(opts.slowTimeoutMs) : 150000;
	const frameArgs = (seekBefore) => {
		const args = ["-y"];
		if (seekBefore) args.push("-ss", atSeconds.toFixed(3), "-i", filePath);
		else args.push("-i", filePath, "-ss", atSeconds.toFixed(3));
		args.push("-frames:v", "1", "-q:v", "3");
		args.push(
			"-vf",
			width > 224 ? `scale='min(${width},iw)':-2` : "scale=224:224",
		);
		args.push(destPath);
		return args;
	};
	const startedFast = Date.now();
	try {
		await runFfmpeg(ffmpeg, frameArgs(true), fastTimeoutMs);
		if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
			return destPath;
		}
	} catch (err) {
		/* fall through to the slow seek — logged below with timing */
		if (process.env.SCM_DEBUG_FFMPEG) {
			console.warn(
				`[video] fast seek failed at ${atSeconds.toFixed(1)}s ` +
					`(${Date.now() - startedFast}ms): ${err.message}`,
			);
		}
	}
	// Fast path produced nothing usable (zero-byte file or thrown error):
	// the slow decode-from-start is O(t), so name the timestamp — a tray
	// frozen here is ffmpeg decoding, not CLIP.
	const startedSlow = Date.now();
	try {
		await runFfmpeg(ffmpeg, frameArgs(false), slowTimeoutMs);
	} catch (err) {
		throw new Error(
			`ffmpeg slow-seek failed at ${atSeconds.toFixed(1)}s ` +
				`after ${Date.now() - startedSlow}ms: ${err.message}`,
			{ cause: err },
		);
	}
	if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
		throw new Error(
			`ffmpeg produced no frame at ${atSeconds.toFixed(1)}s ` +
				`for ${path.basename(filePath)} (fast ${Date.now() - startedFast}ms total)`,
		);
	}
	if (atSeconds > 60 && process.env.SCM_DEBUG_FFMPEG) {
		console.warn(
			`[video] slow-seek fallback used at ${atSeconds.toFixed(1)}s ` +
				`(${Date.now() - startedSlow}ms)`,
		);
	}
	return destPath;
}

// Pipe one frame as rawvideo rgb24 (no JPEG encode, no temp file — plan 0.5).
// Same fast/slow-seek contract and timeouts as extractFrameAt; returns
// { data: Buffer, width, height, channels: 3 }. Scale filter matches
// extractFrameAt so the CLIP decode path sees the same pixels.
async function extractFrameRaw(ffmpeg, filePath, atSeconds, width, opts = {}) {
	const fastTimeoutMs =
		Number(opts?.fastTimeoutMs) > 0 ? Number(opts.fastTimeoutMs) : 90000;
	const slowTimeoutMs =
		Number(opts?.slowTimeoutMs) > 0 ? Number(opts.slowTimeoutMs) : 150000;
	const scale = width > 224 ? `scale='min(${width},iw)':-2` : "scale=224:224";
	const frameArgs = (seekBefore) => {
		const args = ["-y"];
		if (seekBefore) args.push("-ss", atSeconds.toFixed(3), "-i", filePath);
		else args.push("-i", filePath, "-ss", atSeconds.toFixed(3));
		args.push("-frames:v", "1", "-vf", scale);
		args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
		return args;
	};
	const coerce = (stdout, stderr) => {
		if (!stdout || stdout.length === 0) return null;
		const dims = parseRawFrameSize(stderr, width);
		if (!dims) return null;
		const expected = dims.width * dims.height * 3;
		if (stdout.length !== expected) return null;
		return {
			data: stdout,
			width: dims.width,
			height: dims.height,
			channels: 3,
		};
	};
	const startedFast = Date.now();
	try {
		const { stdout, stderr } = await runFfmpegBuffer(
			ffmpeg,
			frameArgs(true),
			fastTimeoutMs,
		);
		const frame = coerce(stdout, stderr);
		if (frame) return frame;
	} catch (err) {
		if (process.env.SCM_DEBUG_FFMPEG) {
			console.warn(
				`[video] fast raw-seek failed at ${atSeconds.toFixed(1)}s ` +
					`(${Date.now() - startedFast}ms): ${err.message}`,
			);
		}
	}
	const startedSlow = Date.now();
	let frame;
	try {
		const { stdout, stderr } = await runFfmpegBuffer(
			ffmpeg,
			frameArgs(false),
			slowTimeoutMs,
		);
		frame = coerce(stdout, stderr);
	} catch (err) {
		throw new Error(
			`ffmpeg slow-seek failed at ${atSeconds.toFixed(1)}s ` +
				`after ${Date.now() - startedSlow}ms: ${err.message}`,
			{ cause: err },
		);
	}
	if (!frame) {
		throw new Error(
			`ffmpeg produced no frame at ${atSeconds.toFixed(1)}s ` +
				`for ${path.basename(filePath)} (fast ${Date.now() - startedFast}ms total)`,
		);
	}
	if (atSeconds > 60 && process.env.SCM_DEBUG_FFMPEG) {
		console.warn(
			`[video] slow-seek fallback used at ${atSeconds.toFixed(1)}s ` +
				`(${Date.now() - startedSlow}ms)`,
		);
	}
	return frame;
}

// Extract N evenly spaced frames as in-memory raw RGB buffers (no temp dir).
// Degrades gracefully: a probe failure extracts from t=0 only; an extraction
// failure is reported per-frame and the survivors are returned.
async function extractFrames(ffmpeg, filePath) {
	let duration = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* probe failure: fall back to t=0 below */
	}
	const timestamps = sampleTimestamps(duration ?? 0, FRAME_FRACTIONS);
	// Independent ffmpeg spawns — run them concurrently. Each keeps its own
	// fast/slow-seek fallback; a failure still fails the whole extraction.
	const out = new Array(timestamps.length);
	await Promise.all(
		timestamps.map((atSeconds, i) =>
			extractFrameRaw(ffmpeg, filePath, atSeconds, 224).then((frame) => {
				out[i] = frame;
			}),
		),
	);
	return out;
}

// ---------------------------------------------------------------------------
// Scene segmentation (Phase 1 of scene search, see DESIGN-SCENE-SEARCH.md).
// ---------------------------------------------------------------------------

// Scene-change threshold for the ffmpeg `scene` filter (0–1; higher = fewer
// detections). The ffmpeg-docs default for hard cuts; a knob for real-footage
// tuning (SCENE_THRESHOLD).
const SCENE_THRESHOLD = 0.3;

// Phase 1 detect configuration (Inference-MLX-Speed-Master-Plan-A §Phase 1).
// Defaults preserve the historical software 360p / full-rate / 0.3 contract
// so existing plans stay comparable; each knob is opt-in via opts or env.
//
//   SCM_DETECT_HWACCEL     auto | videotoolbox | software   (default software)
//   SCM_DETECT_HEIGHT      360 | 180 | …                    (default 360)
//   SCM_DETECT_FPS         0 (off) | 10 | …                 (default 0)
//   SCM_DETECT_THRESHOLD   0..1                             (default 0.3)
//   SCM_DETECT_KEYFRAME    0 | 1  — I-frame coarse + refine (default 0)
//   SCM_DETECT_CACHE       0 | 1  — per-file plan cache     (default 1 when cacheDir set)
//
// 2026-09-25 measurement (MDs/bench-detect/detect-2026-09-25.json):
// VideoToolbox + select=scene is ~5x SLOWER than software on the reference
// M1 (plain -hwaccel downloads after decode; -hwaccel_output_format +
// hwdownload fails to convert for this filter graph). Phase 1.1 is therefore
// NOT the default — software stays on. The wins that did measure:
//   height=180 + fps=10  ≈ 1.24x
//   per-file detect cache  ≈ 900x on re-import (hot)
const DEFAULT_DETECT_HEIGHT = 360;
const DEFAULT_DETECT_FPS = 0;
const DEFAULT_DETECT_HWACCEL = "software";
// Coarse keyframe pass + local refine (Phase 1.3).
const KEYFRAME_REFINE_WINDOW_S = 2.0;
const DETECT_HWACCEL_MODES = new Set([
	"auto",
	"videotoolbox",
	"software",
	"off",
	"none",
]);

function envInt(name, fallback) {
	const raw = process.env[name];
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function envFlag(name, fallback) {
	const raw = process.env[name];
	if (raw == null || raw === "") return fallback;
	if (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes")
		return true;
	if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "no")
		return false;
	return fallback;
}

// Normalize detect options from callers + environment. Pure; unit-tested.
function resolveDetectOptions(opts = {}) {
	const hwRaw = String(
		opts.hwaccel ?? process.env.SCM_DETECT_HWACCEL ?? DEFAULT_DETECT_HWACCEL,
	).toLowerCase();
	const hwaccel = DETECT_HWACCEL_MODES.has(hwRaw) ? hwRaw : "auto";
	const height = Math.max(
		32,
		Math.min(
			2160,
			Number(opts.height ?? envInt("SCM_DETECT_HEIGHT", DEFAULT_DETECT_HEIGHT)),
		),
	);
	const fps = Math.max(
		0,
		Math.min(120, Number(opts.fps ?? envInt("SCM_DETECT_FPS", DEFAULT_DETECT_FPS))),
	);
	const threshold =
		Number.isFinite(opts.threshold) && opts.threshold > 0 && opts.threshold <= 1
			? Number(opts.threshold)
			: Number.isFinite(Number(process.env.SCM_DETECT_THRESHOLD)) &&
					Number(process.env.SCM_DETECT_THRESHOLD) > 0 &&
					Number(process.env.SCM_DETECT_THRESHOLD) <= 1
				? Number(process.env.SCM_DETECT_THRESHOLD)
				: SCENE_THRESHOLD;
	const keyframe = Boolean(
		opts.keyframe ?? envFlag("SCM_DETECT_KEYFRAME", false),
	);
	const useCache = Boolean(
		opts.cache ?? envFlag("SCM_DETECT_CACHE", true),
	);
	const cacheDir = opts.cacheDir || process.env.SCM_DETECT_CACHE_DIR || null;
	// Keep hw frames on the GPU and hwdownload inside the filter (Phase 1.1
	// risk check). Default false: plain -hwaccel videotoolbox downloads after
	// decode and is the safer first try for select=scene.
	const hwOutputFormat = Boolean(
		opts.hwaccelOutputFormat ??
			envFlag("SCM_DETECT_HW_OUTPUT_FORMAT", false),
	);
	return {
		hwaccel,
		height,
		fps,
		threshold,
		keyframe,
		cache: useCache && Boolean(cacheDir),
		cacheDir,
		hwaccelOutputFormat: hwOutputFormat,
	};
}

// Config fingerprint stored in the detect cache key. Any field that changes
// the shot boundaries must change this string.
function detectConfigKey(o) {
	return [
		`h=${o.height}`,
		`fps=${o.fps}`,
		`thr=${o.threshold}`,
		`kf=${o.keyframe ? 1 : 0}`,
		`hw=${o.hwaccel}`,
		`hwo=${o.hwaccelOutputFormat ? 1 : 0}`,
	].join("|");
}

// The select/scale chain. MUST stay in the quoted comma-chain form —
// `select=gt(scene,0.3):showinfo` silently emits ZERO frames (exit 1) on
// this ffmpeg build (measured).
function buildDetectFilter(o, { forHwDownload = false } = {}) {
	const pre = [];
	if (forHwDownload) {
		pre.push("hwdownload", "format=nv12");
	}
	pre.push(`scale=-2:${o.height}`);
	if (o.fps > 0) pre.push(`fps=${o.fps}`);
	const head = pre.join(",");
	return (
		`[0:v]${head},split=2[a][b];` +
		`[a]select='gt(scene,${o.threshold})',showinfo[sa];` +
		`[b]null[sb]`
	);
}

// Full argv for one detect pass. `-skip_frame nokey` is an INPUT option
// (before -i) and only used for the keyframe coarse pass.
function buildDetectArgs(filePath, o, { keyframeOnly = false } = {}) {
	const args = [];
	if (keyframeOnly) {
		args.push("-skip_frame", "nokey");
	}
	const useHw = o.hwaccel === "videotoolbox" || o.hwaccel === "auto";
	if (useHw && o.hwaccel !== "software" && o.hwaccel !== "off" && o.hwaccel !== "none") {
		args.push("-hwaccel", "videotoolbox");
		if (o.hwaccelOutputFormat) {
			args.push("-hwaccel_output_format", "videotoolbox");
		}
	}
	args.push("-i", filePath);
	args.push(
		"-filter_complex",
		buildDetectFilter(o, { forHwDownload: Boolean(o.hwaccelOutputFormat && useHw) }),
		"-map",
		"[sa]",
		"-map",
		"[sb]",
		"-f",
		"null",
		"-",
	);
	return args;
}

// Parse showinfo pts_time hits + the last time= decode tick out of a
// detect-pass stderr blob. Pure; shared by live parse and tests.
function parseDetectStderr(stderr) {
	const pts = [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((m) =>
		parseFloat(m[1]),
	);
	let lastTime = null;
	for (const m of String(stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
		lastTime = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	}
	return {
		boundaries: [...new Set(pts)].sort((a, b) => a - b),
		duration: lastTime,
	};
}

// Cheap hardware-availability probe: `ffmpeg -hwaccels` lists
// `videotoolbox` on every Apple Silicon / modern macOS ffmpeg build that
// has the decoder. Once per process so "auto" skips the failed-spawn path
// on Linux CI or a build without VT.
let vtProbeCache = null;
async function videoToolboxAvailable(ffmpeg) {
	if (vtProbeCache !== null) return vtProbeCache;
	vtProbeCache = await new Promise((resolve) => {
		const child = spawnFfmpeg(ffmpeg, ["-hide_banner", "-hwaccels"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let settled = false;
		const done = (v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		// The old probe had NO timeout: a hung ffmpeg here wedged the whole
		// detect path forever. 10 s is generous for a flag listing.
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* best-effort */
			}
			done(false);
		}, 10000);
		child.stdout.on("data", (d) => {
			out += d.toString();
		});
		child.stderr.on("data", (d) => {
			out += d.toString();
		});
		child.on("error", () => done(false));
		child.on("close", () => {
			done(/\bvideotoolbox\b/i.test(out));
		});
	});
	return vtProbeCache;
}

// Scene-pass watchdog (Phase 4, long-movie coverage — see detectScenes).
// STALL: no stderr output for this long → the decode is hung, kill it.
// ABSOLUTE: ceiling for pathological files. A pass that is still making
// decode progress is NEVER killed by the clock alone — the old flat 120 s
// cap silently discarded all shot boundaries for a 2–3 hour film (the pass
// decodes every frame at 360p), degrading it to interval sampling.
const DETECT_SCENES_STALL_TIMEOUT_MS = 30000;
const DETECT_SCENES_ABSOLUTE_TIMEOUT_MS = 10 * 60 * 1000;
// Duration-aware detect ceiling (2026-09-28 orphan fix): a full-rate 360p
// software decode of a 2 h HEVC 10-bit film cannot finish inside the 10 min
// enrich chunk timeout, so the CHUNK timed out (main killed the worker and
// orphaned ffmpeg) instead of the DETECT timing out (which falls back to
// interval sampling inside the same chunk). Large films get a SHORTER detect
// budget so the fallback + 16 embeds still fit inside the chunk timeout and
// the timed-out detect result is cached instead of re-run forever.
function detectAbsoluteTimeoutMs(durationSeconds) {
	if (!(durationSeconds > 0)) return DETECT_SCENES_ABSOLUTE_TIMEOUT_MS;
	if (durationSeconds >= 3600) return 5 * 60 * 1000;
	if (durationSeconds >= 1800) return 6 * 60 * 1000;
	return DETECT_SCENES_ABSOLUTE_TIMEOUT_MS;
}
const REFINE_WINDOW_TIMEOUT_MS = 60000;
// Duration-aware segment budget (Phase 4, long-movie coverage): one
// searchable point per ~30 s of film, floored at 8 for short clips and
// capped at 128 so worst-case enrichment cost stays bounded even for a
// 3-hour feature. The old flat 32 left the final act of a long film with
// zero coverage (front-biased shot slice) or a ~3-minute search window.
//
// User-adjustable via the Settings → Video search quality preset (see
// VIDEO_QUALITY_PRESETS): the preset only changes the (target, min, max)
// triple below — the planning math is identical. The legacy constants are
// the `balanced` preset's values, kept so existing callers and tests keep
// working unmodified.
const SEGMENT_TARGET_SECONDS = 30;
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 128;

// Video search quality presets (Settings → Video search). Each preset is a
// (target, min, max) triple for the duration-aware budget: one searchable
// point per `targetSeconds` of film, floored at `minSegments` for short
// clips and capped at `maxSegments` so worst-case enrichment cost
// (ffmpeg passes + CLIP embeds + scene posters + segment-bin rows) stays
// bounded. Cost scales ~linearly with the segment count, which is why the
// UI offers presets instead of a raw slider.
const VIDEO_QUALITY_PRESETS = {
	eco: { targetSeconds: 60, minSegments: 4, maxSegments: 32 },
	balanced: { targetSeconds: 30, minSegments: 8, maxSegments: 128 },
	detailed: { targetSeconds: 15, minSegments: 12, maxSegments: 256 },
	// Maximum recall: one point per 5 s, up to 1024 segments. ~4x the
	// detailed cost at the extreme (a 90-min film caps at 1024: ~4 MB of
	// segment-bin rows plus ~50 MB of scene posters for that one video),
	// so this is opt-in only.
	ultra: { targetSeconds: 5, minSegments: 16, maxSegments: 1024 },
	// Ultra Pro (fifth rung): twice Ultra's density (one point per 2.5 s)
	// with the ceiling doubled to match. Sized for the feature-length case
	// where Ultra thins worst: full 2.5 s density holds to ~85 min, a 90-min
	// film caps at 2048 (~1 pt / 2.6 s), a 2 h film at ~1 pt / 3.5 s. Cost is
	// exactly 2x Ultra at the extreme (2048 segments ≈ ~100 MB of scene
	// posters + ~4 MB of segment-bin rows; MEASURED 2026-09-11 at ~6 min of
	// enrichment per capped film — see MDs/Ultra-Pro-Plan.md §3.1 correction;
	// the old ~1.7–2.8 h here was the LFM-caption misread) — opt-in only, and
	// the Settings sheet shows the per-library bill before committing (cost
	// line + one-time confirm). Design + cost math: MDs/Ultra-Pro-Plan.md.
	ultraPro: { targetSeconds: 2.5, minSegments: 24, maxSegments: 2048 },
};
const VIDEO_QUALITY_IDS = Object.keys(VIDEO_QUALITY_PRESETS);
const DEFAULT_VIDEO_QUALITY = "balanced";

// Parse a stored/raw value into a valid preset id; anything else → the
// default. Mirrors the parse-then-fallback pattern of the renderer's
// preference libs so a hand-edited settings.json can never break planning.
function parseVideoQuality(raw) {
	return VIDEO_QUALITY_PRESETS[raw] ? raw : DEFAULT_VIDEO_QUALITY;
}

// The (target, min, max) triple for a preset id (unknown → default).
function budgetForQuality(quality) {
	return (
		VIDEO_QUALITY_PRESETS[quality] ||
		VIDEO_QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY]
	);
}

// The segment budget for a video of `durationSeconds` (0/unknown → the
// floor). Bounded by min..max; shared by the shot and the
// interval paths so a long film gets end-to-end coverage at a constant
// worst-case cost. `budgetOpts` overrides the balanced triple, e.g. a
// VIDEO_QUALITY_PRESETS entry; omitted → legacy behavior exactly.
function segmentBudgetFor(durationSeconds, budgetOpts = null) {
	const target = Number(budgetOpts?.targetSeconds) || SEGMENT_TARGET_SECONDS;
	const min = Number(budgetOpts?.minSegments) || MIN_SEGMENTS;
	const max = Number(budgetOpts?.maxSegments) || MAX_SEGMENTS;
	if (!(durationSeconds > 0)) return min;
	return Math.max(min, Math.min(max, Math.ceil(durationSeconds / target)));
}

// Phase 5, uniform TIME coverage: when a film has more shots than the
// segment budget, keep one shot per (duration / budget) slice — the nearest
// shot midpoint to each slice center — so a long film is searchable from
// its first act to its last (the old front-biased slice(0, 32) left the
// final act with zero coverage). Pure + deterministic for unit tests.
function sampleShotsEvenly(shots, duration, budget) {
	const slot = duration / budget;
	const used = new Set();
	const plan = [];
	for (let i = 0; i < budget; i++) {
		const target = slot * i + slot / 2;
		let best = -1;
		let bestDist = Infinity;
		for (let j = 0; j < shots.length; j++) {
			if (used.has(j)) continue;
			const d = Math.abs(shots[j].t - target);
			if (d < bestDist) {
				bestDist = d;
				best = j;
			}
		}
		if (best >= 0) {
			used.add(best);
			plan.push(shots[best]);
		}
	}
	return plan.sort((a, b) => a.t - b.t);
}

// Phase 5 interval fallback: subdivide a boundary-less film into `budget`
// equal slices and embed each slice's midpoint.
function buildIntervalPlan(duration, budget) {
	const seg = duration / budget;
	const plan = [];
	for (let i = 0; i < budget; i++) {
		plan.push({ t: i * seg + seg / 2, dur: seg });
	}
	return plan;
}

// Cap + clamp: a seek past the real end makes ffmpeg fail or emit a black
// frame, and extraction is what actually consumes `t`. Floor shot spans at
// half a second so degenerate zero-length shots stay embeddable.
function clampPlan(plan, duration) {
	const end = Math.max(0, duration - EDGE_MARGIN);
	for (const seg of plan) {
		seg.t = Math.max(0, Math.min(end > 0 ? end : seg.t, seg.t));
		if (seg.dur < 0.5) seg.dur = 0.5;
	}
	return plan;
}

// Shot boundaries at absolute seconds via an ffmpeg scene-detection pass.
// IMPORTANT: the filter MUST be the quoted comma-chain form
// `scale=-2:360,select='gt(scene,0.3)',showinfo`. The unquoted/colon form
// (`select=gt(scene,0.3):showinfo`) silently emits ZERO frames (exit 1) on
// this ffmpeg build — measured, not folklore. The 360p scale is Phase 4:
// cut detection needs luma deltas, not 4K pixels, and the downscale is the
// single biggest lever for keeping the pass fast on long or high-resolution
// films. The select chain is split with a parallel `null` tap so every frame
// ALSO reaches the muxer — without it ffmpeg's stats only tick at cut
// points and the last time= is the final CUT, not the end of the film.
//
// Phase 1 (2026-09-25): optional VideoToolbox decode, lower height/fps,
// keyframe coarse + refine, and a caller-supplied detect cache. Defaults
// preserve the historical software 360p full-rate 0.3 contract.
//
// Watchdog timeouts instead of a flat cap: the old hard 120 s ceiling
// silently discarded ALL boundaries for a 2–3 hour film (the pass decodes
// every frame at 360p), degrading it to interval sampling. As long as
// ffmpeg keeps emitting stderr (decode progress), a long film is allowed to
// run; only a stall (no output for DETECT_SCENES_STALL_TIMEOUT_MS) or the
// absolute ceiling (a genuinely hung pass) kills it.
//
// Resolves { boundaries, duration, engine, wallMs, cached }: boundaries is
// [] when no cuts were detected (single continuous take) or the pass
// failed/was killed — callers fall back to interval sampling. duration is
// the decode position of the LAST stats tick (≈ the film's real length at
// EOF, thanks to the null tap), which buildSegmentPlan uses when the
// container has no probeable duration (some .mkv/.ts/raw captures report
// Duration: N/A); may be null when the pass never ticked (an undecodable
// file).
//
// `onProgress({ pct })` receives a 0..1 decode fraction (from ffmpeg's
// time= stderr ticks, when a duration is known) so the UI can show a long
// film is still being analyzed instead of sitting silent.
async function detectScenes(
	ffmpeg,
	filePath,
	onProgress = null,
	duration = null,
	opts = null,
) {
	const o = resolveDetectOptions(opts || {});
	const started = Date.now();

	// Phase 1.4 cache hit — never spawn ffmpeg.
	if (o.cache && filePath) {
		try {
			const ident = detectCache.fileIdentity(filePath);
			const hit = detectCache.getCachedDetect(o.cacheDir, {
				filePath: path.resolve(filePath),
				...ident,
				configKey: detectConfigKey(o),
			});
			if (hit) {
				if (onProgress && duration > 0) onProgress({ pct: 1 });
				return { ...hit, wallMs: Date.now() - started, cached: true };
			}
		} catch {
			/* unreadable file identity → run the live pass */
		}
	}

	const engines = [];
	// "auto" = software first, videotoolbox only as an explicit opt-in
	// alternative after a failed software spawn (never preferred: measured
	// slower for select=scene). "videotoolbox" forces the VT attempt first.
	if (o.hwaccel === "videotoolbox") {
		const canVt = await videoToolboxAvailable(ffmpeg);
		if (canVt) {
			engines.push({
				hwaccel: "videotoolbox",
				hwaccelOutputFormat: o.hwaccelOutputFormat,
			});
		}
	}
	// Software is always the terminal fallback.
	engines.push({ hwaccel: "software", hwaccelOutputFormat: false });

	const runOnce = (engineOpts, { keyframeOnly = false } = {}) =>
		new Promise((resolve) => {
			const args = buildDetectArgs(
				filePath,
				{ ...o, ...engineOpts },
				{ keyframeOnly },
			);
			const child = spawnFfmpeg(ffmpeg, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let lastPct = -1;
			let lastTime = null;
			let timedOut = false;
			let failedPass = false;
			let spawnError = false;
			let stallTimer = null;
			let absoluteTimer = null;
			// Duration-aware absolute ceiling: the old flat 10 min left no
			// room for the 16 embeds inside the 10 min chunk timeout, so a
			// 2 h HEVC file timed out the CHUNK (main killed the worker,
			// orphaning ffmpeg to PID 1) instead of timing out the DETECT
			// (which would have fallen back to interval sampling inside the
			// same chunk). Large films get a shorter detect budget so the
			// fallback + embeds still fit inside the chunk timeout.
			const absoluteMs = detectAbsoluteTimeoutMs(duration);
			const stopWatchdogs = () => {
				if (stallTimer) clearTimeout(stallTimer);
				if (absoluteTimer) clearTimeout(absoluteTimer);
			};
			const armStall = () => {
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, DETECT_SCENES_STALL_TIMEOUT_MS);
			};
			child.stderr.on("data", (d) => {
				const chunk = d.toString();
				stderr += chunk;
				armStall();
				const m = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
				if (m) {
					lastTime = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
					if (onProgress && duration > 0) {
						const pct = Math.min(1, lastTime / duration);
						if (pct > lastPct) {
							lastPct = pct;
							onProgress({ pct });
						}
					}
				}
			});
			armStall();
			absoluteTimer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}, absoluteMs);
			child.on("error", () => {
				spawnError = true;
				failedPass = true;
				stopWatchdogs();
				resolve({
					boundaries: [],
					duration: null,
					failed: true,
					spawnError: true,
					stderr,
				});
			});
			child.on("close", (code) => {
				stopWatchdogs();
				if (onProgress && !timedOut && !failedPass && duration > 0 && lastPct < 1) {
					onProgress({ pct: 1 });
				}
				const parsed = parseDetectStderr(stderr);
				const lower = stderr.toLowerCase();
				// Only a clear hwaccel failure forces the next engine. A
				// generic exit 1 with no hwaccel error is a real pass failure
				// (keep the historic empty/partial result), not a signal to
				// silently switch engines.
				const hwErrorMessage =
					lower.includes("hwaccel") ||
					lower.includes("videotoolbox") ||
					lower.includes("hardware accelerator") ||
					lower.includes("impossible to convert between the formats");
				const hwFail =
					code !== 0 &&
					code !== null &&
					engineOpts.hwaccel !== "software" &&
					hwErrorMessage;
				resolve({
					boundaries: parsed.boundaries,
					duration: parsed.duration ?? lastTime,
					failed: failedPass || timedOut,
					spawnError,
					hwFail: Boolean(hwFail),
					timedOut,
					code,
					stderrTail: stderr.slice(-400),
				});
			});
		});

	let chosen = null;
	let engineLabel = "software";
	for (const engineOpts of engines) {
		const res = await runOnce(engineOpts, { keyframeOnly: false });
		const label =
			engineOpts.hwaccel === "software"
				? "software"
				: engineOpts.hwaccelOutputFormat
					? "videotoolbox+hwdownload"
					: "videotoolbox";
		if (!res.spawnError && !res.hwFail && !res.failed) {
			chosen = res;
			engineLabel = label;
			break;
		}
		// hwaccel failed hard → try the next engine. A clean empty plan is
		// success, not failure.
		if (res.spawnError || res.hwFail) continue;
		// timedOut / other failure on software: keep it (same as historic).
		chosen = res;
		engineLabel = label;
		break;
	}
	if (!chosen) {
		// Absolute last resort: historic empty result.
		return { boundaries: [], duration: null, engine: "failed", wallMs: Date.now() - started, cached: false };
	}

	let boundaries = chosen.boundaries;
	// Phase 1.3 keyframe coarse + local refine.
	if (o.keyframe) {
		const coarse = await runOnce(
			{ ...o, hwaccel: engineLabel.startsWith("videotoolbox") ? "videotoolbox" : "software" },
			{ keyframeOnly: true },
		);
		// Prefer coarse I-frame hits when the full pass is much larger (the
		// full pass at 360p is the expensive one we are replacing); refine
		// each coarse hit in a ±window and keep the refined cut.
		if (!coarse.failed && !coarse.spawnError && coarse.boundaries.length > 0) {
			const refined = await refineBoundaries(
				ffmpeg,
				filePath,
				o,
				coarse.boundaries,
				KEYFRAME_REFINE_WINDOW_S,
			);
			boundaries = refined.length > 0 ? refined : coarse.boundaries;
			engineLabel += "+keyframe";
		}
	}

	const result = {
		boundaries,
		duration: chosen.duration,
		engine: engineLabel,
		wallMs: Date.now() - started,
		cached: false,
	};

	if (o.cache && filePath) {
		try {
			const ident = detectCache.fileIdentity(filePath);
			detectCache.setCachedDetect(
				o.cacheDir,
				{ filePath: path.resolve(filePath), ...ident, configKey: detectConfigKey(o) },
				result,
			);
		} catch {
			/* cache write is best-effort */
		}
	}
	return result;
}

// Local full-rate refine around each coarse keyframe hit (Phase 1.3).
// Each window is a short ffmpeg pass with -ss/-t; the refined cut is the
// boundary nearest the coarse timestamp inside the window.
async function refineBoundaries(ffmpeg, filePath, o, coarseHits, windowS) {
	const out = [];
	for (const t of coarseHits) {
		const ss = Math.max(0, t - windowS);
		const dur = windowS * 2 + 0.25;
		const res = await new Promise((resolve) => {
			const args = [];
			const useHw = o.hwaccel !== "software" && o.hwaccel !== "off" && o.hwaccel !== "none";
			if (useHw) {
				args.push("-hwaccel", "videotoolbox");
				if (o.hwaccelOutputFormat) args.push("-hwaccel_output_format", "videotoolbox");
			}
			args.push(
				"-ss",
				String(ss),
				"-t",
				String(dur),
				"-i",
				filePath,
				"-filter_complex",
				buildDetectFilter(o, {
					forHwDownload: Boolean(o.hwaccelOutputFormat && useHw),
				}),
				"-map",
				"[sa]",
				"-map",
				"[sb]",
				"-f",
				"null",
				"-",
			);
			const child = spawnFfmpeg(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stderr = "";
			let settled = false;
			const done = (v) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			};
			// The old refine pass had NO timeout: one hung window wedged the
			// whole enrichment forever (and orphaned on worker kill). 60 s
			// covers a 4.25 s window many times over; on timeout keep the
			// coarse hit so the film still gets coverage.
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
				done({ boundaries: [] });
			}, REFINE_WINDOW_TIMEOUT_MS);
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			child.on("error", () => done({ boundaries: [] }));
			child.on("close", () => {
				const parsed = parseDetectStderr(stderr);
				done({
					boundaries: parsed.boundaries.map((x) => x + ss),
				});
			});
		});
		if (res.boundaries.length === 0) {
			out.push(t);
			continue;
		}
		let best = res.boundaries[0];
		let bestDist = Math.abs(best - t);
		for (const b of res.boundaries) {
			const d = Math.abs(b - t);
			if (d < bestDist) {
				bestDist = d;
				best = b;
			}
		}
		out.push(best);
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

// The segment plan for a video: [{ t, dur }] where `t` is the MIDPOINT frame
// to embed (the most representative frame of a shot) and `dur` is the shot's
// span. Shot-based when boundaries exist; interval fallback otherwise. A
// failed probe (no duration) falls back to the scene pass's own decode
// measurement, so only a fully undecodable file yields an empty plan — the
// caller records "no segments" rather than retrying forever. The plan is
// bounded by segmentBudgetFor(duration, budgetOpts) (≤ the preset's max),
// and `onProgress` (when given) is forwarded to the shot-detection pass so
// the UI sees decode progress. `budgetOpts` is a VIDEO_QUALITY_PRESETS entry
// (or null for the balanced default). `detectOpts` (Phase 1) selects
// hwaccel / height / fps / keyframe / cache — see resolveDetectOptions.
async function buildSegmentPlan(
	ffmpeg,
	filePath,
	onProgress = null,
	budgetOpts = null,
	detectOpts = null,
) {
	let duration = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* fall through to the scene-pass measurement below */
	}
	// The scene pass measures duration from its decode ticks (the parallel
	// null tap), so a container with no probeable duration (some .mkv/.ts/
	// raw captures report Duration: N/A) still gets a plan — previously it
	// was recorded as permanently "no segments". The probe is authoritative
	// when both exist; the pass measurement is ± a frame at EOF.
	const { boundaries, duration: measuredDuration } = await detectScenes(
		ffmpeg,
		filePath,
		onProgress,
		duration,
		detectOpts,
	);
	if (duration === null && measuredDuration !== null && measuredDuration > 0) {
		duration = measuredDuration;
	}
	const budget = segmentBudgetFor(duration, budgetOpts);
	let plan = [];
	if (duration !== null && duration > 0) {
		if (boundaries.length > 0) {
			const starts = [0, ...boundaries];
			const ends = [...boundaries, duration];
			const shots = starts.map((s, i) => ({
				t: (s + ends[i]) / 2,
				dur: ends[i] - s,
			}));
			// Uniform TIME coverage (Phase 5): a shot-heavy film keeps one
			// shot per (duration / budget) slice instead of the old
			// front-biased first-32, so the final act stays searchable.
			plan =
				shots.length <= budget
					? shots
					: sampleShotsEvenly(shots, duration, budget);
		} else {
			plan = buildIntervalPlan(duration, budget);
		}
	}
	return clampPlan(plan, duration);
}

// One representative JPEG for the grid card: a frame inside the clip (not
// t=0 — that is often a fade-in or title card), decoded to `width` px.
// Returns the poster file path; throws if extraction fails.
async function extractPoster(ffmpeg, filePath, destPath, width = 480) {
	let duration = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* probe failure: fall back to t=0 below */
	}
	let at = 0;
	if (duration !== null && duration > 0.5) {
		at = Math.max(0, Math.min(duration - EDGE_MARGIN, duration * 0.3));
	}
	return extractFrameAt(ffmpeg, filePath, at, destPath, width);
}

module.exports = {
	VIDEO_EXTENSIONS,
	resolveFfmpeg,
	probeDuration,
	probeHasAudio,
	extractFrames,
	extractFrameAt,
	extractFrameRaw,
	extractPoster,
	detectScenes,
	buildSegmentPlan,
	parseRawFrameSize,
	SCENE_THRESHOLD,
	resolveDetectOptions,
	detectConfigKey,
	buildDetectFilter,
	buildDetectArgs,
	parseDetectStderr,
	SEGMENT_TARGET_SECONDS,
	MIN_SEGMENTS,
	MAX_SEGMENTS,
	VIDEO_QUALITY_PRESETS,
	VIDEO_QUALITY_IDS,
	DEFAULT_VIDEO_QUALITY,
	parseVideoQuality,
	budgetForQuality,
	segmentBudgetFor,
	sampleShotsEvenly,
	buildIntervalPlan,
	clampPlan,
	setFfmpegReporter,
	spawnFfmpeg,
	killAllFfmpeg,
	getActiveFfmpegCount,
	detectAbsoluteTimeoutMs,
	DETECT_SCENES_STALL_TIMEOUT_MS,
	DETECT_SCENES_ABSOLUTE_TIMEOUT_MS,
	REFINE_WINDOW_TIMEOUT_MS,
};
