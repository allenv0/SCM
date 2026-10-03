"use strict";

// Curated registry for Ask mode's embedded LLM (MDs/Ask-Mode-Plan.md): the
// llama-server sidecar binary and the GGUF chat models it can load. Mirrors
// the shape of indexer/models.js — ids are stable, every field the rest of
// the code needs rides the entry, and unknown ids resolve to the default.
//
// Server binary: a llama.cpp GitHub release zip. The tag "latest" resolves
// through the GitHub API at download time; pinning a concrete tag freezes
// the binary for reproducibility. The asset is matched by arch regex (not
// an exact name) so upstream naming drift cannot break the download.
//
// Models: text-only instruct GGUFs (no vision in the MVP). sha256 comes
// from the HuggingFace tree API at download time (the registry deliberately
// does not hardcode digests that drift on re-upload) and is verified before
// the file is published into userData/llm/models.
const LLM_SERVER = {
	repo: "ggml-org/llama.cpp",
	// "latest" = resolve the newest GitHub release at download time.
	tag: "latest",
	// Asset pick: a .zip/.tar.gz whose name mentions mac + this machine's
	// arch. Checked case-insensitively against the release's asset list.
	archPatterns: {
		arm64: /mac.*arm64|arm64.*mac|macos.*aarch64|aarch64.*macos/i,
		x64: /mac.*x64|x64.*mac|macos.*x86_64|x86_64.*macos/i,
	},
	// The published llama-server is a THIN binary dynamically linked against
	// the archive's dylibs (observed: ~50KB against an ~11MB archive), so
	// the size floor only guards against error-page garbage — the archive
	// floor (1MB, checked at download time) and the layout version do the
	// real integrity work.
	minimumBinaryBytes: 16 * 1024,
	// Bump when the on-disk layout changes; installs stamped with an older
	// layout redownload on next use (layout 1: dylib-stripped 49KB publish;
	// layout 2: dylib symlinks skipped — same unbootable result).
	layoutVersion: 3,
	minimumArchiveBytes: 1024 * 1024,
};

const LLM_MODELS = {
	"qwen3-1.7b-q4km": {
		label: "Qwen3 1.7B",
		shortLabel: "Qwen3-1.7B",
		blurb:
			"Fast everyday chat model. Best default — small enough for 8GB Macs.",
		// unsloth's mirror carries the full quant ladder; the official
		// Qwen/Qwen3-1.7B-GGUF repo ships Q8_0 only (~1.8GB — twice the
		// download for the same answers at Ask's evidence-grounded task).
		hfRepo: "unsloth/Qwen3-1.7B-GGUF",
		hfFile: "Qwen3-1.7B-Q4_K_M.gguf",
		downloadUrl:
			"https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
		sizeBytes: 1_107_000_000,
		ctxTokens: 8192,
		license: "apache-2.0",
		speed: "fast",
		minimumModelBytes: 1024 * 1024 * 1024,
	},
	"llama3.2-3b-q4km": {
		label: "Llama 3.2 3B",
		shortLabel: "Llama-3.2-3B",
		blurb: "Stronger long answers, ~2GB download. Needs headroom on 8GB Macs.",
		hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
		hfFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		downloadUrl:
			"https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		sizeBytes: 2_020_000_000,
		ctxTokens: 8192,
		license: "llama3.2",
		speed: "slower",
		minimumModelBytes: 1024 * 1024 * 1024,
	},
};

const DEFAULT_LLM_MODEL_ID = "qwen3-1.7b-q4km";

function getLlmModel(id) {
	return LLM_MODELS[id] || null;
}

// Unknown ids resolve to the default — settings referencing a model that no
// longer ships must keep Ask working (same contract as resolveModelId).
function resolveLlmModelId(id) {
	return LLM_MODELS[id] ? id : DEFAULT_LLM_MODEL_ID;
}

module.exports = {
	LLM_SERVER,
	LLM_MODELS,
	DEFAULT_LLM_MODEL_ID,
	getLlmModel,
	resolveLlmModelId,
};
