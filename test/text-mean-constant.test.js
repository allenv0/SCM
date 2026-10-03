"use strict";

// Unit tests for shipped/cached textMean constants (Inference-Faster-Plan
// §0.1). No model download: writes a synthetic doc into a temp cache and
// checks adopt/reject rules (dim, sampleHash, non-unit, wrong modelId).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../indexer/build-memory-embeddings-core.js");
const { MODELS } = require("../indexer/models.js");

const REG = "siglip2-base-patch16-224";
// Synthetic id: never ships under indexer/text-mean/, so cache rules are
// isolated from the real generated constants (which do exist for REG).
const REG_FAKE = "unit-test-no-shipped-constant";
const DIM = 768;

// Isolate TRANSFORMERS_CACHE so we never touch userData.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-textmean-"));
const prevCache = process.env.TRANSFORMERS_CACHE;
process.env.TRANSFORMERS_CACHE = tmp;

function unitVec(dim, fill = 1 / Math.sqrt(dim)) {
	return Array.from({ length: dim }, () => fill);
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

async function main() {
	try {
		const hash = core.textMeanSampleHash();
		assert.equal(typeof hash, "string");
		assert.equal(hash.length, 16);
		assert.equal(core.textMeanSampleHash(), hash, "hash must be stable");

		// Real registry id: shipped constant exists and is adopted even when
		// the writable cache is empty.
		const shippedHit = core.loadTextMeanConstant(REG, DIM);
		assert.ok(shippedHit, "generated shipped constant must adopt");
		assert.equal(shippedHit.length, DIM);

		// No cache for the synthetic id yet → null (caller falls back to compute).
		assert.equal(core.loadTextMeanConstant(REG_FAKE, DIM), null);

		// Save a valid unit mean → load adopts it (cache path).
		const mean = unitVec(DIM);
		assert.equal(
			core.saveTextMeanConstant(REG_FAKE, Float32Array.from(mean)),
			true,
		);
		const loaded = core.loadTextMeanConstant(REG_FAKE, DIM);
		assert.ok(loaded, "cache hit expected");
		assert.equal(loaded.length, DIM);
		assert.ok(cosine(Array.from(loaded), mean) > 0.999);

		// Wrong dim → rejected.
		assert.equal(core.loadTextMeanConstant(REG_FAKE, 512), null);

		// Wrong modelId in the file → rejected.
		const cacheFile = core.textMeanCachePath(REG_FAKE);
		const doc = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ ...doc, modelId: "other-model" }),
		);
		assert.equal(core.loadTextMeanConstant(REG_FAKE, DIM), null);

		// Corrupt sampleHash → rejected (TEXT_MEAN_SAMPLE edited).
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ ...doc, sampleHash: "deadbeef" }),
		);
		assert.equal(core.loadTextMeanConstant(REG_FAKE, DIM), null);

		// Non-unit / non-finite mean → rejected.
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ ...doc, sampleHash: hash, mean: unitVec(DIM, 10) }),
		);
		assert.equal(core.loadTextMeanConstant(REG_FAKE, DIM), null);
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({
				...doc,
				sampleHash: hash,
				mean: unitVec(DIM).map((v, i) => (i === 0 ? NaN : v)),
			}),
		);
		assert.equal(core.loadTextMeanConstant(REG_FAKE, DIM), null);

		// Shipped path is under indexer/text-mean/.
		const shipped = core.textMeanShippedPath(REG);
		assert.equal(path.basename(path.dirname(shipped)), "text-mean");
		assert.equal(path.basename(shipped), `${REG}.json`);
		assert.ok(
			shipped.startsWith(path.join(__dirname, "..", "indexer", "text-mean")),
		);

		// Every registry id has a deterministic shipped filename.
		for (const id of Object.keys(MODELS)) {
			assert.equal(path.basename(core.textMeanShippedPath(id)), `${id}.json`);
		}

		// Restore a valid cache doc; resolveTextMean must adopt without compute
		// (textPair is null — any compute path would throw).
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ ...doc, sampleHash: hash, mean: unitVec(DIM) }),
		);
		const resolved = await core.resolveTextMean({
			registryId: REG_FAKE,
			dim: DIM,
			textPair: null,
			textMaxLength: 64,
			forceCompute: false,
			log: { log() {} },
		});
		assert.ok(resolved, "resolveTextMean must adopt valid constant");
		assert.equal(resolved.length, DIM);

		// Real REG: resolveTextMean adopts the shipped file (also null textPair).
		const resolvedShipped = await core.resolveTextMean({
			registryId: REG,
			dim: DIM,
			textPair: null,
			textMaxLength: 64,
			forceCompute: false,
			log: { log() {} },
		});
		assert.ok(resolvedShipped, "shipped constant must be adopted");
		assert.equal(resolvedShipped.length, DIM);

		console.log("ok - text-mean constants");
	} finally {
		if (prevCache === undefined) delete process.env.TRANSFORMERS_CACHE;
		else process.env.TRANSFORMERS_CACHE = prevCache;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
