"use strict";

// CommonJS core of the memory-embedding build so jest can drive it with
// injected dependencies (sharp, transformers.js) and temp directories.
// The .mjs CLI (scripts/build-memory-embeddings.mjs) is a thin wrapper.

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const {
	validateEmbedding,
	normalizeInPlace,
	classifyFailures,
	summarizeFailures,
	buildFilenamePhrase,
	hybridScore,
	centerText,
	TEXT_MEAN_SAMPLE,
	SAMPLE_QUERIES,
} = require("./memory-embedding-utils.js");
const {
	MODELS,
	DEFAULT_MODEL_ID,
	getModel,
	resolveModelId,
} = require("./models.js");

const DEFAULT_IMAGES_DIR = path.resolve(
	__dirname,
	"..",
	"public",
	"images",
	"projects",
);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "..", "public");

// Backward-compatible names for the site build's callers: the default model.
const MODEL_ID = getModel(DEFAULT_MODEL_ID).repo;
const EMBEDDING_DIM = getModel(DEFAULT_MODEL_ID).dim;
const SMOKE_SIZE = 32;
const QUERIES_TOP_K = 24;

// The config for a model id (resolved to the default when unknown). The
// worker/build pick the model once per run via INDEXER_MODEL / MEMORIES_MODEL.
function getModelConfig(modelId) {
	return getModel(resolveModelId(modelId));
}

const IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".JPG",
	".JPEG",
	".PNG",
	".GIF",
	".WEBP",
]);

function listImages(imagesDir) {
	try {
		return fs
			.readdirSync(imagesDir)
			.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file)))
			.sort();
	} catch (err) {
		console.error(`[memories] Failed to read ${imagesDir}: ${err.message}`);
		return [];
	}
}

// Decode any image (incl. first frame of animated GIFs) to raw RGB(A) bytes
// via sharp, then hand the bytes to transformers.js RawImage. The CLIP
// processor performs its own resize/center-crop afterwards; decoding at
// ~the processor's input size (per-model `inputSize`) keeps the upscale
// loss negligible for 256px models.
//
// `source` is either a file path / sharp-supported buffer, or a raw RGB
// frame { data, width, height, channels } from extractFrameRaw (plan 0.5 —
// skips the JPEG encode/decode round-trip).
async function decodeToRaw(source, sharp, inputSize = 224) {
	let img;
	if (
		source &&
		typeof source === "object" &&
		source.data &&
		typeof source.width === "number" &&
		typeof source.height === "number"
	) {
		img = sharp(source.data, {
			raw: {
				width: source.width,
				height: source.height,
				channels: source.channels || 3,
			},
			limitInputPixels: false,
		});
	} else {
		img = sharp(source, {
			animated: false,
			limitInputPixels: false,
		});
	}
	const { data, info } = await img
		.resize(inputSize, inputSize, { fit: "inside", withoutEnlargement: true })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
		channels: info.channels,
	};
}

// Decode a specific frame of an animated GIF (or first frame of anything).
async function decodeFrame(filePath, sharp, page, inputSize = 224) {
	const { data, info } = await sharp(filePath, {
		animated: true,
		page,
		limitInputPixels: false,
	})
		.resize(inputSize, inputSize, { fit: "inside", withoutEnlargement: true })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
		channels: info.channels,
	};
}

// Middle frame index of an animated GIF; null when not animated.
async function gifMiddlePage(filePath, sharp) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext !== ".gif") return null;
	const meta = await sharp(filePath, {
		animated: true,
		limitInputPixels: false,
	}).metadata();
	const pages = meta.pages ?? 1;
	if (pages < 2) return null;
	return Math.floor((pages - 1) / 2);
}

// Embed raw RGB(A) bytes through the CLIP image pipeline, validated +
// L2-normalized so cosine similarity matches the runtime text embeddings.
// `pool` is per-model: CLIP exports project to image_embeds by default, but
// SigLIP's vision model only exposes pooler_output, which the pipeline
// returns when called with { pool: true }.
async function embedRawImage(
	extractor,
	RawImage,
	{ data, width, height, channels },
	expectedDim = EMBEDDING_DIM,
	pool = false,
) {
	const image = new RawImage(data, width, height, channels);
	const result = await extractor(image, pool ? { pool: true } : undefined);
	const vec = new Float32Array(result.data);
	validateEmbedding(vec, expectedDim);
	normalizeInPlace(vec);
	return vec;
}

// CLIP text embedding (same classes the runtime worker uses), validated +
// L2-normalized. Used for filename-phrase embeddings and sample queries.
// `textMaxLength` pins the tokenizer to a fixed length (padding:"max_length")
// — some exported text encoders (SigLIP) have STATIC sequence
// shapes in the ONNX graph, so a variable-length batch fails with an ONNX
// broadcast error. The default (0) keeps the historic padding:true behavior
// for CLIP, so existing CLIP bins stay valid.
// `textModel.outputKey` names the output the model emits its embedding under:
// "text_embeds" (CLIPTextModelWithProjection) vs "pooler_output" (SigLIP).
async function embedText(
	text,
	textModel,
	expectedDim = EMBEDDING_DIM,
	textMaxLength = 0,
) {
	const { tokenizer, textModel: model, outputKey = "text_embeds" } = textModel;
	const inputs = tokenizer(
		text,
		textMaxLength > 0
			? { padding: "max_length", max_length: textMaxLength, truncation: true }
			: { padding: true, truncation: true },
	);
	const outputs = await model(inputs);
	const vec = new Float32Array(outputs[outputKey].data);
	validateEmbedding(vec, expectedDim);
	normalizeInPlace(vec);
	return vec;
}

// CLIP text embeddings are strongly anisotropic: every text shares a
// dominant direction, so raw text-image cosine lands in a narrow noise band
// where garbage ranks. Estimating that shared direction (the average of a
// diverse prompt sample) and projecting it out of query/phrase vectors
// restores the discriminative signal. Returns a unit vector, or null when
// the sample could not be embedded.
async function computeTextMean(
	textModel,
	expectedDim = EMBEDDING_DIM,
	textMaxLength = 0,
) {
	if (!textModel) return null;
	try {
		const vecs = [];
		for (const text of TEXT_MEAN_SAMPLE) {
			vecs.push(await embedText(text, textModel, expectedDim, textMaxLength));
		}
		const mean = new Float32Array(expectedDim);
		for (const v of vecs) {
			for (let i = 0; i < expectedDim; i++) mean[i] += v[i];
		}
		for (let i = 0; i < expectedDim; i++) mean[i] /= vecs.length;
		validateEmbedding(mean, expectedDim);
		normalizeInPlace(mean);
		return mean;
	} catch (err) {
		console.warn(
			`[memories] Text-mean estimation failed (${err.message}); using uncentered embeddings`,
		);
		return null;
	}
}

// Center a text vector against the shared text direction when available;
// falls back to the raw vector on any degenerate residual.
function centerOrRaw(vec, textMean) {
	if (!textMean) return vec;
	const centered = centerText(vec, textMean);
	return centered || vec;
}

// ---------------------------------------------------------------------------
// Shipped / cached textMean constants (Inference-Faster-Plan §0.1).
// computeTextMean embeds TEXT_MEAN_SAMPLE through the text tower — ~830ms
// on the M1 reference — and the value is deterministic per (model weights,
// tokenizer, sample, dim). Ship it as JSON under indexer/text-mean/ and
// adopt it on load; fall back to compute + a writable cache under
// TRANSFORMERS_CACHE when the shipped file is missing or stale.
// ---------------------------------------------------------------------------

// Fingerprints TEXT_MEAN_SAMPLE so editing the sample invalidates old files.
function textMeanSampleHash() {
	return nodeCrypto
		.createHash("sha256")
		.update(JSON.stringify(TEXT_MEAN_SAMPLE))
		.digest("hex")
		.slice(0, 16);
}

// Read-only constant shipped inside the asar (build.files covers indexer/**).
function textMeanShippedPath(registryId) {
	return path.join(__dirname, "text-mean", `${registryId}.json`);
}

// Writable cache: TRANSFORMERS_CACHE is userData/models (first-run path).
function textMeanCachePath(registryId) {
	const root = process.env.TRANSFORMERS_CACHE;
	if (!root) return null;
	return path.join(root, "scm-text-mean", `${registryId}.json`);
}

function readTextMeanDoc(file, { registryId, dim, sampleHash }) {
	if (!file) return null;
	try {
		const doc = JSON.parse(fs.readFileSync(file, "utf8"));
		if (doc.modelId !== registryId) return null;
		if (Number(doc.dim) !== Number(dim)) return null;
		if (doc.sampleHash !== sampleHash) return null;
		const mean = doc.mean;
		if (!Array.isArray(mean) || mean.length !== dim) return null;
		let sum = 0;
		for (let i = 0; i < mean.length; i++) {
			const v = mean[i];
			if (!Number.isFinite(v)) return null;
			sum += v * v;
		}
		// computeTextMean normalizes → unit length (norm² ≈ 1). Reject
		// truncated / garbage files rather than centering against junk.
		if (sum < 0.5 || sum > 1.5) return null;
		return Float32Array.from(mean);
	} catch {
		return null;
	}
}

// Prefer the shipped constant (release-controlled), then the writable cache.
function loadTextMeanConstant(registryId, dim) {
	const sampleHash = textMeanSampleHash();
	const meta = { registryId, dim, sampleHash };
	return (
		readTextMeanDoc(textMeanShippedPath(registryId), meta) ||
		readTextMeanDoc(textMeanCachePath(registryId), meta) ||
		null
	);
}

function writeTextMeanDoc(file, registryId, mean) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const doc = {
		modelId: registryId,
		dim: mean.length,
		sampleHash: textMeanSampleHash(),
		generatedAt: new Date().toISOString(),
		mean: Array.from(mean),
	};
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
	fs.renameSync(tmp, file);
}

// Best-effort write to the writable cache (never throws — compute already
// succeeded; a read-only cache root only costs the next-launch recompute).
function saveTextMeanConstant(registryId, mean) {
	const file = textMeanCachePath(registryId);
	if (!file || !mean || !mean.length) return false;
	try {
		writeTextMeanDoc(file, registryId, mean);
		return true;
	} catch (err) {
		console.warn(`[memories] textMean cache write failed (${err.message})`);
		return false;
	}
}

// Generator writes the shipped file under indexer/text-mean/.
function writeTextMeanShipped(registryId, mean) {
	writeTextMeanDoc(textMeanShippedPath(registryId), registryId, mean);
	return textMeanShippedPath(registryId);
}

// Adopt a constant when present; otherwise compute once and cache.
// `textPair` is { tokenizer, textModel, outputKey } for computeTextMean.
async function resolveTextMean({
	registryId,
	dim,
	textPair,
	textMaxLength = 0,
	forceCompute = false,
	log = console,
}) {
	if (!forceCompute) {
		const hit = loadTextMeanConstant(registryId, dim);
		if (hit) {
			log.log?.(
				`[memories] textMean constant hit for ${registryId} (dim ${dim})`,
			);
			return hit;
		}
	}
	log.log?.(`[memories] computing textMean for ${registryId}…`);
	const mean = await computeTextMean(textPair, dim, textMaxLength);
	if (mean) saveTextMeanConstant(registryId, mean);
	return mean;
}

// Smoke test: embed a generated solid-color image right after loading the
// model, before touching real data. Catches pipeline misconfiguration
// (e.g. the text-only "feature-extraction" pipeline, which fails on images
// with "text.split is not a function") as one loud, actionable failure
// instead of N identical per-image skips. When a text model is provided it
// also embeds a phrase, validating the filename-phrase path up front.
// Returns the probe vectors ({ vec, phraseVec }) so callers can adopt the
// ACTUAL embedding dim straight from the ONNX output.
async function runSmokeTest(
	extractor,
	RawImage,
	sharp,
	log,
	textModel = null,
	expectedDim = EMBEDDING_DIM,
	textMaxLength = 0,
	pool = false,
) {
	const { data, info } = await sharp({
		create: {
			width: SMOKE_SIZE,
			height: SMOKE_SIZE,
			channels: 3,
			background: { r: 64, g: 64, b: 128 },
		},
	})
		.raw()
		.toBuffer({ resolveWithObject: true });
	const vec = await embedRawImage(
		extractor,
		RawImage,
		{
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			width: info.width,
			height: info.height,
			channels: info.channels,
		},
		expectedDim,
		pool,
	);
	log.log(
		`[memories] Smoke test ok: model outputs ${vec.length}-dim embeddings`,
	);
	let phraseVec = null;
	if (textModel) {
		phraseVec = await embedText(
			"a screenshot of a beach",
			textModel,
			expectedDim,
			textMaxLength,
		);
		log.log(
			`[memories] Phrase smoke test ok: text model outputs ${phraseVec.length}-dim embeddings`,
		);
	}
	return { vec, phraseVec };
}

async function loadSharp(deps) {
	if (deps.sharp) return deps.sharp;
	return (await import("sharp")).default;
}

async function loadTransformers(deps) {
	if (deps.pipeline && deps.RawImage) {
		return { pipeline: deps.pipeline, RawImage: deps.RawImage };
	}
	if (deps.loadTransformers) {
		return deps.loadTransformers();
	}
	const mod = await import("@huggingface/transformers");
	return { pipeline: mod.pipeline, RawImage: mod.RawImage };
}

// The transformers.js class that loads a model's text tower: CLIP exports
// use CLIPTextModelWithProjection; SigLIP exports use
// SiglipTextModel (their ONNX layout is a separate text_model graph).
function textModelClass(mod, config) {
	return config.textClass === "siglip"
		? mod.SiglipTextModel
		: mod.CLIPTextModelWithProjection;
}

// Loads the text encoder for a model (tokenizer + the model's text class).
// Returns null in test scenarios where only the image pipeline was injected.
async function loadTextModel(deps, modelId) {
	if (deps.loadTextModel) return deps.loadTextModel();
	if (deps.pipeline && deps.RawImage) return null;
	const config = getModelConfig(modelId);
	const mod = await import("@huggingface/transformers");
	const [tokenizer, textModel] = await Promise.all([
		mod.AutoTokenizer.from_pretrained(config.repo),
		textModelClass(mod, config).from_pretrained(config.repo, {
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

// Average of two L2-normalized vectors, renormalized.
function averageVectors(a, b) {
	const avg = new Float32Array(a.length);
	for (let i = 0; i < a.length; i++) avg[i] = a[i] + b[i];
	normalizeInPlace(avg);
	return avg;
}

function writeBin(file, vectors, dim) {
	if (vectors.length === 0) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* file not present */
		}
		return 0;
	}
	const header = Buffer.alloc(8);
	header.writeInt32LE(vectors.length, 0);
	header.writeInt32LE(dim, 4);
	const body = Buffer.concat(vectors.map((e) => Buffer.from(e.buffer)));
	fs.writeFileSync(file, Buffer.concat([header, body]));
	return 8 + body.length;
}

function unlinkQuiet(file) {
	try {
		fs.unlinkSync(file);
	} catch {
		/* file not present */
	}
}

async function finish({
	embeddedFilenames,
	embeddings,
	phraseEmbeddings,
	dim,
	failures,
	log,
	indexFile,
	embeddingsFile,
	phraseFile,
	queriesFile,
	loadFailed,
	smokeFailed,
	requiresEmbeddings,
	textLoadFailed,
	embedQueryFn,
	textMean = null,
	modelId = DEFAULT_MODEL_ID,
}) {
	const cls = classifyFailures(failures, {
		total: embeddedFilenames.length + failures.length,
	});

	let exitCode = 0;
	if ((loadFailed || textLoadFailed) && requiresEmbeddings) {
		exitCode = 1;
	}
	if (smokeFailed) {
		log.error(
			"[memories] SMOKE TEST FAILED: the model pipeline rejected the " +
				"generated test image before any real image was processed.",
		);
		exitCode = 1;
	}
	if (cls.systemic) {
		log.error(
			`[memories] SYSTEMIC FAILURE: all ${failures.length} images failed with the same error:`,
		);
		log.error(`[memories]   "${cls.dominantMessage}"`);
		log.error(
			"[memories]   This is a build/config regression, not corrupt data.",
		);
		log.error(
			"[memories]   Known pitfall: pipeline('feature-extraction') is " +
				"text-only in transformers.js v2 — use 'image-feature-extraction'.",
		);
		exitCode = 1;
	} else if (failures.length > 0) {
		log.warn(
			`[memories] ${failures.length}/${embeddedFilenames.length + failures.length} images failed:`,
		);
		log.warn(summarizeFailures(failures).join("\n"));
	}

	// The index and both bins must be aligned 1:1: only successfully embedded
	// images go into all of them, in the same sorted order, so row i of each
	// bin always corresponds to embeddedFilenames[i] of the index.
	fs.mkdirSync(path.dirname(indexFile), { recursive: true });

	const phraseDim = phraseEmbeddings.length > 0 ? dim : 0;
	// textMean (the shared text direction used to center queries at runtime)
	// ships in the index so the browser can center without the model. A
	// plain array keeps the index self-contained (~2 KB for 512 floats).
	// modelId names which model produced the embeddings (index v4).
	const index = {
		version: 4,
		modelId,
		dim,
		phraseDim,
		generatedAt: new Date().toISOString(),
		images: embeddedFilenames,
		textMean: textMean ? Array.from(textMean) : undefined,
	};
	fs.writeFileSync(indexFile, JSON.stringify(index), "utf-8");
	log.log(
		`[memories] Wrote index (${embeddedFilenames.length} images, ` +
			`phraseDim ${phraseDim}) to ${indexFile}`,
	);

	const binBytes = writeBin(embeddingsFile, embeddings, dim);
	if (binBytes > 0) {
		log.log(
			`[memories] Wrote embeddings (${embeddings.length}x${dim}) to ${embeddingsFile}`,
		);
	} else {
		unlinkQuiet(embeddingsFile);
	}

	const phraseBytes = writeBin(phraseFile, phraseEmbeddings, dim);
	if (phraseBytes > 0) {
		log.log(
			`[memories] Wrote phrase embeddings (${phraseEmbeddings.length}x${dim}) to ${phraseFile}`,
		);
	} else {
		unlinkQuiet(phraseFile);
	}

	// Precomputed results for the sample queries: instant suggested-search
	// chips (and their results) before the runtime model is even loaded.
	// embedQueryFn is async (embedText is a promise-based call), so the
	// query embeddings must be awaited — passing a Promise to hybridScore
	// would make every semantic term exactly 0 (dotProduct(Promise, vec)
	// computes Math.min(undefined, dim) = NaN and never iterates), leaving
	// only the filename-token fraction in every score.
	if (embedQueryFn && phraseEmbeddings.length > 0 && embeddings.length > 0) {
		try {
			const queries = await Promise.all(
				SAMPLE_QUERIES.map(async (q) => {
					const qVec = await embedQueryFn(q);
					const top = embeddedFilenames
						.map((filename, i) => ({
							filename,
							score: hybridScore(
								qVec,
								embeddings[i],
								phraseEmbeddings[i],
								q,
								filename,
							),
						}))
						.sort((a, b) => b.score - a.score)
						.slice(0, QUERIES_TOP_K);
					return { q, top };
				}),
			);
			fs.writeFileSync(
				queriesFile,
				JSON.stringify({
					version: 1,
					generatedAt: index.generatedAt,
					queries,
				}),
				"utf-8",
			);
			log.log(
				`[memories] Wrote ${queries.length} prototype queries to ${queriesFile}`,
			);
		} catch (err) {
			log.warn(
				`[memories] Failed to write prototype queries (${err.message}); chips disabled`,
			);
			unlinkQuiet(queriesFile);
		}
	} else {
		unlinkQuiet(queriesFile);
	}

	return {
		exitCode,
		systemic: cls.systemic,
		loadFailed,
		smokeFailed,
		textLoadFailed,
		embeddedCount: embeddings.length,
		total: embeddedFilenames.length + failures.length,
		dim,
		phraseDim,
		failures,
		index,
		binBytes,
		phraseBytes,
	};
}

// Files that are inputs to the embedding build alongside the images, so a
// changed build script invalidates the cached artifacts.
function buildInputScripts() {
	return [
		__filename,
		path.join(__dirname, "build-memory-embeddings.mjs"),
		path.join(__dirname, "memory-embedding-utils.js"),
	];
}

// Whether the on-disk artifacts already reflect the current inputs.
//
// The build is deterministic with respect to (images, build scripts, model
// availability), and the index is stamped with generatedAt on every run —
// success or failure. So "no input changed since the last run" is a safe skip
// condition in both cases: re-running would reproduce the same outcome.
//
// Returns { fresh, reason, emptyIndex }.
function isMemoriesFresh({
	imagesDir,
	outputDir,
	scripts = buildInputScripts(),
}) {
	const indexFile = path.join(outputDir, "memories-index.json");
	const embeddingsFile = path.join(outputDir, "memory-embeddings.bin");
	const phraseFile = path.join(outputDir, "memory-phrase-embeddings.bin");

	if (!fs.existsSync(indexFile)) {
		return {
			fresh: false,
			reason: "no memories-index.json",
			emptyIndex: false,
		};
	}

	// Anchor: the last run's timestamp. Prefer the index generatedAt (stamped
	// on every run, success or failure); fall back to the oldest output mtime.
	let anchor = 0;
	let index;
	try {
		index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
		if (index && index.generatedAt) {
			const t = Date.parse(index.generatedAt);
			if (!Number.isNaN(t)) anchor = t;
		}
	} catch {
		return {
			fresh: false,
			reason: "unreadable memories-index.json",
			emptyIndex: false,
		};
	}
	if (!anchor) {
		let oldest = Infinity;
		for (const f of [indexFile, embeddingsFile, phraseFile]) {
			try {
				oldest = Math.min(oldest, fs.statSync(f).mtimeMs);
			} catch {
				/* missing output */
			}
		}
		anchor = oldest === Infinity ? 0 : oldest;
	}

	// Integrity: a non-empty index must have its bins beside it (an empty
	// index is the known "build failed, keyword-search fallback" state).
	const imageCount = Array.isArray(index.images) ? index.images.length : 0;
	const phraseDim = index.phraseDim || 0;
	if (imageCount > 0) {
		if (!fs.existsSync(embeddingsFile)) {
			return {
				fresh: false,
				reason: "index has images but memory-embeddings.bin is missing",
				emptyIndex: false,
			};
		}
		if (phraseDim > 0 && !fs.existsSync(phraseFile)) {
			return {
				fresh: false,
				reason:
					"index has phraseDim but memory-phrase-embeddings.bin is missing",
				emptyIndex: false,
			};
		}
	}

	// Newest inputs. Images get an mtime grace (same-second saves on coarse
	// filesystems); scripts are compared strictly — they're edited deliberately.
	const GRACE_MS = 2000;
	const images = listImages(imagesDir);
	let newestImage = 0;
	for (const name of images) {
		try {
			newestImage = Math.max(
				newestImage,
				fs.statSync(path.join(imagesDir, name)).mtimeMs,
			);
		} catch {
			/* unreadable image */
		}
	}
	let newestScript = 0;
	for (const file of scripts) {
		try {
			newestScript = Math.max(newestScript, fs.statSync(file).mtimeMs);
		} catch {
			/* missing script */
		}
	}

	if (newestImage > anchor + GRACE_MS || newestScript > anchor) {
		return {
			fresh: false,
			reason: "inputs changed since the last build",
			emptyIndex: false,
		};
	}

	// Flag when photos exist on disk but the last build produced no embeddings
	// (a failed run), so the skip path can warn instead of silently leaving
	// semantic search disabled. An empty photos dir is not "empty" in this
	// sense — there's nothing to embed.
	return { fresh: true, emptyIndex: imageCount === 0 && images.length > 0 };
}

// Runs the whole memory-embedding build. Injectable options:
//   imagesDir, outputDir            — paths (defaults to the repo layout)
//   deps: { sharp, pipeline, RawImage, loadTransformers, loadTextModel }
//   log                              — logger (console by default)
//   env                              — process.env by default
// Returns a result object; never throws for expected failures.
async function buildMemories(options = {}) {
	const imagesDir = path.resolve(options.imagesDir ?? DEFAULT_IMAGES_DIR);
	const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
	const log = options.log ?? console;
	const env = options.env ?? process.env;
	const deps = options.deps ?? {};

	// The site build can select a model per run (MEMORIES_MODEL); the app's
	// runtime workers select theirs via INDEXER_MODEL (see indexer.js).
	const config = getModelConfig(env.MEMORIES_MODEL);
	log.log(
		`[memories] model: ${config.repo} (${config.label}, input ${config.inputSize}px, ` +
			`dim ${config.dim || "auto"})`,
	);

	const indexFile = path.join(outputDir, "memories-index.json");
	const embeddingsFile = path.join(outputDir, "memory-embeddings.bin");
	const phraseFile = path.join(outputDir, "memory-phrase-embeddings.bin");
	const queriesFile = path.join(outputDir, "memory-queries.json");

	// Skip the expensive CLIP pass when the artifacts already match the
	// current inputs (images + build scripts). MEMORIES_FORCE=1 bypasses.
	if (env.MEMORIES_FORCE !== "1") {
		const fresh = isMemoriesFresh({ imagesDir, outputDir });
		if (fresh.fresh) {
			log.log(
				"[memories] Embeddings are up to date — skipping build " +
					"(set MEMORIES_FORCE=1 to force a rebuild)",
			);
			if (fresh.emptyIndex) {
				log.warn(
					"[memories] memories-index.json is empty (semantic photo search " +
						"disabled; keyword fallback). The last build failed — check the " +
						"`bun run build:memories` output for the cause, fix it, then run " +
						"`MEMORIES_FORCE=1 bun run build:memories` to retry.",
				);
			}
			return { exitCode: 0, skipped: true };
		}
		if (fresh.reason) {
			log.log(`[memories] Rebuilding: ${fresh.reason}`);
		}
	}

	log.log("[memories] Building memory embeddings...");

	const filenames = listImages(imagesDir);
	log.log(`[memories] Found ${filenames.length} images`);

	// Never leave stale artifacts from a previous run: they would be
	// misaligned with a freshly written index.
	unlinkQuiet(embeddingsFile);
	unlinkQuiet(phraseFile);
	unlinkQuiet(queriesFile);

	const embeddings = [];
	const phraseEmbeddings = [];
	const embeddedFilenames = [];
	const failures = [];
	let dim = 0;
	let loadFailed = false;
	let smokeFailed = false;
	let textLoadFailed = false;
	let textModel = null;
	let textMean = null;

	let extractor;
	let RawImage;
	let sharp;
	try {
		const loaded = await loadTransformers(deps);
		RawImage = loaded.RawImage;
		sharp = await loadSharp(deps);
		extractor = await loaded.pipeline("image-feature-extraction", config.repo, {
			// transformers.js v3 replaced the v2 `quantized` flag with `dtype`
			// (q8 loads the same *_quantized.onnx files as before).
			dtype: config.visionQuantized ? "q8" : "fp32",
			...(config.modelFileName
				? {
						model_file_name: config.modelFileName,
						subfolder: config.subfolder,
					}
				: {}),
		});
	} catch (err) {
		loadFailed = true;
		const requiresEmbeddings = env.MEMORIES_REQUIRE_EMBEDDINGS === "1";
		log.error(`[memories] EMBEDDING BUILD FAILED: ${err.message}`);
		if (err.message && err.message.includes("text.split")) {
			log.error("[memories]   The CLIP model pipeline is not image-capable.");
			log.error(
				"[memories]   Use pipeline('image-feature-extraction', ...) — " +
					"'feature-extraction' is text-only in transformers.js v2.",
			);
		}
		if (requiresEmbeddings) {
			log.error("[memories]   MEMORIES_REQUIRE_EMBEDDINGS=1: failing build.");
		} else {
			log.error(
				"[memories]   Continuing without embeddings " +
					"(filename keyword search only). Set " +
					"MEMORIES_REQUIRE_EMBEDDINGS=1 to fail the build instead.",
			);
		}
		return await finish({
			embeddedFilenames,
			embeddings,
			phraseEmbeddings,
			dim,
			failures,
			log,
			indexFile,
			embeddingsFile,
			phraseFile,
			queriesFile,
			loadFailed,
			smokeFailed,
			requiresEmbeddings,
			textLoadFailed,
			embedQueryFn: null,
			textMean,
			modelId: resolveModelId(env.MEMORIES_MODEL),
		});
	}

	// Text encoder for filename phrases + sample queries. Failure degrades
	// to image-only ranking (still a full semantic search), unless strict.
	try {
		textModel = await loadTextModel(deps, env.MEMORIES_MODEL);
		if (textModel) {
			// Estimate the shared (anisotropic) text direction once. Queries
			// and filename phrases are centered against it so cosine ranking
			// reflects real content instead of the CLIP cone artifact.
			// resolveTextMean adopts the shipped/cached constant when present
			// (~830ms saved on M1) and falls back to compute + cache.
			textMean = await resolveTextMean({
				registryId: resolveModelId(env.MEMORIES_MODEL),
				dim: config.dim,
				textPair: textModel,
				textMaxLength: config.textMaxLength,
				log,
			});
		}
	} catch (err) {
		textLoadFailed = true;
		log.warn(
			`[memories] Text model failed to load (${err.message}); ` +
				"image-only ranking, no prototype queries",
		);
	}

	// Smoke test: any failure here is a config regression (wrong pipeline,
	// broken model weights), so it fails the build loudly regardless of
	// MEMORIES_REQUIRE_EMBEDDINGS. The probe also returns the ACTUAL output
	// dim — the ONNX graph is the truth, the registry entry a check.
	try {
		const probe = await runSmokeTest(
			extractor,
			RawImage,
			sharp,
			log,
			textModel,
			config.dim,
			config.textMaxLength,
			config.visionPool,
		);
		dim = probe.vec.length;
		if (config.dim > 0 && dim !== config.dim) {
			log.warn(
				`[memories] Model outputs ${dim}-dim embeddings but the registry ` +
					`declared ${config.dim}; adopting the actual dim`,
			);
		}
	} catch (err) {
		smokeFailed = true;
		log.error(`[memories] SMOKE TEST FAILED: ${err.message}`);
		if (err.message && err.message.includes("text.split")) {
			log.error("[memories]   The CLIP model pipeline is not image-capable.");
			log.error(
				"[memories]   Use pipeline('image-feature-extraction', ...) — " +
					"'feature-extraction' is text-only in transformers.js v2.",
			);
		}
		return await finish({
			embeddedFilenames,
			embeddings,
			phraseEmbeddings,
			dim,
			failures,
			log,
			indexFile,
			embeddingsFile,
			phraseFile,
			queriesFile,
			loadFailed,
			smokeFailed,
			requiresEmbeddings: false,
			textLoadFailed,
			embedQueryFn: null,
			textMean,
			modelId: resolveModelId(env.MEMORIES_MODEL),
		});
	}

	// Centering must receive the AWAITED vector: embedText is async, and
	// centerText's guards bail on anything without a real length — passing
	// the promise here would silently return it unchanged, and the `await`
	// downstream would then unwrap it to an UNCENTERED query vector, skewing
	// every prototype-query score (and ranking) away from the runtime's.
	const embedQueryFn = textModel
		? async (query) =>
				centerOrRaw(
					await embedText(query, textModel, dim, config.textMaxLength),
					textMean,
				)
		: null;

	for (const filename of filenames) {
		const filePath = path.join(imagesDir, filename);
		try {
			const first = await decodeToRaw(filePath, sharp, config.inputSize);
			let vec = await embedRawImage(
				extractor,
				RawImage,
				first,
				dim,
				config.visionPool,
			);

			// Animated GIFs: average the first and middle frames so the
			// embedding captures the loop's content, not just frame 0.
			const midPage = await gifMiddlePage(filePath, sharp);
			if (midPage !== null) {
				try {
					const mid = await decodeFrame(
						filePath,
						sharp,
						midPage,
						config.inputSize,
					);
					const midVec = await embedRawImage(
						extractor,
						RawImage,
						mid,
						dim,
						config.visionPool,
					);
					vec = averageVectors(vec, midVec);
				} catch (err) {
					log.warn(
						`[memories] Middle-frame embed failed for ${filename} (${err.message}); using first frame`,
					);
				}
			}

			// Filename phrase (text) embedding, aligned 1:1 with the image,
			// centered against the shared text direction like the runtime
			// query embedding will be.
			const phraseVec = textModel
				? centerOrRaw(
						await embedText(
							buildFilenamePhrase(filename),
							textModel,
							dim,
							config.textMaxLength,
						),
						textMean,
					)
				: null;

			embeddings.push(vec);
			if (phraseVec) phraseEmbeddings.push(phraseVec);
			embeddedFilenames.push(filename);
		} catch (err) {
			failures.push(err.message);
			log.warn(`[memories] Skipping ${filename}: ${err.message}`);
		}
		if (
			embeddings.length % 20 === 0 ||
			embeddings.length === filenames.length
		) {
			log.log(
				`[memories] Embedded ${embeddings.length}/${filenames.length} images`,
			);
		}
	}

	// The smoke probe already established dim; the first embedded vector is
	// the fallback when the probe was skipped (e.g. injected deps).
	if (dim === 0 && embeddings.length > 0) {
		dim = embeddings[0].length;
	}

	const requiresEmbeddings = env.MEMORIES_REQUIRE_EMBEDDINGS === "1";

	return await finish({
		embeddedFilenames,
		embeddings,
		phraseEmbeddings,
		dim,
		failures,
		log,
		indexFile,
		embeddingsFile,
		phraseFile,
		queriesFile,
		loadFailed,
		smokeFailed,
		requiresEmbeddings,
		textLoadFailed,
		embedQueryFn,
		textMean,
	});
}

module.exports = {
	buildMemories,
	isMemoriesFresh,
	listImages,
	runSmokeTest,
	decodeToRaw,
	decodeFrame,
	gifMiddlePage,
	embedRawImage,
	embedText,
	computeTextMean,
	resolveTextMean,
	loadTextMeanConstant,
	saveTextMeanConstant,
	writeTextMeanShipped,
	textMeanShippedPath,
	textMeanCachePath,
	textMeanSampleHash,
	centerOrRaw,
	loadTextModel,
	DEFAULT_IMAGES_DIR,
	DEFAULT_OUTPUT_DIR,
	getModelConfig,
	resolveModelId,
	MODEL_ID,
	EMBEDDING_DIM,
	MODELS,
	DEFAULT_MODEL_ID,
	IMAGE_EXTENSIONS,
};
