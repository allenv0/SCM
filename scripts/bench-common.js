"use strict";

// Shared loader + helpers for the inference/enrichment benches (Plan §3.0).
// Loads the indexer stack exactly as the worker does (indexer.js loadModels):
// TRANSFORMERS_CACHE honored, per-model dtype/subfolder/file names, dim probe
// via runSmokeTest. Product code is imported only from
// build-memory-embeddings-core.js / models.js — indexer.js itself is
// worker-only (parentPort), so the bench replicates its ~40-line load block.

const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../indexer/build-memory-embeddings-core.js");

// The worker's cache: TRANSFORMERS_CACHE wins; else the app's userData/models
// when present (this Mac — same weights the smoke runs use), else the
// transformers.js default (~/.cache) and a first-run download.
function defaultCacheDir() {
	if (process.env.TRANSFORMERS_CACHE) return process.env.TRANSFORMERS_CACHE;
	const mac = path.join(
		os.homedir(),
		"Library",
		"Application Support",
		"scm",
		"models",
	);
	if (fs.existsSync(mac)) return mac;
	return null;
}

// EP selection per the documented knob (Inference-Frameworks-Deep-Dive.md
// §3.1: default "cpu", e.g. "coreml,cpu" to opt in). NOTE: the knob is
// documented as shipped but is ABSENT from this tree (`git log -S` finds it
// only in MDs — never committed). The bench re-implements the documented
// mechanism (session_options.executionProviders forwarded by pipeline()/
// from_pretrained) so the A/B stays testable; landing it in indexer.js is the
// follow-up tracked in Inference-Faster-Plan.md §8.3.
function executionProviders() {
	const list = (process.env.SCM_EXECUTION_PROVIDERS || "cpu")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : ["cpu"];
}

async function loadStack({
	log = console,
	modelId = process.env.INDEXER_MODEL,
} = {}) {
	const config = core.getModelConfig(modelId);
	const cacheDir = defaultCacheDir();
	if (cacheDir) process.env.TRANSFORMERS_CACHE = cacheDir;
	const started = Date.now();
	const mod = await import("@huggingface/transformers");
	if (process.env.TRANSFORMERS_CACHE) {
		mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
	}
	const sharp = (await import("sharp")).default;
	const RawImage = mod.RawImage;
	const eps = executionProviders();
	const session_options = { executionProviders: eps };
	log.log(
		`[bench] loading ${config.label} — vision dtype ${config.visionQuantized ? "q8" : "fp32"}, ` +
			`EP ${eps.join(",")}, cache ${process.env.TRANSFORMERS_CACHE || "(transformers.js default)"}…`,
	);
	// visionManualProcessor (MobileCLIP2-L/14, 2026-09-26 gate): pipeline()
	// forwards `subfolder` to the model but the PROCESSOR falls back to the repo
	// root preprocessor_config.json (256), while the l14 graph wants 224 — an
	// uncatchable onnxruntime-node dim crash. transformers.js 3.8.1 has no
	// `config_file_name`, so construct CLIPImageProcessor from the subfolder's
	// config and call the vision model directly. Bench-only; product indexer.js
	// would need the same manual path.
	let extractor;
	if (config.visionManualProcessor) {
		const procPath = path.join(
			process.env.TRANSFORMERS_CACHE,
			config.repo,
			config.subfolder,
			"preprocessor_config.json",
		);
		const imageProcessor = new mod.CLIPImageProcessor(
			JSON.parse(fs.readFileSync(procPath, "utf8")),
		);
		const visionModel = await mod.CLIPVisionModelWithProjection.from_pretrained(
			config.repo,
			{
				dtype: config.visionQuantized ? "q8" : "fp32",
				session_options,
				subfolder: config.subfolder,
				model_file_name: config.modelFileName,
			},
		);
		extractor = async (image) => {
			const inputs = await imageProcessor(image);
			const out = await visionModel({ pixel_values: inputs.pixel_values });
			return out.image_embeds || out.pooler_output;
		};
	} else {
		extractor = await mod.pipeline("image-feature-extraction", config.repo, {
			dtype: config.visionQuantized ? "q8" : "fp32",
			session_options,
			...(config.modelFileName
				? { model_file_name: config.modelFileName, subfolder: config.subfolder }
				: {}),
		});
	}
	const TextClass =
		config.textClass === "siglip"
			? mod.SiglipTextModel
			: mod.CLIPTextModelWithProjection;
	const [tokenizer, textModel] = await Promise.all([
		mod.AutoTokenizer.from_pretrained(config.repo),
		TextClass.from_pretrained(config.repo, {
			dtype: config.textQuantized === false ? "fp32" : "q8",
			session_options,
			...(config.subfolder ? { subfolder: config.subfolder } : {}),
			...(config.textModelFileName
				? { model_file_name: config.textModelFileName }
				: {}),
		}),
	]);
	const textPair = {
		tokenizer,
		textModel,
		outputKey: config.textOutputKey || "text_embeds",
	};
	// Dim probe: the OUTPUT dim is the truth (indexer.js:259-279 pattern).
	const probe = await core.runSmokeTest(
		extractor,
		RawImage,
		sharp,
		log,
		null,
		config.dim,
		0,
		config.visionPool,
	);
	const dim = probe.vec.length;
	log.log(
		`[bench] ready: dim=${dim} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
	);
	return { mod, config, extractor, RawImage, sharp, ...textPair, dim, eps };
}

// ---------------------------------------------------------------------------
// Stats + small helpers
// ---------------------------------------------------------------------------

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(xs, p) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

function mean(xs) {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function max(xs) {
	return xs.length ? xs[xs.length - 1] : null;
}

function cosine(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom > 0 ? dot / denom : 0;
}

// Batched outputs come back either as an array of per-item tensors or as one
// (N, dim) tensor — normalize both to an array of Float32Array(dim) rows.
function splitRows(result, expectedRows, dim) {
	if (Array.isArray(result)) {
		const rows = result.map((t) => {
			const v = t instanceof Float32Array ? t : new Float32Array(t.data);
			if (v.length !== dim) {
				throw new Error(`row dim ${v.length} != expected ${dim}`);
			}
			return v;
		});
		if (rows.length !== expectedRows) {
			throw new Error(`got ${rows.length} rows, expected ${expectedRows}`);
		}
		return rows;
	}
	const data =
		result instanceof Float32Array ? result : new Float32Array(result.data);
	if (data.length === expectedRows * dim) {
		const rows = [];
		for (let i = 0; i < expectedRows; i++) {
			rows.push(data.slice(i * dim, (i + 1) * dim));
		}
		return rows;
	}
	if (data.length === dim && expectedRows === 1) return [data];
	throw new Error(
		`unexpected batched output shape: ${data.length} floats for ${expectedRows}×${dim}`,
	);
}

function hslToRgb(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r;
	let g;
	let b;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = l - c / 2;
	return {
		r: Math.round((r + m) * 255),
		g: Math.round((g + m) * 255),
		b: Math.round((b + m) * 255),
	};
}

// 16 non-square solid JPEGs (480×270, like the real 480px frames) so both the
// sharp resize path and the batch sizes divide evenly.
async function makeSolidJpegs(
	sharp,
	dir,
	count = 16,
	width = 480,
	height = 270,
) {
	fs.mkdirSync(dir, { recursive: true });
	const files = [];
	for (let i = 0; i < count; i++) {
		const p = path.join(dir, `bench-${String(i).padStart(2, "0")}.jpg`);
		await sharp({
			create: {
				width,
				height,
				channels: 3,
				background: hslToRgb((i / count) * 360, 0.55, 0.45),
			},
		})
			.jpeg()
			.toFile(p);
		files.push(p);
	}
	return files;
}

function chunk(arr, n) {
	const out = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

// Minimal argv reader: --flag value / --flag=value.
function argValue(flag, fallback) {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === flag) return argv[i + 1];
		if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
	}
	return fallback;
}

module.exports = {
	defaultCacheDir,
	executionProviders,
	loadStack,
	median,
	pct,
	mean,
	max,
	cosine,
	splitRows,
	hslToRgb,
	makeSolidJpegs,
	chunk,
	argValue,
};
