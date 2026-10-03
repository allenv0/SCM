"use strict";

// LLM settings (Settings → AI Chat): the Ask-mode feature flag and chat
// model, persisted under settings.json `llm`. Validated-fallback like
// readWhisperModel — the parse lives HERE (the way parseVideoQuality lives
// in indexer/video-utils.js) and reads go through the cached readSettings().
// No electron dependency: plain-node tests init settings with a tmpdir.

const path = require("path");
const { readSettings, writeSettings } = require("../settings.js");
const {
	LLM_MODELS,
	DEFAULT_LLM_MODEL_ID,
	resolveLlmModelId,
} = require("./models.js");

// The user-data dir holding the downloaded sidecar (bin/ + models/). Set by
// initLlmConfig from main; tests point it at a tmpdir.
let LLM_DIR = null;
function initLlmConfig({ userDataDir }) {
	LLM_DIR = path.join(userDataDir, "llm");
}

function llmDir() {
	return LLM_DIR;
}

// Pure: validate a raw settings.json `llm` value into the effective config.
// Unknown/missing fields fall back — a hand-edited or half-written key can
// never disable the defaults silently.
function parseLlmConfig(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	return {
		enabled: src.enabled === true,
		chatModel: resolveLlmModelId(src.chatModel),
	};
}

function readLlmConfig() {
	try {
		return parseLlmConfig(readSettings().llm);
	} catch {
		return parseLlmConfig(null);
	}
}

// Merge-patch one validated config through the atomic settings write.
// Returns the effective config after the write.
function writeLlmConfig(patch) {
	const prev = parseLlmConfig(readSettings().llm);
	const next = parseLlmConfig({ ...prev, ...(patch || {}) });
	writeSettings({ llm: next });
	return next;
}

// Model rows for the Settings UI / status IPC: registry order, with the
// on-disk downloaded flag resolved by the caller-supplied checker (kept out
// of this module so config stays pure).
function llmModelInfos(isDownloaded) {
	const check = typeof isDownloaded === "function" ? isDownloaded : () => false;
	return Object.entries(LLM_MODELS).map(([id, m]) => ({
		id,
		label: m.label,
		shortLabel: m.shortLabel,
		blurb: m.blurb,
		sizeBytes: m.sizeBytes,
		ctxTokens: m.ctxTokens,
		license: m.license,
		speed: m.speed,
		downloaded: check(id) === true,
	}));
}

module.exports = {
	initLlmConfig,
	llmDir,
	parseLlmConfig,
	readLlmConfig,
	writeLlmConfig,
	llmModelInfos,
	DEFAULT_LLM_MODEL_ID,
};
