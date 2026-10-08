#!/usr/bin/env node
"use strict";
// Stage B/C companion: dump exact f32 CHW pixel_values + CPU-q8 baseline vectors
// for every fixture image (plan §5.1). Swift consumes the dumped bytes and never
// independently decodes or preprocesses an image.
//
// Usage: INDEXER_MODEL=siglip2-base-patch16-224 node dump-baseline.js [outDir]

const fs = require("fs");
const path = require("path");
// Explicit require: global `crypto` is absent on older Electron/node (the
// same guard main.js applies — the built-in shadows nothing here).
// eslint-disable-next-line no-redeclare
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(__dirname, "fixtures", "manifest.json");
const OUT = path.resolve(
	process.argv[2] || path.join(__dirname, "out", "baseline"),
);

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
	const manifest = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
	const { loadStack } = require(path.join(ROOT, "scripts", "bench-common.js"));
	const core = require(
		path.join(ROOT, "indexer", "build-memory-embeddings-core.js"),
	);
	const { validateEmbedding, normalizeInPlace } = require(
		path.join(ROOT, "indexer", "memory-embedding-utils.js"),
	);
	const { resolveModelId } = require(path.join(ROOT, "indexer", "models.js"));

	const modelId = process.env.INDEXER_MODEL || "siglip2-base-patch16-224";
	console.log(`[dump] loading CPU-q8 stack for ${modelId} …`);
	const stack = await loadStack({ modelId, log: console });
	const {
		config,
		extractor,
		RawImage,
		sharp,
		dim,
		tokenizer,
		textModel,
		outputKey,
	} = stack;
	if (config.visionPool !== true) {
		throw new Error(
			`model ${modelId} must use visionPool:true (SigLIP pooler_output)`,
		);
	}
	const textPair = { tokenizer, textModel, outputKey };
	const mtl = config.textMaxLength || 0;
	const textMean = await core.resolveTextMean({
		registryId: resolveModelId(modelId),
		dim,
		textPair,
		textMaxLength: mtl,
		log: console,
	});

	fs.mkdirSync(OUT, { recursive: true });
	const tensorsDir = path.join(OUT, "tensors");
	fs.mkdirSync(tensorsDir, { recursive: true });

	const records = [];
	let n = 0;
	for (const img of manifest.images) {
		const abs = path.join(__dirname, "fixtures", img.file);
		const raw = await core.decodeToRaw(abs, sharp, config.inputSize);
		// Build the exact AutoImageProcessor pixel_values the live pipeline uses.
		// transformers.js processor is invoked inside the extractor; to dump the
		// tensor bytes we re-run the processor and also call the extractor.
		const image = new RawImage(raw.data, raw.width, raw.height, raw.channels);

		// Processor path: use the same AutoImageProcessor the plan verified
		// as bit-identical. Fall back to extractor-internal if unavailable.
		const { AutoImageProcessor } = await import("@huggingface/transformers");
		const processor = await AutoImageProcessor.from_pretrained(config.repo);
		const procOut = await processor(image);
		const pv = procOut.pixel_values;
		// pv is a Tensor-like { data, dims } or Float32Array
		const pvData =
			pv && pv.data ? new Float32Array(pv.data) : new Float32Array(pv);
		if (pvData.length !== 3 * 224 * 224) {
			throw new Error(
				`pixel_values length ${pvData.length} != ${3 * 224 * 224} for ${img.id}`,
			);
		}
		// CHW float32 little-endian bytes
		const bytes = Buffer.from(
			pvData.buffer,
			pvData.byteOffset,
			pvData.byteLength,
		);
		const tensorFile = path.join(tensorsDir, `${img.id}.f32`);
		fs.writeFileSync(tensorFile, bytes);
		const pixelSha = sha256(bytes);
		const pixelLen = bytes.length;

		// Direct unnormalized q8 pipeline result (do NOT call embedRawImage —
		// it normalizes in place).
		const result = await extractor(image, { pool: true });
		const rawVec = new Float32Array(result.data);
		if (rawVec.length !== dim) {
			throw new Error(`raw vector dim ${rawVec.length} != ${dim}`);
		}
		const rawCopy = Float32Array.from(rawVec);
		validateEmbedding(rawCopy, dim);
		const normCopy = Float32Array.from(rawVec);
		normalizeInPlace(normCopy);

		const outFile = path.join(OUT, `${img.id}.json`);
		const payload = {
			id: img.id,
			file: img.file,
			kind: img.kind,
			sha256Image: img.sha256,
			pixelValues: {
				tensorFile: `tensors/${img.id}.f32`,
				bytes: pixelLen,
				sha256: pixelSha,
				shape: [1, 3, 224, 224],
				dtype: "float32",
				order: "CHW",
			},
			cpuQ8: {
				raw: Array.from(rawCopy),
				rawChecksum: checksum(rawCopy),
				normalized: Array.from(normCopy),
				normalizedChecksum: checksum(normCopy),
			},
		};
		fs.writeFileSync(outFile, JSON.stringify(payload));
		records.push({
			id: img.id,
			kind: img.kind,
			tensorSha: pixelSha,
			rawChecksum: payload.cpuQ8.rawChecksum,
			normChecksum: payload.cpuQ8.normalizedChecksum,
		});
		n++;
		if (n % 10 === 0) console.log(`[dump] ${n}/${manifest.images.length}`);
	}

	// Query vectors (three-query construction lives in Stage C harness; here
	// we dump the raw text tower outputs + centered forms for each manifest query).
	const queries = [];
	for (const q of manifest.queries) {
		const raw = await core.embedText(q.query, textPair, dim, mtl);
		// embedText already validates + normalizes. Re-embed for raw? We need
		// the centered product form which is what ranking uses.
		const centered = textMean ? center(textMean, raw) : raw;
		queries.push({
			id: q.id,
			query: q.query,
			expectedPositives: q.expectedPositives,
			normalized: Array.from(raw),
			centered: Array.from(centered),
		});
	}
	fs.writeFileSync(
		path.join(OUT, "queries.json"),
		JSON.stringify({
			dim,
			textMean: textMean ? Array.from(textMean) : null,
			queries,
		}),
	);

	fs.writeFileSync(
		path.join(OUT, "index.json"),
		JSON.stringify(
			{
				schema: "coreml-baseline-dump/v1",
				modelId: resolveModelId(modelId),
				repo: config.repo,
				dim,
				eps: stack.eps,
				images: records,
				count: records.length,
				scoreTieBand: manifest.scoreTieBand,
			},
			null,
			2,
		) + "\n",
	);
	console.log(`[dump] wrote ${records.length} image dumps → ${OUT}`);
	process.exit(0);
}

function checksum(v) {
	// Cheap deterministic checksum: sum of float64 values + length.
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i];
	return Number(s.toPrecision(12));
}

function center(textMean, vec) {
	// Same math as centerText in memory-embedding-utils.js
	if (!textMean || textMean.length !== vec.length) return vec;
	let proj = 0;
	for (let i = 0; i < vec.length; i++) proj += vec[i] * textMean[i];
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) out[i] = vec[i] - proj * textMean[i];
	let norm = 0;
	for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
	norm = Math.sqrt(norm);
	if (!(norm > 1e-6)) return vec;
	for (let i = 0; i < out.length; i++) out[i] /= norm;
	return out;
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
