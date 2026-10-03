"use strict";

// Unit tests for the scoreLibrary OCR-cutoff exemption (the Files-mode
// poster guarantee): a row whose OCR text literally contains the query token
// survives the percentile cutoff and is boosted to the front — even when its
// natural cosine sits deep in the tail (the CLIP-default case: compressed
// bands where a dark poster's 0.04 trails a dozen gray solids at 0.09).
// Also covers the fusion noise-gate minimum-total guard: fraction gates
// stand down on tiny corpora.

const assert = require("node:assert/strict");
const rank = require("../main-lib/rank-search.js");
const {
	fuseVisualTextMoments,
	FUSION_NOISE_MIN_TOTAL,
} = require("../indexer/transcript-store-utils.js");

function unitVec(dim, first) {
	const v = new Float32Array(dim).fill(0);
	v[0] = first;
	let n = 0;
	for (let i = 1; i < dim; i++) {
		v[i] = 1;
		n += 1;
	}
	n += first * first;
	n = Math.sqrt(n);
	for (let i = 0; i < dim; i++) v[i] /= n;
	return v;
}

function norm(v) {
	let n = 0;
	for (let i = 0; i < v.length; i++) n += v[i] * v[i];
	return Math.sqrt(n);
}

async function main() {
	// --- scoreLibrary: exact OCR word rows survive the percentile cutoff
	const dim = 8;
	const qVec = unitVec(dim, 3);
	// Natural cosines: three hot rows, then the poster deep in the tail.
	const naturals = [0.4, 0.35, 0.3, 0.05, 0.04];
	const names = ["a.jpg", "b.jpg", "c.jpg", "poster-deep.png", "d.jpg"];
	const embeddings = naturals.map((s) => {
		// Build a unit vector with the target cosine against qVec:
		// v = s*q + w*o with o⊥q unit, q unit → cos(q,v) = s.
		const q = qVec;
		const v = new Float32Array(dim);
		// Blend q with an orthogonal unit vector o.
		const o = new Float32Array(dim);
		o[1] = 1;
		// Remove o's q-component to orthogonalize.
		let dot = 0;
		for (let i = 0; i < dim; i++) dot += o[i] * q[i];
		for (let i = 0; i < dim; i++) o[i] -= dot * q[i];
		const on = norm(o);
		for (let i = 0; i < dim; i++) o[i] /= on;
		const w = Math.sqrt(Math.max(0, 1 - s * s));
		for (let i = 0; i < dim; i++) v[i] = s * q[i] + w * o[i];
		return v;
	});
	const lib = {
		filenames: names,
		embeddings,
		phrases: [],
		ocrWords: [
			[],
			[],
			[],
			[{ text: "DEEP" }, { text: "TEST" }, { text: "POSTER" }],
			[],
		],
		dim,
	};
	const norms = embeddings.map(norm);
	const thresholds = { minSemanticScore: 0.01, relativeKeep: 0.6 };
	const out = rank.scoreLibrary(lib, "test", qVec, 24, thresholds, norms);
	const order = out.map((r) => r.filename);
	// cutoffRank = floor(5*0.4) = 2 → cutoff 0.3: poster (0.05) would be cut
	// without the exemption; with it, it survives and the +0.5 word boost
	// puts it first (0.55 > 0.4).
	assert.ok(
		order.includes("poster-deep.png"),
		`poster must survive, got: ${order.join(",")}`,
	);
	assert.equal(
		order[0],
		"poster-deep.png",
		`poster must lead, got: ${order.join(",")}`,
	);
	// The no-evidence tail row below the cutoff still drops out.
	assert.ok(!order.includes("d.jpg"), `tail must stay cut: ${order.join(",")}`);
	// Nonsense queries (no OCR hit anywhere) are unaffected: empty-ish set.
	const out2 = rank.scoreLibrary(lib, "xqzt", qVec, 24, thresholds, norms);
	assert.ok(
		!out2.map((r) => r.filename).includes("poster-deep.png"),
		"nonsense must not rescue the poster",
	);

	// --- fuseVisualTextMoments: tiny totals stand the fraction gate down
	const V = (filename, t, score) => ({ filename, t, dur: 1, poster: 0, score });
	const mkHits = (n) =>
		Array.from({ length: n }, (_, i) => V(`v${i % 10}.mp4`, i, 0.5));
	const tinyTotal = Math.max(1, FUSION_NOISE_MIN_TOTAL - 9);
	const tiny = fuseVisualTextMoments({
		visualHits: mkHits(tinyTotal),
		textHits: [],
		visualTotal: tinyTotal,
		textTotal: 0,
		minScore: 0.01,
		relativeKeep: 0.6,
		topK: 24,
		wVisual: 1,
		wText: 0,
	});
	assert.ok(
		tiny.length >= 2,
		`tiny corpus must not gate to [], got ${tiny.length}`,
	);
	// Same per-row heat on a large corpus still gates.
	const big = fuseVisualTextMoments({
		visualHits: mkHits(100),
		textHits: [],
		visualTotal: 240,
		textTotal: 0,
		minScore: 0.01,
		relativeKeep: 0.6,
		topK: 24,
		wVisual: 1,
		wText: 0,
	});
	assert.deepEqual(big, [], "large-corpus flood must still gate to []");

	console.log("ok - rank OCR exemption + fusion min-total guard");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
