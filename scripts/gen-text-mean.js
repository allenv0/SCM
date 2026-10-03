"use strict";

// Generate shipped textMean constants under indexer/text-mean/<modelId>.json
// so the worker/build adopt them instead of recomputing TEXT_MEAN_SAMPLE
// (~830ms on the M1 reference — Inference-Faster-Plan §0.1).
//
//   node scripts/gen-text-mean.js [modelId ...]     # default: all MODELS
//
// Requires local (or downloadable) text weights. TRANSFORMERS_CACHE defaults
// to the app userData/models dir when unset (same cache the smoke runs use).
// Each generated file is verified against a fresh compute (cosine ≥ 0.999).

const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../indexer/build-memory-embeddings-core.js");
const { MODELS } = require("../indexer/models.js");

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

async function generateOne(registryId) {
	const config = core.getModelConfig(registryId);
	if (!MODELS[registryId]) {
		throw new Error(`unknown model id: ${registryId}`);
	}
	console.log(`\n[gen-text-mean] ${registryId} (${config.label})…`);
	const textPair = await loadTextPair(registryId);
	const dim = config.dim;
	const mtl = config.textMaxLength || 0;

	const t0 = Date.now();
	const computed = await core.computeTextMean(textPair, dim, mtl);
	const ms = Date.now() - t0;
	if (!computed) throw new Error("computeTextMean returned null");

	const shipped = core.writeTextMeanShipped(registryId, computed);
	const adopted = core.loadTextMeanConstant(registryId, dim);
	if (!adopted) throw new Error("write succeeded but load returned null");
	const sim = cosine(Array.from(computed), Array.from(adopted));
	if (sim < 0.999) {
		throw new Error(`ship/load cosine ${sim.toFixed(6)} < 0.999`);
	}

	// Fresh recompute parity (same weights → identical deterministic mean).
	const t1 = Date.now();
	const again = await core.computeTextMean(textPair, dim, mtl);
	const againMs = Date.now() - t1;
	const sim2 = cosine(Array.from(computed), Array.from(again));
	if (sim2 < 0.999) {
		throw new Error(`recompute cosine ${sim2.toFixed(6)} < 0.999`);
	}

	console.log(
		`[gen-text-mean] wrote ${shipped} (dim ${dim}, first=${ms}ms, ` +
			`verify=${againMs}ms, cosines ${sim.toFixed(6)}/${sim2.toFixed(6)})`,
	);
	return { registryId, dim, ms, againMs, sim, sim2, shipped };
}

// Mirror of loadTextModel without the deps-injection branch.
async function loadTextPair(registryId) {
	const config = core.getModelConfig(registryId);
	const mod = await import("@huggingface/transformers");
	if (process.env.TRANSFORMERS_CACHE) {
		mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
	}
	const TextClass =
		config.textClass === "siglip"
			? mod.SiglipTextModel
			: mod.CLIPTextModelWithProjection;
	const [tokenizer, textModel] = await Promise.all([
		mod.AutoTokenizer.from_pretrained(config.repo),
		TextClass.from_pretrained(config.repo, {
			dtype: config.textQuantized === false ? "fp32" : "q8",
			...(config.subfolder ? { subfolder: config.subfolder } : {}),
			...(config.textModelFileName
				? { model_file_name: config.textModelFileName }
				: {}),
		}),
	]);
	return {
		tokenizer,
		textModel,
		outputKey: config.textOutputKey || "text_embeds",
	};
}

async function main() {
	const cache = defaultCacheDir();
	if (cache) {
		process.env.TRANSFORMERS_CACHE = cache;
		console.log(`[gen-text-mean] cache: ${cache}`);
	}
	const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	const ids = args.length ? args : Object.keys(MODELS);
	const results = [];
	const failures = [];
	for (const id of ids) {
		try {
			results.push(await generateOne(id));
		} catch (err) {
			console.error(`[gen-text-mean] FAILED ${id}: ${err.message}`);
			failures.push({ id, error: err.message });
		}
	}
	console.log(
		`\n[gen-text-mean] done: ${results.length} ok, ${failures.length} failed`,
	);
	if (failures.length) {
		process.exitCode = 1;
	}
	return { results, failures };
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = { main, generateOne, cosine };
