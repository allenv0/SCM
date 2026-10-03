"use strict";

// Pure helpers for the memory-embedding build. Kept in CommonJS so jest can
// test them directly; the .mjs build script imports this via default import.

// Hybrid-scoring constants used by the build-time memory-queries.json
// generation. Keep in sync with app/lib/memoryRank.ts (runtime ranking).
const FILENAME_BOOST = 0.2;
const PHRASE_BOOST = 0.6;
// Post-centering CLIP text-image cosines live in a tight band (roughly
// 0.02–0.29 on this index). An absolute 0.10 gate cut real matches ("food"
// tops out ~0.055); 0.04 separates honest matches from the near-zero noise
// floor while keeping the "no matches" honesty for unrelated queries.
const MIN_SEMANTIC_SCORE = 0.04;
// Below this fraction of the TOP score a candidate is noise. See the
// runtime copy in app/lib/memoryRank.ts (RELATIVE_KEEP).
const RELATIVE_KEEP = 0.6;

// Single-char tokens ("a", "i") substring-match nearly every filename and
// add only noise; repeated tokens double-count the same evidence.
const MIN_TOKEN_LENGTH = 2;

// The sample queries double as the suggested-search chips on /memories and
// as the memories:check diagnostics. Kept here so build + check share them.
const SAMPLE_QUERIES = [
	"a laptop computer on a desk",
	"computer hacker",
	"a dog",
	"a beach or ocean scene",
	"a design mockup or poster",
	"devices",
];

// Words in filenames that add no meaning for CLIP text embedding.
const NOISE_TOKENS = new Set([
	"img",
	"image",
	"photo",
	"pic",
	"picture",
	"dsc",
	"dscn",
	"untitled",
	"new",
]);

// Token-level filename → CLIP text phrase. e.g. "scr-2024-2048-game.jpg" →
// "screenshot 2024 2048 game". Deterministic, used by build + runtime docs.
function buildFilenamePhrase(filename) {
	const base = filename.replace(/\.[^.]+$/, "");
	const tokens = base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((token) => (token === "scr" ? "screenshot" : token))
		.filter((token) => !NOISE_TOKENS.has(token))
		.slice(0, 8);
	return tokens.join(" ");
}

// Deterministic, topic-diverse prompt list used to estimate the shared
// (anisotropic) direction of CLIP text embeddings. The average of these
// embeddings approximates the cone axis; projecting it out of query and
// phrase vectors restores the discriminative text-image signal that raw
// CLIP text embeddings lack (unrelated texts score 0.8+ cosine by default).
// The SAMPLE_QUERIES are appended so the estimate covers the site's actual
// suggested-search chips too (derived, not re-typed, so the two can't drift).
const TEXT_MEAN_BASE = [
	"a photo of a dog",
	"a picture of a cat",
	"an image of a car",
	"a laptop on a desk",
	"the sky is blue",
	"a rocket launching into space",
	"a beach at sunset",
	"a plate of food",
	"a city street",
	"a portrait of a person",
	"a mountain landscape",
	"a computer screen",
	"a smartphone in hand",
	"a book on a table",
	"a coffee cup",
	"a bird in flight",
	"a flower in bloom",
	"an office meeting",
	"a video game screenshot",
	"a music album cover",
	"a house exterior",
	"a pair of shoes",
	"a shopping cart",
	"a hospital building",
	"a train station",
	"an airplane window",
	"a forest path",
	"a river between mountains",
	"a desert scene",
	"an astronaut in space",
];
const TEXT_MEAN_SAMPLE = [...TEXT_MEAN_BASE, ...SAMPLE_QUERIES];

// Projects `vec` (unit-length) onto the shared text direction and returns
// the residual, renormalized. CLIP text embeddings are strongly anisotropic
// (all texts share a dominant direction), so raw text-image cosine lands in
// a narrow noise band; removing the shared component restores ranking
// signal. Returns the input unchanged when no direction is provided, and
// null when the residual is degenerate (vector IS the shared direction).
// KEEP IN SYNC with centerQuery in app/hooks/useMemorySearch.ts (the runtime
// mirror of this math — same epsilon, same behavior).
function centerText(vec, textMean) {
	if (!textMean || textMean.length !== vec.length) return vec;
	const proj = dotProduct(vec, textMean);
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) {
		out[i] = vec[i] - proj * textMean[i];
	}
	// A zero-norm residual (vec IS the shared direction) can never be a
	// meaningful ranking direction; float noise leaves ~1e-7 here, so use
	// the same 1e-6 epsilon as the runtime hook rather than `norm <= 0`.
	let norm = 0;
	for (let i = 0; i < vec.length; i++) norm += out[i] * out[i];
	norm = Math.sqrt(norm);
	if (norm <= 1e-6) return null;
	for (let i = 0; i < vec.length; i++) out[i] /= norm;
	return out;
}

// Query text → deduplicated tokens, dropping single-char noise. Mirrors
// queryTokens in app/lib/memoryRank.ts (runtime tokenization must match).
function queryTokens(query) {
	const seen = new Set();
	for (const token of query.toLowerCase().split(/\s+/)) {
		if (token.length >= MIN_TOKEN_LENGTH) seen.add(token);
	}
	return [...seen];
}

// Fraction of query tokens found verbatim in the filename (0..1).
function filenameTokenMatch(query, filename) {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 0;
	const lower = filename.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (lower.includes(token)) hits++;
	}
	return hits / tokens.length;
}

// Filename → the token list used to build the phrase embedding (see
// buildFilenamePhrase). Runtime copy: app/lib/memoryRank.ts phraseTokens.
function phraseTokens(filename) {
	const base = filename.replace(/\.[^.]+$/, "");
	return base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((token) => (token === "scr" ? "screenshot" : token))
		.filter((token) => !NOISE_TOKENS.has(token))
		.slice(0, 8);
}

// Whether any query token appears in the filename's derived phrase (0..1).
// The phrase boost must only fire on LITERAL overlap: centered CLIP
// text-text cosine is ~0.2–0.4 for every pair, so an ungated phrase boost
// turns every query (even "zzzz-nothing") into a wall of ~0.3 scores.
function phraseTokenOverlap(query, filename) {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 0;
	const phrase = phraseTokens(filename);
	if (phrase.length === 0) return 0;
	let hits = 0;
	for (const token of tokens) {
		if (phrase.includes(token)) hits++;
	}
	return hits / tokens.length;
}

function dotProduct(a, b) {
	const n = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < n; i++) sum += a[i] * b[i];
	return sum;
}

// Same composition as app/lib/memoryRank.ts rankMemoriesHybrid:
// image cosine + gated phrase-excess boost + filename-token boost. The
// phrase boost only fires when the query literally names something in the
// filename's phrase (phraseTokenOverlap), mirroring the runtime gate.
function hybridScore(qVec, imageVec, phraseVec, query, filename) {
	let score = dotProduct(qVec, imageVec);
	if (phraseVec && phraseTokenOverlap(query, filename) > 0) {
		const phraseSim = dotProduct(qVec, phraseVec);
		if (phraseSim > score) score += PHRASE_BOOST * (phraseSim - score);
	}
	score += FILENAME_BOOST * filenameTokenMatch(query, filename);
	return score;
}

// Throws if the vector is not usable as an embedding row.
function validateEmbedding(vec, expectedDim) {
	if (!vec || typeof vec.length !== "number" || vec.length === 0) {
		throw new Error("Embedding output is empty");
	}
	if (expectedDim > 0 && vec.length !== expectedDim) {
		throw new Error(
			`Embedding dimension mismatch: expected ${expectedDim}, got ${vec.length}`,
		);
	}
	for (let i = 0; i < vec.length; i++) {
		const v = vec[i];
		if (typeof v !== "number" || Number.isNaN(v)) {
			throw new Error(`Embedding contains NaN at index ${i}`);
		}
		if (!Number.isFinite(v)) {
			throw new Error(`Embedding contains non-finite value at index ${i}`);
		}
	}
	return true;
}

// L2-normalizes in place; returns the norm for diagnostics.
function normalizeInPlace(vec) {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		norm += vec[i] * vec[i];
	}
	norm = Math.sqrt(norm);
	if (norm <= 0) {
		throw new Error("Embedding has zero norm (cannot normalize)");
	}
	for (let i = 0; i < vec.length; i++) {
		vec[i] /= norm;
	}
	return norm;
}

// Classifies a batch of per-image error messages.
// Returns { systemic, dominantMessage, count } where systemic means every
// failure shares one message AND either enough failures to rule out a handful
// of corrupt files (minSystemicCount) or 100% of images failed (a
// pipeline/config regression, e.g. text-only feature-extraction).
function classifyFailures(errors, { minSystemicCount = 5, total = null } = {}) {
	if (!errors || errors.length === 0) {
		return { systemic: false, dominantMessage: null, count: 0 };
	}
	const counts = new Map();
	for (const message of errors) {
		counts.set(message, (counts.get(message) || 0) + 1);
	}
	const [dominantMessage, count] = [...counts.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0];
	const allSame = count === errors.length;
	const allFailed = total !== null && errors.length === total && total > 0;
	const systemic = allSame && (errors.length >= minSystemicCount || allFailed);
	return { systemic, dominantMessage, count };
}

// Groups failure messages with counts for a human-readable summary.
function summarizeFailures(errors) {
	const counts = new Map();
	for (const message of errors) {
		counts.set(message, (counts.get(message) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([message, n]) => `  - ${n}x ${message}`);
}

module.exports = {
	validateEmbedding,
	normalizeInPlace,
	classifyFailures,
	summarizeFailures,
	buildFilenamePhrase,
	phraseTokens,
	phraseTokenOverlap,
	queryTokens,
	filenameTokenMatch,
	dotProduct,
	hybridScore,
	centerText,
	TEXT_MEAN_SAMPLE,
	FILENAME_BOOST,
	PHRASE_BOOST,
	MIN_SEMANTIC_SCORE,
	RELATIVE_KEEP,
	SAMPLE_QUERIES,
};
