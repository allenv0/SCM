"use strict";

// Transcribe worker. Runs under Electron's utilityProcess (plain Node — same
// environment as the OCR worker). Speech transcription is CPU-heavy and long
// (minutes per film), unrelated to onnxruntime CLIP inference, so it lives
// in a DEDICATED process rather than inside the CLIP indexer worker. Answers:
//   { type: "transcribe-video", path, filename, fromIndex, id } →
//   { type: "transcribe-done", id, ok, chunks:[{t0,t1,text}], fromIndex, total, done, error }
//   { type: "shutdown" } → process.exit(0)
// Progress is broadcast as { type: "transcribe-progress", filename, ...p }
// per 30 s audio slice, so the renderer's tray ticks while a film decodes.
//
// Engine: transformers.js Whisper (`Xenova/whisper-tiny.en` /
// `Xenova/whisper-base.en`, automatic-speech-recognition) — fully local,
// no native binary to package or notarize, ~150-300 MB download reused
// offline from TRANSFORMERS_CACHE, CPU background-friendly on base M1. Audio comes from the bundled ffmpeg
// (16 kHz mono wav slices, one per 30 s window). When the engine is
// unavailable (model download failed, no ffmpeg) the worker returns valid
// empty chunks (silent-film shape) instead of failing — the speech index
// stays visual-only and everything else keeps working. Tests drive
// deterministic output via TRANSCRIBE_FIXTURE=json (no model, no ffmpeg).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const {
	TRANSCRIPTS_PER_CHUNK,
	buildTranscriptChunks,
	parseWhisperModel,
	WHISPER_MODELS,
} = require("./transcript-store-utils.js");

// One whisper slice covers this many seconds of film. Matches Whisper's
// native 30 s window, so no intra-slice chunking/stride is needed.
const SLICE_SECONDS = 30;
// Default model (env override for benchmarks/CI). Production passes
// `modelId` per transcribe-video message (Settings → Speech model); the
// pipeline below reloads on change.
const WHISPER_MODEL_ID =
	process.env.WHISPER_MODEL_ID || WHISPER_MODELS["tiny.en"].hfId;

// Full utterance text cap for the sidecar (whisper chunk texts are seconds
// of speech, ~100-200 chars; the cap is a guard, never a truncation in
// practice — unlike the 240-char search-window cap in buildTranscriptChunks).
const UTTERANCE_MAX_CHARS = 500;

function post(message) {
	if (process.parentPort) {
		process.parentPort.postMessage(message);
	}
}

// Orphan-proof ffmpeg tracking (same fix as video-utils): every wav-slice
// ffmpeg is registered so kill-ffmpeg / shutdown / process exit SIGKILLs it
// instead of orphaning to PID 1. Main also tracks reported PIDs so it can
// kill by PID after this worker dies.
let transcribeVideoUtils = null;
try {
	transcribeVideoUtils = require("./video-utils.js");
	transcribeVideoUtils.setFfmpegReporter((event) => {
		if (!event) return;
		if (event.type === "ffmpeg-spawn" || event.type === "ffmpeg-exit") {
			post({ ...event });
		}
	});
} catch {
	transcribeVideoUtils = null;
}

function killTranscribeFfmpeg(reason) {
	if (
		transcribeVideoUtils &&
		typeof transcribeVideoUtils.killAllFfmpeg === "function"
	) {
		try {
			return transcribeVideoUtils.killAllFfmpeg(reason || "transcribe");
		} catch {
			return 0;
		}
	}
	return 0;
}

try {
	if (typeof process.on === "function") {
		process.on("exit", () => {
			killTranscribeFfmpeg("exit");
		});
	}
} catch {
	/* best-effort */
}

// Slice plan for a film of `durationSeconds` (null/unknown → single pass).
// Pure: { total, start(i), dur(i) }. fromIndex/total in replies count SLICES;
// returned `chunks` are transcript WINDOWS found in those slices (fewer when
// speech is sparse — mergeChunkTranscripts only appends, so this is safe).
function slicesForDuration(durationSeconds) {
	if (!(durationSeconds > 0)) {
		return {
			total: 1,
			start: () => 0,
			dur: () => 0, // 0 = whole file (no -t cap)
		};
	}
	const total = Math.max(1, Math.ceil(durationSeconds / SLICE_SECONDS));
	return {
		total,
		start: (i) => i * SLICE_SECONDS,
		dur: () => SLICE_SECONDS + 5, // 5 s overlap so boundary words survive
	};
}

// Shift slice-relative whisper timestamps to film-absolute time.
// Pure: [{t0, t1, text}] with sliceStart added, non-finite dropped.
function offsetUtterances(utterances, sliceStart) {
	const out = [];
	for (const u of utterances || []) {
		if (!u || !Number.isFinite(u.t0) || !Number.isFinite(u.t1) || u.t1 <= u.t0)
			continue;
		if (typeof u.text !== "string" || u.text.trim().length === 0) continue;
		out.push({
			t0: u.t0 + sliceStart,
			t1: u.t1 + sliceStart,
			text: u.text.trim(),
		});
	}
	return out;
}

// Parse a 16-bit PCM mono WAV (ffmpeg `pcm_s16le`) into Float32 samples.
// Pure: skips the 44-byte header, normalizes int16 → [-1, 1]. Throws on
// truncated/garbage buffers (caller treats as silence, never a failure).
function wavToFloat32(buffer) {
	const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (bytes.length < 44 + 2) throw new Error("wav too short");
	const data = bytes.subarray(44);
	if (data.length % 2 !== 0) throw new Error("wav data not int16-aligned");
	const samples = new Float32Array(data.length / 2);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = data.readInt16LE(i * 2) / 32768;
	}
	return samples;
}

function runCmd(bin, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		let child;
		if (
			transcribeVideoUtils &&
			typeof transcribeVideoUtils.spawnFfmpeg === "function"
		) {
			child = transcribeVideoUtils.spawnFfmpeg(bin, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} else {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		}
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		// stdout is the wav bytes — drained by the caller via pipe, not here.
		child.stdout.resume();
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`timed out after ${timeoutMs}ms: ${stderr.slice(-300)}`),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stderr });
			else reject(new Error(`exited ${code}: ${stderr.slice(-300)}`));
		});
	});
}

// Extract one wav slice to `destPath` (16 kHz mono s16le). Whole file when
// sliceDur is 0 (unknown duration). Rejects on failure (caller skips the
// slice — a gap, never a stuck queue).
async function extractWavSlice(
	ffmpeg,
	filePath,
	sliceStart,
	sliceDur,
	destPath,
) {
	const args =
		sliceDur > 0
			? [
					"-y",
					"-ss",
					String(sliceStart),
					"-i",
					filePath,
					"-t",
					String(sliceDur),
				]
			: ["-y", "-i", filePath];
	args.push("-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", destPath);
	await runCmd(ffmpeg, args, 120000);
	const stat = fs.statSync(destPath);
	if (!stat.size || stat.size < 44 + 3200) {
		// <0.1 s of audio — silence / no audio stream.
		throw new Error("empty audio slice");
	}
}

function resolveFfmpeg() {
	if (process.env.FFMPEG_PATH) {
		if (fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
		throw new Error(`FFMPEG_PATH set but missing: ${process.env.FFMPEG_PATH}`);
	}
	if (process.resourcesPath) {
		const p = path.join(process.resourcesPath, "ffmpeg");
		if (fs.existsSync(p)) return p;
	}
	try {
		const p = require("ffmpeg-static");
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* fall through */
	}
	throw new Error("No ffmpeg binary available");
}

// Fixture path for deterministic tests: TRANSCRIBE_FIXTURE=json array of
// {t0,t1,text} utterances covering the whole film. When set, no ffmpeg or
// model runs — the fixture is chunked directly.
function fixtureUtterances() {
	if (!process.env.TRANSCRIBE_FIXTURE) return null;
	try {
		const parsed = JSON.parse(process.env.TRANSCRIBE_FIXTURE);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* fall through to real path */
	}
	return null;
}

// Keyed singleton: { model, pipeline }. A model switch drops the old
// pipeline (frees the resident weights) and loads the new one — the worker
// is long-lived, so without this a Settings change would never take effect.
let asrState = { model: null, pipeline: null };
let asrFailedFor = null;

async function ensureAsr(modelId, onProgress) {
	const want = parseWhisperModel(modelId);
	if (asrState.pipeline && asrState.model === want) return asrState.pipeline;
	if (asrFailedFor === want) return null;
	asrState = { model: null, pipeline: null };
	try {
		const mod = await import("@huggingface/transformers");
		if (process.env.TRANSFORMERS_CACHE) {
			mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
		}
		const hfId =
			(WHISPER_MODELS[want] && WHISPER_MODELS[want].hfId) || WHISPER_MODEL_ID;
		const pipeline = await mod.pipeline("automatic-speech-recognition", hfId, {
			progress_callback: (progress) => {
				if (
					progress.status === "progress" &&
					progress.total > 0 &&
					onProgress
				) {
					try {
						onProgress({
							phase: "model",
							model: want,
							loaded: progress.loaded,
							total: progress.total,
						});
					} catch {
						/* progress must never fail the chunk */
					}
				}
			},
		});
		asrState = { model: want, pipeline };
		asrFailedFor = null;
		return pipeline;
	} catch (err) {
		console.warn(
			`[transcribe] whisper model ${want} unavailable (${err.message}) — speech index stays visual-only`,
		);
		asrFailedFor = want;
		return null;
	}
}

function capUtteranceText(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, UTTERANCE_MAX_CHARS);
}

// One whisper decode with timestamp collapse fallback. The timestamped
// decode can collapse to EMPTY text + zero chunks on sparse/quiet speech
// (verified: a 19 s clip with clear speech decodes verbatim without
// timestamps but empty with return_timestamps:true) while a plain decode
// of the same samples hears it fine — and an empty result here becomes a
// permanent transcript gap (never retried). So when the timestamped decode
// comes back empty, retry ONCE without timestamps; the caller then keeps
// the whole-slice text via its existing no-timestamps fallback. Bounded:
// one extra decode, only for slices that decoded empty. Returns the
// effective pipeline output ({ text, chunks }) for the slice.
async function decodeSliceWithFallback(asr, samples, label) {
	const timed = await asr(samples, {
		chunk_length_s: 30,
		stride_length_s: 5,
		return_timestamps: true,
	});
	const timedText =
		timed && typeof timed.text === "string" ? timed.text.trim() : "";
	const timedChunks = (timed && timed.chunks) || [];
	if (timedText.length > 0 || timedChunks.length > 0) return timed;
	let plain;
	try {
		plain = await asr(samples, {
			chunk_length_s: 30,
			stride_length_s: 5,
		});
	} catch (err) {
		console.warn(
			`[transcribe] plain-decode retry failed for ${label}: ${err.message}`,
		);
		return timed;
	}
	const plainText =
		plain && typeof plain.text === "string" ? plain.text.trim() : "";
	if (plainText.length === 0) return timed;
	return { ...plain, chunks: [] };
}

async function transcribeVideo(filePath, fromIndex = 0, opts = {}) {
	const onProgress = opts.onProgress || null;
	const model = parseWhisperModel(opts.modelId || process.env.WHISPER_MODEL_ID);
	const report = (p) => {
		if (!onProgress) return;
		try {
			onProgress(p);
		} catch {
			/* progress must never fail the chunk */
		}
	};
	// Deterministic fixture (tests, CI without binaries).
	const fixture = fixtureUtterances();
	if (fixture) {
		const chunks = buildTranscriptChunks(fixture);
		const slice = chunks.slice(fromIndex, fromIndex + TRANSCRIPTS_PER_CHUNK);
		report({
			phase: "transcribe",
			done: fromIndex + slice.length,
			total: chunks.length,
		});
		// Utterances overlapped by this call's chunk span (same paging
		// contract as chunks: time-bounded, full text, absolute times).
		let utterances = [];
		if (slice.length > 0) {
			const spanT0 = slice[0].t0;
			const spanT1 = slice[slice.length - 1].t1;
			utterances = fixture
				.filter((u) => u && u.t1 > spanT0 && u.t0 < spanT1)
				.map((u) => ({ t0: u.t0, t1: u.t1, text: capUtteranceText(u.text) }))
				.filter((u) => u.text.length > 0);
		}
		return {
			done: fromIndex + slice.length >= chunks.length,
			chunks: slice,
			utterances,
			fromIndex: fromIndex + slice.length,
			total: chunks.length,
			model,
		};
	}
	// Plan slices across the film's duration (probe failure → whole file).
	let duration;
	let ffmpeg;
	try {
		const videoUtils = require("./video-utils.js");
		ffmpeg = resolveFfmpeg();
		try {
			duration = await videoUtils.probeDuration(ffmpeg, filePath);
		} catch {
			duration = null;
		}
	} catch (err) {
		// No ffmpeg at all: valid empty result (never retry-forever).
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: 0,
			model,
			note: String(err.message).slice(0, 120),
		};
	}
	const plan = slicesForDuration(duration);
	const sliceIndexes = [];
	for (
		let i = fromIndex;
		i < Math.min(plan.total, fromIndex + TRANSCRIPTS_PER_CHUNK);
		i++
	) {
		sliceIndexes.push(i);
	}
	if (sliceIndexes.length === 0) {
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: plan.total,
			model,
		};
	}
	// Announce load start BEFORE the weights load: ONNX graph construction
	// emits zero download-progress ticks, so without this the main process
	// cannot tell "model loading for minutes" from "wedged with no output"
	// when the worker later dies — every load-phase crash would look phaseless.
	report({
		phase: "model",
		filename: opts.filename,
		model,
		loaded: 0,
		total: 0,
	});
	const asr = await ensureAsr(model, (p) =>
		report({ filename: opts.filename, ...p }),
	);
	if (!asr) {
		// Model unavailable: valid empty result for THIS call only — the
		// main process records chunks:[] so the file is not retried.
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: plan.total,
			model,
		};
	}
	const utterances = [];
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-transcribe-"));
	try {
		for (const [n, si] of sliceIndexes.entries()) {
			const sliceStart = duration && duration > 0 ? plan.start(si) : 0;
			const sliceDur = duration && duration > 0 ? plan.dur(si) : 0;
			const wavPath = path.join(tmpDir, `slice-${si}.wav`);
			try {
				await extractWavSlice(ffmpeg, filePath, sliceStart, sliceDur, wavPath);
				const samples = wavToFloat32(fs.readFileSync(wavPath));
				if (samples.length < 16000 * 0.5) continue; // <0.5 s — silence
				const out = await decodeSliceWithFallback(
					asr,
					samples,
					opts.filename || filePath,
				);
				const rawChunks = (out && out.chunks) || [];
				const sliceUtterances = rawChunks
					.filter(
						(c) => c && typeof c.text === "string" && c.text.trim().length > 0,
					)
					.map((c) => ({
						t0: Number(c.timestamp?.[0]),
						t1: Number(c.timestamp?.[1]),
						text: capUtteranceText(c.text),
					}))
					.filter(
						(u) =>
							Number.isFinite(u.t0) &&
							Number.isFinite(u.t1) &&
							u.t1 > u.t0 &&
							u.text.length > 0,
					);
				// No chunk timestamps (very short slice): keep whole-slice text.
				if (
					sliceUtterances.length === 0 &&
					out &&
					typeof out.text === "string" &&
					out.text.trim().length > 0
				) {
					const end =
						sliceDur > 0
							? sliceStart + Math.min(sliceDur, 30)
							: sliceStart + 30;
					const whole = capUtteranceText(out.text);
					if (whole.length > 0)
						utterances.push({ t0: sliceStart, t1: end, text: whole });
				} else {
					utterances.push(...offsetUtterances(sliceUtterances, sliceStart));
				}
			} catch (sliceErr) {
				// One bad slice (corrupt GOP, silent stretch) is a gap, never
				// a stuck queue.
				console.warn(
					`[transcribe] slice ${si} skipped for ${opts.filename || filePath}: ${sliceErr.message}`,
				);
			} finally {
				try {
					fs.unlinkSync(wavPath);
				} catch {
					/* best-effort */
				}
				report({
					phase: "transcribe",
					done: fromIndex + n + 1,
					total: plan.total,
					filename: opts.filename,
				});
			}
		}
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	const chunks = buildTranscriptChunks(utterances);
	const nextIndex = fromIndex + sliceIndexes.length;
	return {
		done: nextIndex >= plan.total,
		chunks,
		// Absolute-time, full-text utterances for THIS call's slices (the
		// exact-search index; main accumulates them like chunks). Capped per
		// utterance by capUtteranceText, never by the 240-char window cap.
		utterances: utterances
			.map((u) => ({ t0: u.t0, t1: u.t1, text: capUtteranceText(u.text) }))
			.filter((u) => u.text.length > 0),
		fromIndex: nextIndex,
		total: plan.total,
		model,
	};
}

async function handleMessage(message) {
	const { type, id } = message;
	try {
		if (type === "transcribe-video") {
			const { path: filePath, fromIndex = 0, filename, modelId } = message;
			const out = await transcribeVideo(filePath, fromIndex, {
				filename,
				modelId,
				onProgress: (p) =>
					post({ type: "transcribe-progress", filename, ...p }),
			});
			post({ type: "transcribe-done", id, ok: true, ...out });
			return;
		}
		if (type === "kill-ffmpeg") {
			let killed = 0;
			try {
				killed = killTranscribeFfmpeg("ipc kill-ffmpeg");
			} catch {
				/* best-effort */
			}
			post({ type: "ffmpeg-killed", id, ok: true, killed });
			return;
		}
		if (type === "shutdown") {
			try {
				killTranscribeFfmpeg("shutdown");
			} catch {
				/* best-effort */
			}
			process.exit(0);
		}
	} catch (err) {
		post({ type, ok: false, id, error: err.message });
	}
}

if (process.parentPort) {
	process.parentPort.on("message", (event) => {
		const message = event.data;
		void handleMessage(message);
	});
}

// Standalone: `node indexer/transcribe-worker.js --smoke` exercises the
// fixture path without Electron, ffmpeg, or model download.
if (require.main === module && process.argv.includes("--smoke")) {
	(async () => {
		process.env.TRANSCRIBE_FIXTURE = JSON.stringify([
			{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
			{ t0: 10, t1: 18, text: "Where she explains the refund policy clearly." },
			{ t0: 40, t1: 48, text: "The architecture diagram shows the new flow." },
		]);
		const out = await transcribeVideo("smoke.mp4", 0, {});
		console.log(JSON.stringify(out, null, 2));
	})();
}

module.exports = {
	transcribeVideo,
	slicesForDuration,
	offsetUtterances,
	wavToFloat32,
	SLICE_SECONDS,
	WHISPER_MODEL_ID,
	UTTERANCE_MAX_CHARS,
	capUtteranceText,
	decodeSliceWithFallback,
};
