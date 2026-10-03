"use strict";

// Bench: batch-1 vs batched inference on the exact worker stack (Plan §3.0,
// settles Plan §8.1 — is text batching a win on this hardware?). No Electron,
// no parentPort — loads via scripts/bench-common.js.
//
//   node scripts/bench-inference.js [--iters 12] [--model <registry id>] [--out <json>]
//
// Stages (JSON flushed to --out after EACH stage, so a hard ONNX crash on a
// batched shape — the failure mode models.js warns about for static graphs —
// still leaves every earlier measurement on disk):
//   1. vision-batch-1 — core.embedRawImage per image (the worker's exact path)
//   2. vision-batched — extractor([RawImage×N], {pool:true}), N ∈ 2/4/8/16
//   3. text-serial    — core.embedText over TEXT_MEAN_SAMPLE (the init cost)
//   4. text-batched   — tokenizer(K) + text model, K ∈ 2/8/16/36
// Parity gate: max cosine deviation vs batch-1 on identical pixels/tokens
// (< 1e-4, per Inference-Faster-Plan.md §3.1 — batching only; the raw-pipe
// change is gated on Top-K parity instead).

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	loadStack,
	median,
	pct,
	mean,
	cosine,
	splitRows,
	makeSolidJpegs,
	chunk,
	argValue,
} = require("./bench-common.js");
const { TEXT_MEAN_SAMPLE } = require("../indexer/memory-embedding-utils.js");
const core = require("../indexer/build-memory-embeddings-core.js");

const now = () => performance.now();

// Diagnostic per-row validation (mirrors memory-embedding-utils' semantics;
// batch-1 rows go through the real ones inside core.embedText/embedRawImage).
function rowOk(vec, dim) {
	if (vec.length !== dim) return false;
	for (let i = 0; i < vec.length; i++) {
		if (!Number.isFinite(vec[i])) return false;
	}
	return true;
}

function normalizeInPlace(vec) {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm);
	if (norm > 1e-12) {
		for (let i = 0; i < vec.length; i++) vec[i] /= norm;
	}
	return vec;
}

function fmtMs(x) {
	return x == null ? "—" : x.toFixed(1);
}

async function main() {
	const iters = Math.max(1, Number(argValue("--iters", "12")));
	const outPath = argValue("--out", null);
	const stack = await loadStack();
	// loadStack spreads the text pair (tokenizer/textModel/outputKey are top-level).
	const { config, extractor, RawImage, sharp, dim, eps } = stack;
	const textPair = {
		tokenizer: stack.tokenizer,
		textModel: stack.textModel,
		outputKey: stack.outputKey,
	};
	const mtl = config.textMaxLength || 0;

	const results = {
		meta: {
			date: new Date().toISOString(),
			node: process.version,
			model: config.repo,
			label: config.label,
			dim,
			eps,
			cache: process.env.TRANSFORMERS_CACHE || null,
			iters,
			textMaxLength: mtl,
			textSampleSize: TEXT_MEAN_SAMPLE.length,
		},
		vision: { batch1: null, batches: {} },
		text: { serial: null, batches: {}, verdict: null },
	};

	const outDir = path.dirname(outPath || "/tmp/scm-bench/inference.json");
	const out = outPath || path.join(outDir, `inference-${Date.now()}.json`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const flush = (stage) => {
		fs.writeFileSync(out, JSON.stringify(results, null, 2));
		console.log(`[bench] stage "${stage}" flushed → ${out}`);
	};

	// Fixed image set (16 → batch sizes 2/4/8/16 divide evenly).
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-bench-infer-"));
	const jpgs = await makeSolidJpegs(sharp, tmp, 16);
	console.log(
		`[bench] decoding ${jpgs.length} images via the worker's decodeToRaw…`,
	);
	const raws = [];
	for (const f of jpgs)
		raws.push(await core.decodeToRaw(f, sharp, config.inputSize));

	// --- Stage 1: vision batch-1 (the worker path) --------------------------
	console.log(
		`[bench] stage 1/4: vision batch-1 × ${iters} rounds × ${raws.length} images…`,
	);
	let refVecs = null;
	const b1Samples = [];
	for (let r = 0; r < iters; r++) {
		const round = [];
		for (const raw of raws) {
			const t0 = now();
			const vec = await core.embedRawImage(
				extractor,
				RawImage,
				raw,
				dim,
				config.visionPool,
			);
			b1Samples.push(now() - t0);
			round.push(vec);
		}
		if (r === 0) refVecs = round;
	}
	// Warmup happened inside round 0; drop it from the stats.
	const b1 = b1Samples.slice(raws.length);
	results.vision.batch1 = {
		count: b1.length,
		medianMs: median(b1),
		p95Ms: pct(b1, 0.95),
		meanMs: mean(b1),
		note: "core.embedRawImage batch-1 (worker path incl. validate+normalize)",
	};
	console.log(
		`  batch-1: median ${fmtMs(median(b1))} ms/img (p95 ${fmtMs(pct(b1, 0.95))}, n=${b1.length})`,
	);
	flush("vision-batch-1");

	// --- Stage 2: vision batched --------------------------------------------
	console.log(
		`[bench] stage 2/4: vision batched N ∈ 2/4/8/16 × ${iters} rounds…`,
	);
	for (const N of [2, 4, 8, 16]) {
		const groups = chunk(raws, N);
		const samples = [];
		const perImage = [];
		let maxDelta = 0;
		let ok = true;
		try {
			// 1 warmup round excluded.
			for (let r = 0; r <= iters; r++) {
				const rowsAll = [];
				const t0 = now();
				for (const group of groups) {
					const images = group.map(
						(raw) =>
							new RawImage(raw.data, raw.width, raw.height, raw.channels),
					);
					const result = await extractor(
						images,
						config.visionPool ? { pool: true } : undefined,
					);
					rowsAll.push(...splitRows(result, group.length, dim));
				}
				const ms = now() - t0;
				if (r === 0) continue;
				samples.push(ms);
				perImage.push(ms / raws.length);
				for (let i = 0; i < rowsAll.length; i++) {
					if (!rowOk(rowsAll[i], dim)) ok = false;
					normalizeInPlace(rowsAll[i]);
					maxDelta = Math.max(
						maxDelta,
						Math.abs(cosine(rowsAll[i], refVecs[i]) - 1),
					);
				}
			}
		} catch (err) {
			results.vision.batches[N] = { error: String(err.message || err) };
			console.log(`  batch-${N}: FAILED — ${err.message}`);
			flush(`vision-batch-${N}-error`);
			continue;
		}
		results.vision.batches[N] = {
			forwardCount: groups.length,
			medianMsPerForward: median(samples),
			medianMsPerImage: median(perImage),
			p95MsPerForward: pct(samples, 0.95),
			samplesMs: samples.map((x) => Math.round(x)),
			maxCosineDeltaVsBatch1: maxDelta,
			rowsValid: ok,
			speedupVsBatch1: results.vision.batch1.medianMs / median(perImage),
		};
		console.log(
			`  batch-${N}: ${fmtMs(median(perImage))} ms/img amortized ` +
				`(${fmtMs(median(samples))} ms/forward, ×${groups.length}) — ` +
				`parity Δcos ${maxDelta.toExponential(2)}`,
		);
		flush(`vision-batch-${N}`);
	}

	// --- Stage 3: text serial (the init cost) -------------------------------
	console.log(
		`[bench] stage 3/4: text serial — core.embedText × ${TEXT_MEAN_SAMPLE.length} texts × 3 rounds…`,
	);
	// 2 warmups.
	await core.embedText(TEXT_MEAN_SAMPLE[0], textPair, dim, mtl);
	await core.embedText(TEXT_MEAN_SAMPLE[1], textPair, dim, mtl);
	const tSamples = [];
	let refTexts = null;
	const roundTotals = [];
	for (let r = 0; r < 3; r++) {
		const round = [];
		let total = 0;
		for (const text of TEXT_MEAN_SAMPLE) {
			const t0 = now();
			const vec = await core.embedText(text, textPair, dim, mtl);
			const ms = now() - t0;
			tSamples.push(ms);
			total += ms;
			round.push(vec);
		}
		roundTotals.push(total);
		if (r === 0) refTexts = round;
	}
	results.text.serial = {
		count: TEXT_MEAN_SAMPLE.length,
		medianMs: median(tSamples),
		p95Ms: pct(tSamples, 0.95),
		initTotalMs: Math.min(...roundTotals),
		initTotalAllRoundsMs: roundTotals,
		note: "core.embedText serial; initTotalMs = one full TEXT_MEAN_SAMPLE pass (the worker-init cost)",
	};
	console.log(
		`  text serial: median ${fmtMs(median(tSamples))} ms/text — init pass ${fmtMs(
			Math.min(...roundTotals),
		)} ms for ${TEXT_MEAN_SAMPLE.length} embeds`,
	);
	flush("text-serial");

	// --- Stage 4: text batched ----------------------------------------------
	console.log(`[bench] stage 4/4: text batched K ∈ 2/8/16/36 × 3 rounds…`);
	for (const K of [2, 8, 16, 36]) {
		const groups = chunk(TEXT_MEAN_SAMPLE, K);
		const samples = [];
		const perText = [];
		let maxDelta = 0;
		let ok = true;
		try {
			for (let r = 0; r <= 3; r++) {
				const rowsAll = [];
				const t0 = now();
				for (const group of groups) {
					const inputs = textPair.tokenizer(group, {
						padding: "max_length",
						max_length: mtl,
						truncation: true,
					});
					const outputs = await textPair.textModel(inputs);
					const rows = splitRows(
						outputs[textPair.outputKey],
						group.length,
						dim,
					);
					for (const v of rows) {
						if (!rowOk(v, dim)) ok = false;
						normalizeInPlace(v);
					}
					rowsAll.push(...rows);
				}
				const ms = now() - t0;
				if (r === 0) continue;
				samples.push(ms);
				perText.push(ms / TEXT_MEAN_SAMPLE.length);
				for (let i = 0; i < rowsAll.length; i++) {
					maxDelta = Math.max(
						maxDelta,
						Math.abs(cosine(rowsAll[i], refTexts[i]) - 1),
					);
				}
			}
		} catch (err) {
			results.text.batches[K] = { error: String(err.message || err) };
			console.log(`  batch-${K}: FAILED — ${err.message}`);
			flush(`text-batch-${K}-error`);
			continue;
		}
		results.text.batches[K] = {
			forwardCount: groups.length,
			medianMsPerForward: median(samples),
			medianMsPerText: median(perText),
			// One full 36-text pass at this batch size = median forward × groups.
			initEquivalentMs: median(samples) * groups.length,
			samplesMs: samples.map((x) => Math.round(x)),
			maxCosineDeltaVsSerial: maxDelta,
			rowsValid: ok,
			speedupVsSerial: results.text.serial.medianMs / median(perText),
		};
		console.log(
			`  batch-${K}: ${fmtMs(median(perText))} ms/text amortized ` +
				`(${fmtMs(median(samples))} ms/forward × ${groups.length}) — ` +
				`parity Δcos ${maxDelta.toExponential(2)}`,
		);
		flush(`text-batch-${K}`);
	}

	// --- Verdict -------------------------------------------------------------
	const b8 = results.text.batches[8];
	const serialMs = results.text.serial.medianMs;
	if (b8 && !b8.error) {
		const amort = b8.medianMsPerText;
		results.text.verdict =
			amort < serialMs * 0.75
				? "batching-wins"
				: amort > serialMs * 1.25
					? "batching-regresses"
					: "wash";
	} else {
		results.text.verdict = "inconclusive-or-crash";
	}
	console.log(`\n[bench] text verdict: ${results.text.verdict}`);
	console.log(
		`[bench] vision batch-1 median: ${fmtMs(results.vision.batch1.medianMs)} ms/img`,
	);
	fs.writeFileSync(out, JSON.stringify(results, null, 2));
	console.log(`[bench] results → ${out}`);

	fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(`[bench] FATAL: ${err.stack || err}`);
	process.exit(1);
});
