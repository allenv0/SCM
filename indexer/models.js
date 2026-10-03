"use strict";

// Curated model registry for photo discovery and long-form video search. The
// active model is chosen per-library (index.modelId), passed to workers via
// INDEXER_MODEL, and its bins are stored per model
// (memory-embeddings-<id>.bin).
//
// Each entry carries the facts the rest of the code needs:
//   repo       — transformers.js repo id (the pipeline + tokenizer/CLIPText
//                classes load from here)
//   dim        — expected embedding dim; >0 validates the ONNX output, and
//                the worker's dim probe still adopts the ACTUAL output dim
//                (the config is a check, the graph is the truth)
//   inputSize  — decode pre-resize target (the processor center-crops to its
//                own size afterwards; decoding at ~the processor's size keeps
//                the upscale loss negligible)
//   textMaxLength — fixed token length the text encoder requires. Some
//                exports have STATIC sequence shapes baked into the ONNX
//                graph, so padding to exactly this length (and truncating
//                longer inputs) makes them run.
//   visionQuantized — whether the image pipeline should run int8.
//   minimumWeightBytes — optional minimum bytes per relative ONNX path. This
//                guards against interrupted downloads being reused as if they
//                were valid model weights.
//   thresholds — ranking thresholds (minSemanticScore / relativeKeep); null
//                means "calibrate on first use" (see calibrateThresholds in
//                main.js). Per-model calibrations persist in memory-models.json
//                and override these seeds.
//   textClass  — which transformers.js class loads the text tower:
//                "clip" (CLIPTextModelWithProjection, the default) or
//                "siglip" (SiglipTextModel). Different exporters ship
//                different ONNX layouts, so the class must match the repo.
//   textOutputKey — the output key the text model emits its embedding under
//                ("text_embeds" for CLIP, "pooler_output" for SigLIP).
//   visionPool — whether the image pipeline must run with { pool: true }.
//                CLIP exports project to image_embeds by default; SigLIP's
//                vision model only exposes pooler_output (the default
//                last_hidden_state would be raw patch tokens, not a vector).
// Entries are listed in picker order: the scene-search default first, then
// the alternatives. The picker renders them in this order.
const MODELS = {
	"clip-vit-l14-336": {
		repo: "Xenova/clip-vit-large-patch14-336",
		label: "CLIP ViT-L/14@336",
		description:
			"Default for new libraries. Chosen for the strongest real-world video scene-search results in SCM. ~480–570ms/img CPU, ~435MB download. Use SigLIP-2 for faster bulk import.",
		dim: 768,
		inputSize: 336,
		visionQuantized: true,
		license: "MIT",
		speed: "slowest",
		quality: "best scene search",
		thresholds: null,
		// Guard against truncated downloads being reused as cache hits
		// (same class as the SigLIP-2 44MB-partial poison). Measured
		// 2026-09-24: vision 307,331,740 B, text 124,987,662 B; floors sit
		// ~2-4% below with the same discard + atomic re-download semantics.
		minimumWeightBytes: {
			"onnx/vision_model_quantized.onnx": 300_000_000,
			"onnx/text_model_quantized.onnx": 120_000_000,
		},
	},
	"siglip2-base-patch16-224": {
		repo: "onnx-community/siglip2-base-patch16-224-ONNX",
		label: "SigLIP-2-B/16",
		description:
			"Fast bulk-import option. Quality-ranked #3 of 4 measured (2026-09-24 gates): fine-detail 9/16 Top-1, everyday film-acc 0.76@5 — but still ~50–100ms/img CPU. Choose it when indexing speed matters more than scene-search fidelity. ~412MB download.",
		dim: 768,
		inputSize: 224,
		visionQuantized: true,
		// The exported text graph is STATIC at 64 tokens — any other length
		// fails with an ONNX broadcast error that CRASHES onnxruntime-node
		// (not a catchable JS error). The export's own tokenizer_config
		// model_max_length is a garbage float, so this pin is mandatory.
		textMaxLength: 64,
		textClass: "siglip",
		textOutputKey: "pooler_output",
		visionPool: true,
		license: "Apache-2.0",
		speed: "fastest",
		quality: "good",
		thresholds: null,
		// A truncated 44MB partial of text_model_quantized.onnx (vs 283MB
		// real) once poisoned this cache: with no minimums declared, any
		// size counts as a cache hit forever and every text-tower load
		// fails protobuf parsing. These floors make a future partial get
		// discarded + atomically re-downloaded instead.
		minimumWeightBytes: {
			"onnx/vision_model_quantized.onnx": 90_000_000,
			"onnx/text_model_quantized.onnx": 280_000_000,
		},
	},
	"siglip2-large-patch16-256": {
		repo: "onnx-community/siglip2-large-patch16-256-ONNX",
		label: "SigLIP-2-L/16@256",
		description:
			"High-detail option. Measured 2026-09-26 gates: 13/16 fine-detail Top-1 (MRR 0.875) — level with the 384px model at roughly 2.3x less compute (~200ms/img CPU vs ~480ms). 1024-dim, ~850MB download. Reach for it on small objects, signs, and on-screen text in photos or long videos.",
		dim: 1024,
		inputSize: 256,
		visionQuantized: true,
		textMaxLength: 64,
		textClass: "siglip",
		textOutputKey: "pooler_output",
		visionPool: true,
		license: "Apache-2.0",
		speed: "slower",
		quality: "best detail per second",
		thresholds: null,
		// Measured 2026-09-26: vision 319,618,816 B, text 568,343,664 B;
		// floors sit ~5% below with the same discard + atomic re-download
		// semantics as the other models.
		minimumWeightBytes: {
			"onnx/vision_model_quantized.onnx": 300_000_000,
			"onnx/text_model_quantized.onnx": 540_000_000,
		},
	},
	"siglip-base-patch16-384": {
		repo: "Xenova/siglip-base-patch16-384",
		label: "SigLIP-B/16@384",
		description:
			"Maximum-detail alternative. Quality-ranked #1 on the 2026-09-24 synthetic/broad gates (fine-detail 14/16 Top-1), but ~2.4x slower than SigLIP-2-L/16@256 — the last word only when its extra resolution is worth ~480ms/img CPU. ~214MB download.",
		dim: 768,
		inputSize: 384,
		visionQuantized: true,
		textMaxLength: 64,
		textClass: "siglip",
		textOutputKey: "pooler_output",
		visionPool: true,
		license: "Apache-2.0",
		speed: "slowest",
		quality: "better",
		thresholds: null,
	},
};

// Retired IDs must remain recognizable even though they are deliberately
// absent from MODELS. The library loader uses this table to preserve the old
// on-disk index until main has fully re-embedded it into the replacement — a
// plain resolve-to-default would otherwise pair 512-d MobileCLIP rows with a
// 768-d CLIP worker and silently make the library unsearchable.
const RETIRED_MODEL_MIGRATIONS = Object.freeze({
	"mobileclip2-s2": Object.freeze({ targetId: "clip-vit-l14-336" }),
});

// Default: CLIP ViT-L/14@336. SCM's hands-on video-scene-search validation
// found it returns the strongest scenes despite its slower import path. Fresh
// libraries use it; existing supported libraries retain their chosen model.
const DEFAULT_MODEL_ID = "clip-vit-l14-336";

function getModel(modelId) {
	return MODELS[modelId] || null;
}

function getRetiredModelMigration(modelId) {
	return RETIRED_MODEL_MIGRATIONS[modelId] || null;
}

// Unknown ids resolve to the default — the app must keep working even if a
// library references a model that no longer ships.
function resolveModelId(modelId) {
	return MODELS[modelId] ? modelId : DEFAULT_MODEL_ID;
}

module.exports = {
	MODELS,
	DEFAULT_MODEL_ID,
	RETIRED_MODEL_MIGRATIONS,
	getModel,
	getRetiredModelMigration,
	resolveModelId,
};
