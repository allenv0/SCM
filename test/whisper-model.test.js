"use strict";

// ---------------------------------------------------------------------------
// Whisper model ladder — tiny.en / base.en picker + per-model
// timeouts + worker model passthrough + sidecar stamp + switch invalidation.
// (small.en removed: OOM-crash on 8GB Macs — legacy values alias to base.en.)
//
//   Run:  node test/whisper-model.test.js
//         bun run test:whisper-model
//
// Sections:
//   1. WHISPER_MODELS table + parseWhisperModel matrix (utils, pure)
//   2. transcribeTimeoutsFor scaling (tiny = base constants, base = 2x)
//   3. Worker: fixture returns model + utterances; invalid modelId → tiny;
//      capUtteranceText guard; real-path no-engine shape carries model
//   4. main.js wiring (source assertions): readWhisperModel, IPC pair,
//      pump passes modelId + per-model timeout, sidecar stamp, switch
//      invalidates + re-queues, mid-flight race drop
//   5. Renderer wiring (source assertions): lib/hook/preload/types/Settings
//
// Deterministic, no binaries, no network. Any failure exits 1.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const {
	WHISPER_MODELS,
	DEFAULT_WHISPER_MODEL,
	parseWhisperModel,
	transcribeTimeoutsFor,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_STALL_TIMEOUT_MS,
	TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
} = require("../indexer/transcript-store-utils.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 1. table + parse");
// ---------------------------------------------------------------------------
{
	check("two-model ladder with hf ids, tiny default", () => {
		assert.deepEqual(Object.keys(WHISPER_MODELS).sort(), [
			"base.en",
			"tiny.en",
		]);
		assert.equal(WHISPER_MODELS["tiny.en"].hfId, "Xenova/whisper-tiny.en");
		assert.equal(WHISPER_MODELS["base.en"].hfId, "Xenova/whisper-base.en");
		assert.equal(DEFAULT_WHISPER_MODEL, "tiny.en");
		for (const m of Object.values(WHISPER_MODELS)) {
			assert.ok(m.paramsM > 0 && m.downloadMB > 0 && m.speedVsTiny >= 1);
		}
		// Strictly increasing cost up the ladder.
		assert.ok(
			WHISPER_MODELS["tiny.en"].paramsM < WHISPER_MODELS["base.en"].paramsM,
		);
	});

	check("parseWhisperModel matrix (small.en legacy alias → base.en)", () => {
		assert.equal(parseWhisperModel("tiny.en"), "tiny.en");
		assert.equal(parseWhisperModel("base.en"), "base.en");
		assert.equal(parseWhisperModel("small.en"), "base.en");
		for (const bad of [
			null,
			undefined,
			"",
			"small",
			"Tiny.en",
			"TINY.EN",
			"large-v3",
			"tiny",
			42,
			{},
		]) {
			assert.equal(
				parseWhisperModel(bad),
				"tiny.en",
				`garbage must fall back: ${JSON.stringify(bad)}`,
			);
		}
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 2. per-model timeouts");
// ---------------------------------------------------------------------------
{
	check(
		"tiny = base constants; base scales chunk+stall, heartbeat fixed",
		() => {
			const tiny = transcribeTimeoutsFor("tiny.en");
			assert.equal(tiny.chunkTimeoutMs, TRANSCRIBE_CHUNK_TIMEOUT_MS);
			assert.equal(tiny.stallTimeoutMs, TRANSCRIBE_STALL_TIMEOUT_MS);
			assert.equal(tiny.heartbeatIntervalMs, TRANSCRIBE_HEARTBEAT_INTERVAL_MS);
			const base = transcribeTimeoutsFor("base.en");
			assert.equal(base.chunkTimeoutMs, TRANSCRIBE_CHUNK_TIMEOUT_MS * 2);
			assert.equal(base.stallTimeoutMs, TRANSCRIBE_STALL_TIMEOUT_MS * 2);
			assert.equal(base.heartbeatIntervalMs, TRANSCRIBE_HEARTBEAT_INTERVAL_MS);
			assert.equal(
				transcribeTimeoutsFor("garbage").chunkTimeoutMs,
				TRANSCRIBE_CHUNK_TIMEOUT_MS,
			);
			assert.equal(
				transcribeTimeoutsFor("small.en").chunkTimeoutMs,
				TRANSCRIBE_CHUNK_TIMEOUT_MS * 2,
			);
		},
	);
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 3. worker model passthrough + utterances");
// ---------------------------------------------------------------------------
{
	const w = require("../indexer/transcribe-worker.js");

	check("worker exports utterance cap helpers", () => {
		assert.equal(typeof w.capUtteranceText, "function");
		assert.ok(
			w.UTTERANCE_MAX_CHARS >= 240,
			"utterance cap must exceed the 240-char window cap",
		);
		assert.ok(w.capUtteranceText("  a  b  ").length > 0);
		assert.equal(
			w.capUtteranceText("x".repeat(10000)).length,
			w.UTTERANCE_MAX_CHARS,
		);
	});

	check("fixture returns resolved model + overlapped utterances", async () => {
		const env = {
			...process.env,
			TRANSCRIBE_FIXTURE: JSON.stringify([
				{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
				{ t0: 40, t1: 48, text: "The architecture diagram shows the flow." },
			]),
		};
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'base.en'}).then(o=>console.log(JSON.stringify(o))))",
				env.TRANSCRIBE_FIXTURE,
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "base.en");
		assert.ok(
			Array.isArray(out.utterances) && out.utterances.length === 2,
			`expected 2 utterances, got ${JSON.stringify(out.utterances)}`,
		);
		assert.ok(out.utterances[0].text.includes("pricing"));
	});

	check("legacy small.en resolves to base.en (never throws)", async () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'small.en'}).then(o=>console.log(JSON.stringify(o))))",
				JSON.stringify([{ t0: 0, t1: 8, text: "Hello world today." }]),
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "base.en");
	});

	check("invalid modelId resolves to tiny (never throws)", async () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'large-v3'}).then(o=>console.log(JSON.stringify(o))))",
				JSON.stringify([{ t0: 0, t1: 8, text: "Hello world today." }]),
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "tiny.en");
	});

	check("no engine → valid empty still carries model", async () => {
		const env = {
			...process.env,
			FFMPEG_PATH: "/nonexistent/ffmpeg-for-tests",
			TRANSFORMERS_CACHE: "/nonexistent/cache-for-tests",
		};
		delete env.TRANSCRIBE_FIXTURE;
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'base.en'}).then(o=>console.log(JSON.stringify(o))))",
			],
			{
				cwd: ROOT,
				env,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.done, true);
		assert.deepEqual(out.chunks, []);
		assert.equal(out.model, "base.en");
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 4. main.js wiring");
// ---------------------------------------------------------------------------
{
	const main = read("main.js");

	check("readWhisperModel validated fallback", () => {
		// C-01 Wave 2 (S1): settings accessors live in main-lib/settings.js.
		const settings = read("main-lib/settings.js");
		assert.ok(
			settings.includes("function readWhisperModel"),
			"missing readWhisperModel",
		);
		assert.ok(
			settings.includes("parseWhisperModel(readSettings().whisperModel)"),
			"must read settings.json via parse",
		);
	});

	check("IPC get/set-whisper-model pair", () => {
		assert.ok(
			main.includes("memories:get-whisper-model"),
			"missing get channel",
		);
		assert.ok(
			main.includes("memories:set-whisper-model"),
			"missing set channel",
		);
		assert.ok(
			main.includes("Unknown speech model (expected tiny.en or base.en)"),
			"missing validation error",
		);
	});

	check("legacy small.en migrates to base.en + orphan weights swept", () => {
		// C-01 Wave 2 (S1): the weights cleanup lives in
		// main-lib/settings.js; the migration + IPC alias stay in main.js.
		const settings = read("main-lib/settings.js");
		assert.ok(
			main.includes('requested === "small.en"'),
			"IPC must alias stale small.en requests",
		);
		assert.ok(
			main.includes("function migrateRemovedWhisperModel"),
			"missing removal migration",
		);
		assert.ok(
			settings.includes("function cleanupRemovedWhisperWeights"),
			"missing weights cleanup",
		);
		assert.ok(
			settings.includes("whisper-small.en"),
			"cleanup must target the small.en cache",
		);
	});

	check("switch invalidates sidecar + re-queues", () => {
		const fn = main.slice(
			main.indexOf('ipcMain.handle("memories:set-whisper-model"'),
		);
		assert.ok(fn.includes("c.videos = new Map()"), "must clear chunks");
		assert.ok(fn.includes("c.rows = []"), "must clear bin rows");
		assert.ok(
			fn.includes("c.utterances = new Map()"),
			"must clear utterance lines",
		);
		assert.ok(fn.includes("c.progress = {}"), "must clear progress");
		assert.ok(fn.includes("enqueueTranscription"), "must re-queue library");
	});

	check("pump passes modelId + per-model timeout + race check", () => {
		const fn = main.slice(main.indexOf("async function pumpTranscription"));
		assert.ok(fn.includes("readWhisperModel()"), "pump must read the setting");
		assert.ok(
			fn.includes("transcribeTimeoutsFor(whisperModel)"),
			"pump must size timeouts per model",
		);
		assert.ok(
			fn.includes("modelId: whisperModel"),
			"message must carry modelId",
		);
		assert.ok(
			fn.includes("timeouts.chunkTimeoutMs"),
			"askTranscribe must use the scaled ceiling",
		);
		assert.ok(
			fn.includes("changed mid-flight"),
			"must drop stale-model replies",
		);
	});

	check("sidecar stamps + validates whisperModel + utterance lines", () => {
		// C-01 Wave 2 (S4): the transcript sidecar lives in
		// main-lib/library-store.js.
		const store = read("main-lib/library-store.js");
		assert.ok(
			store.includes("whisperModel: DEFAULT_WHISPER_MODEL"),
			"cache default stamp",
		);
		assert.ok(
			store.includes('parseWhisperModel(parsed.whisperModel || "tiny.en")'),
			"pre-stamp sidecars read as tiny.en",
		);
		assert.ok(
			store.includes("whisperModel: parseWhisperModel(c.whisperModel)"),
			"save stamps validated model",
		);
		assert.ok(
			store.includes("utterances: new Map()"),
			"cache carries utterance lines",
		);
		assert.ok(
			store.includes("utterances: c.utterances.get(filename)"),
			"save persists per-film lines",
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 5. renderer wiring");
// ---------------------------------------------------------------------------
{
	check("lib parse + hook + preload + types + Settings UI", () => {
		const lib = read("src/lib/whisperModel.ts");
		assert.ok(
			lib.includes('"tiny.en"') && lib.includes('"base.en"'),
			"lib must list 2 ids",
		);
		assert.ok(
			!lib.includes('"small.en": "Best words'),
			"small.en option must be gone",
		);
		assert.ok(
			lib.includes('raw === "small.en"'),
			"lib must keep the legacy alias",
		);
		const hook = read("src/hooks/useWhisperModel.ts");
		assert.ok(
			hook.includes("getWhisperModel") && hook.includes("setWhisperModel"),
			"hook must bridge both",
		);
		const preload = read("preload.js");
		assert.ok(
			preload.includes("memories:get-whisper-model"),
			"missing get bridge",
		);
		assert.ok(
			preload.includes("memories:set-whisper-model"),
			"missing set bridge",
		);
		const types = read("src/types.d.ts");
		assert.ok(
			types.includes("getWhisperModel") && types.includes("setWhisperModel"),
			"missing type declarations",
		);
		const settings = read("src/components/SettingsSheet.tsx");
		assert.ok(
			settings.includes('aria-label="Speech model"'),
			"missing Settings radio group",
		);
		assert.ok(
			settings.includes("onWhisperModelChange"),
			"missing change handler prop",
		);
		assert.ok(
			settings.includes("re-transcribing"),
			"must warn about re-transcription",
		);
		const app = read("src/App.tsx");
		assert.ok(app.includes("useWhisperModel"), "App must mount the hook");
	});
}

console.log(`\n[whisper-model] ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
