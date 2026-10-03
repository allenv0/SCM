"use strict";

// Pure hybrid search ranking (Phase 0.4): O(N × dim) cosine + keyword/OCR
// boosts, extracted from main.js so the same scorer runs in-process (tests,
// fallback) and inside a dedicated utilityProcess (production IPC path).
// No electron dependency — plain-node tested.
//
// Keep constants in sync with src/lib/memoryRank.ts.

function cosineSim(a, b) {
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Cosine with the query norm and a precomputed row norm (C-03 fast path).
function cosineSimPre(qVec, vec, qNorm, vecNorm) {
	if (qNorm === 0 || vecNorm === 0) return 0;
	let dot = 0;
	for (let k = 0; k < qVec.length; k++) dot += qVec[k] * vec[k];
	return dot / (qNorm * vecNorm);
}

const RANK_NOISE_TOKENS = new Set([
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

function rankTokens(text) {
	// Keep in sync with src/lib/memoryRank.ts queryTokens() + src/lib/cjkTokens.ts:
	// Latin side splits on whitespace (len>=2); CJK side expands Han/Hiragana/
	// Katakana/Hangul runs to overlapping bigrams (single char stays as-is).
	const lower = (text || "").toLowerCase();
	const seen = new Set();
	const latinPart = lower.replace(
		/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]+/gu,
		" ",
	);
	for (const t of latinPart.split(/\s+/)) {
		if (t.length >= 2) seen.add(t);
	}
	const runs = lower.match(
		/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]+/gu,
	);
	for (const run of runs || []) {
		const chars = [...run];
		if (chars.length <= 1) {
			if (chars.length === 1) seen.add(run);
			continue;
		}
		for (let i = 0; i < chars.length - 1; i++) {
			seen.add(chars[i] + chars[i + 1]);
		}
	}
	return [...seen];
}

function rankFilenameMatch(queryTokens, filename) {
	const lower = filename.toLowerCase();
	let hits = 0;
	for (const t of queryTokens) {
		if (lower.includes(t)) hits++;
	}
	return hits / (queryTokens.length || 1);
}

// Per-row memo of the WORD tokens of each OCR word (the same normalization
// the renderer's highlight matcher applies: Unicode word split + CJK
// bigrams). Keyed on the row's array object, which is stable for the life of
// the in-memory library — a splice replaces the array, so a removed row's
// cache entry dies with it.
const ocrWordTokenCache = new WeakMap();
function ocrWordTokenSet(ocrWords) {
	let set = ocrWordTokenCache.get(ocrWords);
	if (!set) {
		set = new Set();
		for (const w of ocrWords || []) {
			if (!w || !w.text) continue;
			const lower = String(w.text).toLowerCase();
			for (const t of lower.split(/[^\p{L}\p{N}]+/u)) {
				if (t) set.add(t);
			}
			// CJK bigrams for the same word/line (tesseract returns CJK as
			// whole lines — without this a 車站 query never hits 台北車站).
			const runs = lower.match(
				/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]+/gu,
			);
			for (const run of runs || []) {
				const chars = [...run];
				if (chars.length <= 1) {
					if (chars.length === 1) set.add(run);
					continue;
				}
				for (let i = 0; i < chars.length - 1; i++) {
					set.add(chars[i] + chars[i + 1]);
				}
			}
		}
		ocrWordTokenCache.set(ocrWords, set);
	}
	return set;
}

// Fraction of query tokens that appear as an EXACT word in the photo's OCR
// text — punctuation-stripped on both sides, so "ai," matches "AI" and
// "ai-powered" matches both "AI" and "powered", but "ai" still never matches
// the "ai" inside "painting". CJK tokens (bigrams / single Han chars) match
// by containment instead: spaceless scripts have no word boundaries, so a
// 車站 query must hit the 台北車站 line.
function rankOcrWordMatch(queryTokens, ocrWords) {
	if (!ocrWords || ocrWords.length === 0 || queryTokens.length === 0) return 0;
	const set = ocrWordTokenSet(ocrWords);
	if (set.size === 0) return 0;
	const CJK_TOKEN_RE =
		/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]/u;
	let hits = 0;
	for (const raw of queryTokens) {
		CJK_TOKEN_RE.lastIndex = 0;
		if (CJK_TOKEN_RE.test(raw)) {
			if (set.has(raw.toLowerCase())) {
				hits++;
			}
			continue;
		}
		for (const t of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
			if (t && set.has(t)) {
				hits++;
				break;
			}
		}
	}
	return hits / (queryTokens.length || 1);
}

function rankPhraseOverlap(queryTokens, filename) {
	const base = filename.replace(/\.[^.]+$/, "");
	const phrase = base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((t) => (t === "scr" ? "screenshot" : t))
		.filter((t) => !RANK_NOISE_TOKENS.has(t))
		.slice(0, 8);
	if (phrase.length === 0 || queryTokens.length === 0) return 0;
	let hits = 0;
	for (const t of queryTokens) {
		if (phrase.includes(t)) hits++;
	}
	return hits / queryTokens.length;
}

// Hybrid-ranking constants — must match src/lib/memoryRank.ts.
const RANK_FILENAME_BOOST = 0.2;
const RANK_PHRASE_BOOST = 0.6;
// Word-EXACT OCR hits, applied ONLY after the natural cutoff (ordering
// boost, never a scoring boost): the query literally written on the photo
// is the evidence the highlight boxes draw, so those photos lead the grid —
// but because the boost lands after the floor/cutoff math, it can never
// inflate the band and squeeze purely-visual matches out of the results
// (the regression that made Files mode read as OCR-only).
const RANK_OCR_WORD_BOOST = 0.5;
const RANK_MIN_SCORE = 0.04;
const RANK_RELATIVE_KEEP = 0.6;
const RANK_DIVERSITY_THRESHOLD = 0.92;

// Score an already-loaded library against an embedded query vector.
// Pure: no fs, no electron, no model. `thresholds` is thresholdsFor(modelId)
// (or {}); `norms` is libraryNorms(). Returns JSON-safe result rows.
function scoreLibrary(l, trimmed, qVec, topK, thresholds, norms) {
	if (!l || !l.filenames.length || !l.embeddings.length) return [];
	if (l.embeddings.length !== l.filenames.length) return [];
	if (!qVec || qVec.length !== l.dim) return [];
	if (!Number.isFinite(topK) || topK < 1) return [];
	const trimmedQuery = (trimmed || "").trim();
	if (!trimmedQuery) return [];

	const minScore = thresholds?.minSemanticScore ?? RANK_MIN_SCORE;
	const relativeKeep = thresholds?.relativeKeep ?? RANK_RELATIVE_KEEP;
	const qt = rankTokens(trimmedQuery);

	// Query norm (once per query) + precomputed per-row norms: the inner
	// loop does cosine as dot/(qNorm·rowNorm) instead of recomputing two
	// norms per row (C-03).
	let qNormSq = 0;
	for (let k = 0; k < qVec.length; k++) qNormSq += qVec[k] * qVec[k];
	const qNorm = qNormSq > 0 ? Math.sqrt(qNormSq) : 0;

	let scored = [];
	for (let i = 0; i < l.filenames.length; i++) {
		const baseCosine = cosineSimPre(qVec, l.embeddings[i], qNorm, norms[i]);
		let score = baseCosine;
		// Phrase boost (gated on literal token overlap)
		let phraseContrib = 0;
		if (l.phrases.length === l.filenames.length && qt.length > 0) {
			if (rankPhraseOverlap(qt, l.filenames[i]) > 0) {
				const ps = cosineSim(qVec, l.phrases[i]);
				if (ps > score) phraseContrib = RANK_PHRASE_BOOST * (ps - score);
			}
			score += phraseContrib;
		}
		// Filename token match. Deliberately NO OCR signal here: Files mode
		// is semantic + filename evidence only — the OCR tab owns text
		// matching, and an OCR-driven score inflates the relative cutoff
		// until purely-visual matches are filtered out of the grid.
		let filenameContrib = 0;
		if (qt.length > 0) {
			filenameContrib =
				RANK_FILENAME_BOOST * rankFilenameMatch(qt, l.filenames[i]);
		}
		score += filenameContrib;
		scored.push({
			idx: i,
			filename: l.filenames[i],
			score,
			// Capture components for the dominant-signal classification
			// and the hover breakdown tooltip. These are lightweight
			// (one float each) and die with the scored array.
			_baseCosine: baseCosine,
			_phraseContrib: phraseContrib,
			_filenameContrib: filenameContrib,
		});
	}
	scored.sort((a, b) => b.score - a.score);

	// Absolute floor: top match below minScore → nothing relevant
	if (scored.length > 0 && scored[0].score < minScore) return [];

	// Rows with an exact OCR word hit, resolved once for the cutoff below
	// and reused by the ordering boost (same alignment guard as the boost).
	const ocrRows =
		qt.length > 0 && l.ocrWords && l.ocrWords.length === l.filenames.length
			? l.ocrWords
			: null;

	// Adaptive cutoff: keep the top 60% of scored results. The old 5th-best
	// reference was fragile with outlier distributions — one strong match
	// defined the band and erased hundreds of honest tail results. The
	// percentile approach preserves the full distribution shape: a tight
	// cluster stays dense, a spread-out tail stays visible.
	if (scored.length > 0) {
		const cutoffRank = Math.floor(scored.length * (1 - relativeKeep));
		const cutoffScore = scored[Math.min(cutoffRank, scored.length - 1)].score;
		const cutoff = Math.max(minScore, cutoffScore);
		// Exact OCR word matches survive the percentile cutoff: literal
		// visible text is high-precision evidence, not noise-tail filler,
		// and the ordering-only boost below can only lift rows that are
		// still present. The absolute floor still applies.
		scored = scored.filter(
			(s) =>
				s.score >= cutoff ||
				(ocrRows &&
					s.score >= minScore &&
					rankOcrWordMatch(qt, ocrRows[s.idx]) > 0),
		);
	}

	// Ordering-only word boost, AFTER the floor/cutoff: a query token that
	// appears as an exact word in a surviving row's OCR text lifts that row
	// to the front of the grid (the highlighted "it's written on the photo"
	// results the user is looking for), while the cutoff — computed on
	// natural scores — has already guaranteed the full semantic result set
	// below. Applied here, the boost reorders but can never shrink.
	if (ocrRows) {
		for (const s of scored) {
			s.score += RANK_OCR_WORD_BOOST * rankOcrWordMatch(qt, ocrRows[s.idx]);
		}
		scored.sort((a, b) => b.score - a.score);
	}

	// Classify the dominant signal for each surviving result. The dominant
	// signal is the largest contributor to the final score — this drives
	// the one-line "why it matched" badge on each card.
	for (const s of scored) {
		const ocrContrib =
			qt.length > 0
				? RANK_OCR_WORD_BOOST * rankOcrWordMatch(qt, l.ocrWords[s.idx])
				: 0;
		const parts = [
			["semantic", s._baseCosine],
			["phrase", s._phraseContrib],
			["filename", s._filenameContrib],
			["ocr", ocrContrib],
		]
			.filter(([, v]) => v > 0)
			.sort((a, b) => b[1] - a[1]);
		// If the top boost is substantial relative to the base, it
		// dominated. Otherwise semantic is the honest answer.
		if (parts.length > 0 && parts[0][1] >= s._baseCosine * 0.5) {
			s.dominant = parts[0][0];
		} else {
			s.dominant = "semantic";
		}
		s.breakdown = {
			semantic: s._baseCosine,
			phrase: s._phraseContrib,
			filename: s._filenameContrib,
			ocr: ocrContrib,
		};
	}

	// Diversity filter: drop near-duplicate photos so one scene can't
	// dominate the topK. Cap candidates at 500 so the O(cands·selected·dim)
	// scan can't blow up on a large library — anything past the top 500 is
	// already below the relative cutoff and irrelevant (C-03).
	if (scored.length > topK) {
		const selected = [];
		const candidates = scored.length > 500 ? scored.slice(0, 500) : scored;
		for (const c of candidates) {
			if (selected.length >= topK) break;
			let tooSimilar = false;
			for (const s of selected) {
				if (
					cosineSim(l.embeddings[c.idx], l.embeddings[s.idx]) >
					RANK_DIVERSITY_THRESHOLD
				) {
					tooSimilar = true;
					break;
				}
			}
			if (!tooSimilar) selected.push(c);
		}
		if (selected.length >= 3) scored = selected;
	}

	return scored
		.slice(0, topK)
		.map(({ filename, score, dominant, breakdown }) => ({
			filename,
			score,
			dominant,
			breakdown,
		}));
}

module.exports = {
	cosineSim,
	cosineSimPre,
	rankTokens,
	rankFilenameMatch,
	rankOcrWordMatch,
	rankPhraseOverlap,
	RANK_MIN_SCORE,
	RANK_RELATIVE_KEEP,
	RANK_DIVERSITY_THRESHOLD,
	RANK_FILENAME_BOOST,
	RANK_PHRASE_BOOST,
	RANK_OCR_WORD_BOOST,
	scoreLibrary,
};
