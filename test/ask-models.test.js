"use strict";

// Ask LLM registry + config matrix (MDs/Ask-Mode-Plan.md). Plain-node,
// no network: the registry shape is the download contract, the config
// parser is the validated-fallback gate for settings.json `llm`.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
	LLM_SERVER,
	LLM_MODELS,
	DEFAULT_LLM_MODEL_ID,
	getLlmModel,
	resolveLlmModelId,
} = require("../main-lib/llm/models.js");
const {
	initLlmConfig,
	parseLlmConfig,
	readLlmConfig,
	writeLlmConfig,
	llmModelInfos,
} = require("../main-lib/llm/config.js");
const { initSettings } = require("../main-lib/settings.js");

// Async checks run SEQUENTIALLY (each one re-inits the server module's
// injected fetcher — shared state means they must not interleave).
let asyncChain = Promise.resolve();
function check(name, fn) {
	if (fn.constructor.name === "AsyncFunction") {
		asyncChain = asyncChain.then(fn).then(
			() => console.log(`ok - ${name}`),
			(err) => {
				console.error(`FAIL - ${name}`);
				console.error(err && err.stack ? err.stack : err);
				process.exitCode = 1;
			},
		);
		return;
	}
	try {
		fn();
		console.log(`ok - ${name}`);
	} catch (err) {
		console.error(`FAIL - ${name}`);
		console.error(err && err.stack ? err.stack : err);
		process.exitCode = 1;
	}
}

check("default model exists; unknown ids resolve to the default", () => {
	assert.ok(getLlmModel(DEFAULT_LLM_MODEL_ID));
	assert.equal(resolveLlmModelId("nope"), DEFAULT_LLM_MODEL_ID);
	assert.equal(getLlmModel("nope"), null);
	// Every registered id round-trips.
	for (const id of Object.keys(LLM_MODELS)) {
		assert.equal(resolveLlmModelId(id), id);
	}
});

check("every model entry carries the fields the pipeline needs", () => {
	for (const [id, m] of Object.entries(LLM_MODELS)) {
		assert.ok(m.label, `${id} label`);
		assert.ok(m.shortLabel && !m.shortLabel.includes(" "), `${id} short label`);
		assert.ok(m.hfRepo.includes("/"), `${id} hfRepo org/name`);
		assert.ok(m.hfFile.endsWith(".gguf"), `${id} gguf file`);
		assert.ok(
			m.downloadUrl.startsWith("https://huggingface.co/"),
			`${id} https HF url`,
		);
		assert.ok(m.downloadUrl.includes(m.hfRepo), `${id} url repo`);
		assert.ok(m.downloadUrl.endsWith(m.hfFile), `${id} url file`);
		assert.ok(m.sizeBytes > 500_000_000, `${id} plausible size`);
		assert.ok(m.ctxTokens >= 4096, `${id} ctx fits the evidence budget`);
		assert.ok(m.license, `${id} license`);
		assert.ok(m.minimumModelBytes > 0, `${id} minimum bytes floor`);
	}
});

check("server release registry covers this machine's arch", () => {
	assert.ok(LLM_SERVER.repo.includes("/"));
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	assert.ok(LLM_SERVER.archPatterns[arch] instanceof RegExp);
	// The pattern must match every archive format upstream has shipped —
	// zip historically, tar.gz since the nightly-only release scheme.
	for (const sample of [
		"llama-b0000-bin-macos-arm64.zip",
		"llama-b10964-bin-macos-arm64.tar.gz",
	]) {
		assert.ok(
			LLM_SERVER.archPatterns[arch].test(sample),
			`pattern misses ${sample}`,
		);
	}
});

check(
	"release resolution follows the stub-latest → nightly-tag pointer (upstream 2026 layout)",
	async () => {
		const { initLlmServer } = require("../main-lib/llm/server.js");
		const { resolveReleaseAsset } = require("../main-lib/llm/server.js");
		const os = require("os");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-llm-release-"));
		// The September-2026 shape: "latest" carries only nightly-tag.txt;
		// the real binaries live under the pointed-at tag as .tar.gz.
		const responses = {
			"https://api.github.com/repos/ggml-org/llama.cpp/releases/latest": {
				tag_name: "v0.4.1",
				assets: [
					{
						name: "nightly-tag.txt",
						browser_download_url: "https://example.com/nightly-tag.txt",
					},
				],
			},
			"https://example.com/nightly-tag.txt": "b10964\n",
			"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10964": {
				tag_name: "b10964",
				assets: [
					{
						name: "llama-b10964-bin-macos-arm64.tar.gz",
						size: 11_000_000,
						browser_download_url: "https://example.com/llama.tar.gz",
					},
					{
						name: "llama-b10964-bin-win-cuda-x64.zip",
						size: 300_000_000,
						browser_download_url: "https://example.com/win.zip",
					},
				],
			},
		};
		initLlmServer({
			userDataDir: tmp,
			fetchImpl: async (url) => {
				const body = responses[url];
				if (typeof body === "string") {
					return { ok: true, text: async () => body };
				}
				if (!body) return { ok: false, json: async () => ({}) };
				return { ok: true, json: async () => body };
			},
		});
		try {
			const picked = await resolveReleaseAsset();
			assert.equal(picked.tag, "b10964");
			assert.equal(picked.asset.name, "llama-b10964-bin-macos-arm64.tar.gz");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	},
);

check("release resolution errors clearly when no binary exists", async () => {
	const { initLlmServer } = require("../main-lib/llm/server.js");
	const { resolveReleaseAsset } = require("../main-lib/llm/server.js");
	const os = require("os");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-llm-release-"));
	initLlmServer({
		userDataDir: tmp,
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ tag_name: "v9", assets: [] }),
		}),
	});
	try {
		await assert.rejects(() => resolveReleaseAsset(), /no macOS/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

check("parseLlmConfig falls back on every malformed shape", () => {
	const dflt = parseLlmConfig(null);
	assert.deepEqual(dflt, { enabled: false, chatModel: DEFAULT_LLM_MODEL_ID });
	assert.deepEqual(parseLlmConfig(undefined), dflt);
	assert.deepEqual(parseLlmConfig("garbage"), dflt);
	assert.deepEqual(parseLlmConfig(42), dflt);
	assert.deepEqual(parseLlmConfig({}), dflt);
	assert.deepEqual(parseLlmConfig({ enabled: "yes" }), dflt);
	// Unknown model ids resolve (never stored raw).
	assert.equal(
		parseLlmConfig({ chatModel: "gone" }).chatModel,
		DEFAULT_LLM_MODEL_ID,
	);
});

check("parseLlmConfig accepts valid shapes", () => {
	const alt = Object.keys(LLM_MODELS).find((id) => id !== DEFAULT_LLM_MODEL_ID);
	assert.deepEqual(parseLlmConfig({ enabled: true, chatModel: alt }), {
		enabled: true,
		chatModel: alt,
	});
	assert.deepEqual(parseLlmConfig({ enabled: true }), {
		enabled: true,
		chatModel: DEFAULT_LLM_MODEL_ID,
	});
});

check("read/write round-trips through the atomic settings file", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-llm-config-"));
	initSettings({ userDataDir: tmp });
	initLlmConfig({ userDataDir: tmp });
	assert.equal(readLlmConfig().enabled, false);
	const written = writeLlmConfig({ enabled: true });
	assert.equal(written.enabled, true);
	assert.equal(readLlmConfig().enabled, true);
	// Unknown model id resolves on write; the stored JSON carries the
	// resolved id, not the garbage.
	const next = writeLlmConfig({ chatModel: "does-not-exist" });
	assert.equal(next.chatModel, DEFAULT_LLM_MODEL_ID);
	const raw = JSON.parse(
		fs.readFileSync(path.join(tmp, "settings.json"), "utf-8"),
	);
	assert.equal(raw.llm.chatModel, DEFAULT_LLM_MODEL_ID);
	assert.equal(raw.llm.enabled, true);
	fs.rmSync(tmp, { recursive: true, force: true });
});

check("a non-default chatModel persists (the model-switch contract)", () => {
	// Regression for "downloaded Llama but Ask keeps answering with Qwen":
	// the Settings selector writes { chatModel } through this exact path,
	// so a valid non-default id must survive the write AND the re-read (and
	// land verbatim in settings.json — never resolved back to the default).
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-llm-switch-"));
	initSettings({ userDataDir: tmp });
	initLlmConfig({ userDataDir: tmp });
	const alt = Object.keys(LLM_MODELS).find((id) => id !== DEFAULT_LLM_MODEL_ID);
	assert.ok(alt, "registry needs a second model for the switch test");
	const written = writeLlmConfig({ enabled: true, chatModel: alt });
	assert.equal(written.chatModel, alt);
	assert.equal(readLlmConfig().chatModel, alt);
	const raw = JSON.parse(
		fs.readFileSync(path.join(tmp, "settings.json"), "utf-8"),
	);
	assert.equal(raw.llm.chatModel, alt);
	// Switching back round-trips too.
	assert.equal(
		writeLlmConfig({ chatModel: DEFAULT_LLM_MODEL_ID }).chatModel,
		DEFAULT_LLM_MODEL_ID,
	);
	assert.equal(readLlmConfig().chatModel, DEFAULT_LLM_MODEL_ID);
	fs.rmSync(tmp, { recursive: true, force: true });
});

check("llmModelInfos feeds the Settings UI from the registry", () => {
	const rows = llmModelInfos((id) => id === DEFAULT_LLM_MODEL_ID);
	assert.equal(rows.length, Object.keys(LLM_MODELS).length);
	for (const row of rows) {
		assert.equal(row.downloaded, row.id === DEFAULT_LLM_MODEL_ID);
		assert.ok(row.sizeBytes > 0);
		assert.ok(typeof row.blurb === "string" && row.blurb.length > 0);
	}
	// Non-function checker degrades to not-downloaded, never throws.
	assert.ok(llmModelInfos(null).every((r) => r.downloaded === false));
});

asyncChain.then(() => {
	console.log(
		process.exitCode
			? "ask-models: FAILED"
			: "ask-models: all assertions passed",
	);
	process.exit(process.exitCode || 0);
});
