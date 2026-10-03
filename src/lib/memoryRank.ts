import { cosineSimilarity, diversityFilter } from "@/lib/semanticUtils";
import { cjkBigramsForText, containsCjk, CJK_RUN_RE } from "@/lib/cjkTokens";

// Hybrid-scoring constants. Keep in sync with scripts/memory-embedding-utils.js,
// which uses the same values when precomputing memory-queries.json at build time.
// After the CLIP anisotropy fix (query/phrase embeddings are mean-centered),
// scores live in a tight band (roughly 0.02–0.29 on this index): an absolute
// 0.10 gate cut real matches ("food" tops out ~0.055), so the honest-match
// cutoff is 0.04 — above the near-zero noise floor, below genuine content.
export const FILENAME_BOOST = 0.2;
export const PHRASE_BOOST = 0.6;
// OCR text (visible text extracted from the image itself — poster titles,
// screenshot captions, credits) is literal evidence the image CONTAINS the
// query's words, so a full overlap is trusted more than a filename hint but
// less than the gated phrase embedding. Gated implicitly: ocrTokenMatch is
// 0 when no query token appears in the text, so no overlap = no boost.
export const OCR_BOOST = 0.35;
export const MIN_SEMANTIC_SCORE = 0.04;
export const MEMORY_DIVERSITY_THRESHOLD = 0.92;
// Below this fraction of the TOP score a candidate is considered noise.
// CLIP cosines live in a tight band (0.02–0.29) where the noise tail for an
// unrelated photo can reach 0.05–0.09 — an absolute floor alone cannot tell
// "weak but real" from "pure noise", so we also cut relative to the best
// match. Without this, topK=24 on a small library returns every photo for
// every query (including nonsense), which reads as "completely irrelevant".
export const RELATIVE_KEEP = 0.6;

// Single-char tokens ("a", "i") substring-match nearly every filename and
// add only noise; repeated tokens double-count the same evidence.
const MIN_TOKEN_LENGTH = 2;

// Words in filenames that add no meaning for CLIP text embedding. Mirrors
// NOISE_TOKENS in scripts/memory-embedding-utils.js (build-time tokenization
// must match the runtime's).
const PHRASE_NOISE_TOKENS = new Set([
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

// Filename → the same token list the build-time phrase embeddings were
// computed from (scripts/memory-embedding-utils.js buildFilenamePhrase):
// lowercase, split on separators, scr→screenshot, noise tokens dropped,
// capped at 8 tokens. Used to gate the phrase boost on LITERAL content
// overlap with the query — the phrase embedding only amplifies evidence the
// filename actually states ("screenshot 20260810 pnff"), never a semantic
// guess (a centered CLIP text-text cosine is ~0.2–0.4 for EVERY pair, so an
// ungated boost is pure noise injection).
export function phraseTokens(filename: string): string[] {
	const base = filename.replace(/\.[^.]+$/, "");
	return base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((token) => (token === "scr" ? "screenshot" : token))
		.filter((token) => !PHRASE_NOISE_TOKENS.has(token))
		.slice(0, 8);
}

// Whether any query token appears in the filename's derived phrase. The
// phrase boost must only fire on literal overlap — see phraseTokens.
export function phraseTokenOverlap(query: string, filename: string): number {
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

export interface MemoryEntry {
	filename: string;
}

// A video's best-matching shot segment (Phase 2 of scene search). `t` is the
// midpoint frame to seek to, `poster` is the scene-poster index (the worker
// writes <stem>-scene-<poster>.jpg), `score` is the segment's cosine against
// the query. Fusion adds `why` (visual=text frame, text=speech chunk, both)
// and `snippet` (transcript text, ≤80 chars) — additive, never changes math.
// Exact dialogue search (v3) adds `tier`/`tierLabel` (1 Exact line, 2 Exact
// words, 3 Words spoken) plus `matchStart`/`matchLen` (char offsets of the
// first matched word inside `snippet` for UI highlight) — additive as well.
export interface SceneMatch {
	t: number;
	dur: number;
	poster: number;
	score: number;
	why?: "visual" | "text" | "both";
	snippet?: string | null;
	tier?: number;
	tierLabel?: string;
	matchStart?: number;
	matchLen?: number;
}

export interface RankedMemory {
	filename: string;
	score: number;
	// Present only when scene segments were loaded and the best-matching
	// segment beat the noise floor. Additive — never changes ranking math.
	bestScene?: SceneMatch | null;
	// Which signal dominated this result's placement. Drives the one-line
	// "why it matched" badge on each card.
	dominant?: "semantic" | "phrase" | "filename" | "ocr";
	// Individual score components — carried through to the hover tooltip so
	// the user can inspect exactly why the result landed where it did.
	breakdown?: ScoreBreakdown;
}

export interface ScoreBreakdown {
	semantic: number;
	phrase: number;
	filename: number;
	ocr: number;
}

// Query text → deduplicated tokens, dropping single-char Latin noise.
// Mirrors queryTokens in scripts/memory-embedding-utils.js (build-time
// tokenization must match the runtime's) for the Latin side. CJK side:
// spaceless scripts expand to overlapping bigrams ("台北車站" → 台北/北車/車站;
// lone 駅 stays 駅), so a CJK query finds photos whose OCR text contains the
// same characters even without word boundaries. Mixed queries ("東京 Tokyo")
// contribute both. CJK tokens are exempt from MIN_TOKEN_LENGTH.
export function queryTokens(query: string): string[] {
	const seen = new Set<string>();
	const lower = (query || "").toLowerCase();
	// Latin side: split CJK runs out first so "東京Tokyo" still yields "tokyo".
	CJK_RUN_RE.lastIndex = 0;
	const latinPart = lower.replace(CJK_RUN_RE, " ");
	for (const token of latinPart.split(/\s+/)) {
		if (token.length >= MIN_TOKEN_LENGTH) seen.add(token);
	}
	// CJK side: overlapping bigrams over every Han/Hiragana/Katakana/Hangul run.
	for (const bigram of cjkBigramsForText(lower)) {
		seen.add(bigram);
	}
	return [...seen];
}

/** True when the raw query contains CJK (drives highlight substring mode). */
export function queryHasCjk(query: string): boolean {
	return containsCjk(query || "");
}

// Fraction of query tokens that appear verbatim in the filename (0..1).
export function filenameTokenMatch(query: string, filename: string): number {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 0;
	const lower = filename.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (lower.includes(token)) hits++;
	}
	return hits / tokens.length;
}

// Fraction of query tokens that appear verbatim in the image's OCR text
// (0..1). The text was extracted from the image itself, so a token hit is
// literal visible content — the strongest keyword evidence there is.
export function ocrTokenMatch(
	query: string,
	ocrText: string | null | undefined,
): number {
	const tokens = queryTokens(query);
	if (tokens.length === 0 || !ocrText) return 0;
	const lower = ocrText.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (lower.includes(token)) hits++;
	}
	return hits / tokens.length;
}

// Rank memories by cosine similarity against the query embedding
// (CLIP text embedding, aligned with the precomputed image embeddings).
export function rankMemories(
	qVec: Float32Array,
	memories: MemoryEntry[],
	embeddings: Float32Array[],
	topK = 24,
): RankedMemory[] {
	if (!qVec || qVec.length === 0 || memories.length === 0) {
		return [];
	}
	if (embeddings.length !== memories.length) {
		return [];
	}

	const scored = memories
		.map((memory, index) => ({
			filename: memory.filename,
			score: cosineSimilarity(qVec, embeddings[index]),
		}))
		.sort((a, b) => b.score - a.score);

	return scored.slice(0, Math.max(0, topK));
}

export interface HybridRankOptions {
	topK?: number;
	// Below this top score the whole ranking is considered a miss
	// (CLIP zero-shot "no matches" honesty instead of 24 random photos).
	minScore?: number;
	// Raw query text; used for the filename-token boost.
	query?: string;
	// Build-time CLIP text embeddings of cleaned filename phrases,
	// aligned 1:1 with `embeddings`. Adds a semantic boost for literal
	// filename content that the image embedding alone cannot see.
	phraseEmbeddings?: Float32Array[] | null;
	// OCR text extracted from each image, aligned 1:1 with `embeddings`
	// (null/absent = never OCR'd). A query token found in the image's own
	// visible text is literal evidence the image is about it — e.g. a
	// movie poster whose title text CLIP cannot read.
	ocrTexts?: (string | null | undefined)[] | null;
	filenameBoost?: number;
	phraseBoost?: number;
	ocrBoost?: number;
	// Dedupe near-identical photos so one scene cannot dominate the topK.
	diversity?: boolean;
	// Fraction of the TOP score a candidate must keep to survive the
	// relative relevance cutoff. Defaults to RELATIVE_KEEP; the active
	// model's calibrated value (from /memories-models.json) overrides it.
	relativeKeep?: number;
}

// Hybrid semantic + filename retrieval. Score components:
//   semantic   — cosine(query, image embedding)
//   phrase     — only the EXCESS of cosine(query, filename-phrase embedding)
//                over the image score (text-text similarities run
//                systematically hotter than text-image, so only the surplus
//                is trusted as filename-only evidence)
//   filename   — FILENAME_BOOST x token-match ratio (catches "2048", "drone")
export function rankMemoriesHybrid(
	qVec: Float32Array,
	memories: MemoryEntry[],
	embeddings: Float32Array[],
	options: HybridRankOptions = {},
): RankedMemory[] {
	const topK = Math.max(0, options.topK ?? 24);
	if (!qVec || qVec.length === 0 || memories.length === 0) {
		return [];
	}
	if (embeddings.length !== memories.length) {
		return [];
	}
	// Defensive: a misaligned phrase bin must never break semantic ranking.
	const phrase =
		options.phraseEmbeddings?.length === memories.length
			? options.phraseEmbeddings
			: null;
	const filenameBoost = options.filenameBoost ?? FILENAME_BOOST;
	const phraseBoost = options.phraseBoost ?? PHRASE_BOOST;
	const ocrBoost = options.ocrBoost ?? OCR_BOOST;
	const query = options.query?.trim();
	// Defensive: a misaligned OCR array must never break semantic ranking.
	const ocr =
		options.ocrTexts?.length === memories.length ? options.ocrTexts : null;

	let scored: { idx: number; filename: string; score: number }[] = [];
	for (let i = 0; i < memories.length; i++) {
		let score = cosineSimilarity(qVec, embeddings[i]);
		if (phrase && query) {
			// GATE: only trust the phrase signal when the query literally
			// names something in the filename's phrase ("screenshot" ↔
			// "screenshot 20260810 pnff"). Without the gate, phraseSim (a
			// text-text cosine) systematically exceeds the image score and
			// injects ~0.1–0.3 of noise into every row of every query —
			// nonsense queries then rank screenshots at 0.30.
			if (phraseTokenOverlap(query, memories[i].filename) > 0) {
				const phraseSim = cosineSimilarity(qVec, phrase[i]);
				if (phraseSim > score) {
					score += phraseBoost * (phraseSim - score);
				}
			}
		}
		if (query) {
			score += filenameBoost * filenameTokenMatch(query, memories[i].filename);
			// OCR: a query token literally visible in the image's own text is
			// direct evidence — no gate needed beyond the token hit itself
			// (ocrTokenMatch is 0 when nothing overlaps).
			if (ocr) {
				score += ocrBoost * ocrTokenMatch(query, ocr[i]);
			}
		}
		scored.push({ idx: i, filename: memories[i].filename, score });
	}
	scored.sort((a, b) => b.score - a.score);

	const minScore = options.minScore ?? 0;
	if (minScore > 0 && scored.length > 0 && scored[0].score < minScore) {
		return [];
	}

	// Relative relevance cutoff: the noise tail must not fill the grid. Keep
	// candidates at or above a fraction of the top score (and the absolute
	// floor), so a nonsense query returns a handful of weak ties at worst
	// instead of the whole library. Always keep the top result itself.
	if (scored.length > 0) {
		const topScore = scored[0].score;
		const relativeKeep = options.relativeKeep ?? RELATIVE_KEEP;
		const cutoff = Math.max(minScore, topScore * relativeKeep);
		scored = scored.filter((s) => s.score >= cutoff);
	}

	if (options.diversity) {
		const diversified = diversityFilter(
			scored,
			embeddings,
			topK,
			MEMORY_DIVERSITY_THRESHOLD,
		);
		return diversified.map(({ idx, score }) => ({
			filename: memories[idx].filename,
			score,
		}));
	}

	return scored
		.slice(0, topK)
		.map(({ filename, score }) => ({ filename, score }));
}

// Fallback when precomputed embeddings are unavailable (build failure or
// fetch error): substring-match the query tokens against filenames AND the
// image's OCR text. A token that appears in the image's own visible text
// counts exactly like a filename token — the poster whose title says
// "COOGLER" is found by a "coogler" query even though its filename is
// "1500x500.jpg" and CLIP can't read the text.
export function keywordMatchMemories(
	query: string,
	memories: MemoryEntry[],
	topK = 24,
	ocrTexts?: (string | null | undefined)[] | null,
): RankedMemory[] {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return [];
	const ocr = ocrTexts?.length === memories.length ? ocrTexts : null;

	const scored = memories
		.map((memory, index) => {
			const lower = memory.filename.toLowerCase();
			const ocrLower = ocr ? (ocr[index] || "").toLowerCase() : "";
			let filenameHits = 0;
			let ocrHits = 0;
			for (const token of tokens) {
				if (lower.includes(token)) filenameHits++;
				if (ocrLower.includes(token)) ocrHits++;
			}
			const score = filenameHits + ocrHits;
			// Classify which signal dominated: OCR text is the strongest
			// keyword evidence (literal visible content), filename is next.
			const dominant: RankedMemory["dominant"] =
				ocr && ocrHits > 0 && ocrHits >= filenameHits
					? "ocr"
					: filenameHits > 0
						? "filename"
						: "semantic";
			return { filename: memory.filename, score, dominant };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.filename.localeCompare(a.filename));

	return scored.slice(0, Math.max(0, topK));
}

// OCR-only search mode: rank by the fraction of query tokens literally
// visible in the image's extracted text (ocrTokenMatch, 0..1). Unlike
// keywordMatchMemories, the FILENAME is deliberately ignored — the OCR tab
// surfaces exactly the images whose on-screen text matches, so a poster's
// title or a screenshot's caption is the whole story. No embedding model
// involved: works even when the AI engine is down or uncalibrated.
export function ocrMatchMemories(
	query: string,
	memories: MemoryEntry[],
	topK = 24,
	ocrTexts?: (string | null | undefined)[] | null,
): RankedMemory[] {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return [];
	const ocr = ocrTexts?.length === memories.length ? ocrTexts : null;
	if (!ocr) return [];
	const scored = memories
		.map((memory, index) => ({
			filename: memory.filename,
			score: ocrTokenMatch(query, ocr[index]),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
	return scored.slice(0, Math.max(0, topK));
}
