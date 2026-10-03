"use strict";

// Ask-mode evidence assembly (MDs/Ask-Mode-Plan.md) — PURE, plain-node
// testable, and deliberately WORKER-FREE: nothing here touches the CLIP
// indexer pool, embeds a query, or sets any background-pump pending flag.
// Retrieval runs on the text SCM already extracted (OCR rows, transcript
// utterances, filenames), so Ask works with the model down and mid-migration.
//
// The LLM never scores or fabricates results — it only answers from the
// numbered evidence this module assembles (the MCP golden rule: an agent and
// a human see the same answer).

const {
	exactDialogueSearch,
} = require("../../indexer/transcript-store-utils.js");

// Evidence caps. Total ≈ 12 short excerpts keeps the prompt comfortably
// inside the 8192-token ctx even when the rows are CJK (~1-2 tokens/char).
const ASK_CAPS = {
	dialogue: 6,
	ocr: 6,
	keyword: 4,
	total: 12,
	snippetChars: 300,
};

// Wide tier for broad questions (multi-file ceiling): same 300-char rows,
// up to 16 total. Keyword rises 4→6 (a filename row is ~10 tokens — the
// cheapest coverage). 16 × ~350 chars ≈ 5.6K chars ≈ 1.5–2.5K tokens worst
// case (CJK-dense) — still ~half the 8192 window with 1024 reserved for the
// answer, and no KV-cache change. Past ~16 a 1.7B model starts blending
// contradictions across rows, so the wide tier stops here by design.
const ASK_CAPS_WIDE = {
	dialogue: 8,
	ocr: 8,
	keyword: 6,
	total: 16,
	snippetChars: 300,
};

// CJK run matcher — keep in sync with src/lib/cjkTokens.ts and the
// rankTokens copy in main.js (same rune class).
const CJK_RUN_SOURCE =
	"[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30FC\\u30FB\\u3005\\u303B\\u3031\\u3032\\u3033\\u3034\\u3035\\uFF70]";

// Query → deduplicated token set: Latin words (len ≥ 2) plus CJK run
// bigrams (single char stays). The Latin side splits on non-alphanumerics —
// the same normalization ocrTokenSet (and ocrWordTokenSet in main.js) apply
// to documents — so "Gurley?" meets "gurley" and "follow-up" meets
// "follow"+"up". DELIBERATE Ask-side divergence: rankTokens in main.js still
// whitespace-splits for grid search; that stays untouched (Ask-side-only
// fix). CJK handling still mirrors the shared rune class.
function askTokenSet(text) {
	const lower = (text || "").toLowerCase();
	const seen = new Set();
	const cjkRunRe = new RegExp(CJK_RUN_SOURCE + "+", "gu");
	const latinPart = lower.replace(cjkRunRe, " ");
	for (const t of latinPart.split(/[^\p{L}\p{N}]+/u)) {
		if (t.length >= 2) seen.add(t);
	}
	const runs = lower.match(cjkRunRe) || [];
	for (const run of runs) {
		const chars = [...run];
		if (chars.length <= 1) {
			if (chars.length === 1) seen.add(run);
			continue;
		}
		for (let i = 0; i < chars.length - 1; i++) {
			seen.add(chars[i] + chars[i + 1]);
		}
	}
	return seen;
}

// Per-row token set for one OCR text: Unicode word split + CJK bigrams
// (the same normalization ocrWordTokenSet applies in main.js).
function ocrTokenSet(text) {
	const lower = String(text || "").toLowerCase();
	const set = new Set();
	for (const t of lower.split(/[^\p{L}\p{N}]+/u)) {
		if (t) set.add(t);
	}
	const runs = lower.match(new RegExp(CJK_RUN_SOURCE + "+", "gu")) || [];
	for (const run of runs) {
		const chars = [...run];
		if (chars.length <= 1) {
			if (chars.length === 1) set.add(run);
			continue;
		}
		for (let i = 0; i < chars.length - 1; i++) {
			set.add(chars[i] + chars[i + 1]);
		}
	}
	return set;
}

function truncate(text, max) {
	const s = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Callers either hold a precomputed token set (buildAskEvidence) or just a
// raw query string (tests, ad-hoc callers) — accept both.
function resolveQueryTokens({ query, queryTokens }) {
	if (queryTokens instanceof Set) return queryTokens;
	if (Array.isArray(queryTokens)) return new Set(queryTokens);
	return askTokenSet(query);
}

// OCR evidence: fraction of query tokens present in each scoped photo's OCR
// text. Zero-hit rows are dropped — thin evidence must reach the "say so"
// prompt path, not a confident answer.
function ocrEvidence({ query, queryTokens, photoRows, cap, snippetChars }) {
	const q = resolveQueryTokens({ query, queryTokens });
	if (q.size === 0) return [];
	const rows = [];
	for (const row of photoRows || []) {
		if (!row || typeof row.filename !== "string") continue;
		const text = typeof row.ocr === "string" ? row.ocr : "";
		if (!text.trim()) continue;
		const set = ocrTokenSet(text);
		if (set.size === 0) continue;
		let hits = 0;
		for (const t of q) if (set.has(t)) hits++;
		if (hits === 0) continue;
		rows.push({
			kind: "ocr",
			filename: row.filename,
			score: hits / q.size,
			text: truncate(text, snippetChars),
		});
	}
	rows.sort((a, b) => b.score - a.score || (a.filename < b.filename ? -1 : 1));
	return rows.slice(0, cap);
}

// Filename-keyword evidence: the same token containment rankFilenameMatch
// uses — a query about "Bill Gurley" should surface the screenshot literally
// named that, even when its OCR text is thin.
function keywordEvidence({ query, queryTokens, filenames, cap }) {
	const q = resolveQueryTokens({ query, queryTokens });
	if (q.size === 0) return [];
	const rows = [];
	for (const filename of filenames || []) {
		if (typeof filename !== "string") continue;
		const lower = filename.toLowerCase();
		let hits = 0;
		for (const t of q) if (lower.includes(t)) hits++;
		if (hits === 0) continue;
		rows.push({ kind: "keyword", filename, score: hits / q.size });
	}
	rows.sort((a, b) => b.score - a.score || (a.filename < b.filename ? -1 : 1));
	return rows.slice(0, cap);
}

// Transcript docs for the scoped videos: utterance lines when the sidecar
// has them (precise seek), else 30s chunk rows — the exact source order
// rankTranscriptMoments uses.
function dialogueDocsFor({ videoNames, transcripts }) {
	const names =
		videoNames instanceof Set ? videoNames : new Set(videoNames || []);
	const docs = [];
	if (!transcripts) return docs;
	const utt =
		transcripts.utterances instanceof Map ? transcripts.utterances : null;
	const chunks = transcripts.videos instanceof Map ? transcripts.videos : null;
	if (
		utt &&
		[...utt.keys()].some((k) => names.has(k) && (utt.get(k) || []).length > 0)
	) {
		for (const [filename, lines] of utt) {
			if (!names.has(filename)) continue;
			for (const u of lines || []) {
				if (!u || !Number.isFinite(u.t0) || !Number.isFinite(u.t1)) continue;
				if (typeof u.text !== "string" || !u.text.trim()) continue;
				docs.push({ filename, t0: u.t0, t1: u.t1, text: u.text });
			}
		}
	} else if (chunks) {
		for (const [filename, rows] of chunks) {
			if (!names.has(filename)) continue;
			for (const c of rows || []) {
				if (!c || !Number.isFinite(c.t0) || !Number.isFinite(c.t1)) continue;
				if (typeof c.text !== "string" || !c.text.trim()) continue;
				docs.push({ filename, t0: c.t0, t1: c.t1, text: c.text });
			}
		}
	}
	return docs;
}

// Dialogue evidence via the same literal retrieval the Dialogue tab uses —
// no vectors, no thresholds, no model. Moments already carry t/dur/poster/
// snippet/tier for the grid's seek-on-open.
function dialogueEvidence({ query, videoNames, transcripts, segVideos, cap }) {
	const docs = dialogueDocsFor({ videoNames, transcripts });
	if (docs.length === 0) return [];
	const moments = exactDialogueSearch({
		query,
		docs,
		segVideos: segVideos instanceof Map ? segVideos : null,
		topK: cap,
		perVideo: 3,
	});
	return moments.map((m) => ({
		kind: "dialogue",
		filename: m.filename,
		score: m.score,
		t: m.t,
		dur: m.dur,
		poster: m.poster,
		tier: m.tier,
		tierLabel: m.tierLabel,
		snippet: truncate(m.snippet || "", ASK_CAPS.snippetChars),
		text: truncate(m.snippet || "", ASK_CAPS.snippetChars),
	}));
}

// Validate the renderer-supplied scope list against the live library (the
// resolveRevealTarget indexOf-guard pattern): an arbitrary string can never
// pull evidence for a file outside the library, and unknown names are
// dropped rather than trusted.
function validateScopedFilenames(names, libraryFilenames) {
	const lib = new Set(libraryFilenames || []);
	const out = new Set();
	for (const name of names || []) {
		if (typeof name === "string" && lib.has(name)) out.add(name);
	}
	return out;
}

// Split validated scoped names into photo rows / video names for the
// evidence passes (the caller supplies the video predicate).
function partitionScoped(scoped, isVideo) {
	const photoRows = [];
	const videoNames = [];
	for (const filename of scoped) {
		if (isVideo(filename)) videoNames.push(filename);
		else photoRows.push({ filename, ocr: null });
	}
	return { photoRows, videoNames };
}

// Total-cap trim in display order, keyword trimmed first (a filename-only
// row proves the least). Returns the trimmed list plus how many keyword
// rows survived, so the wide tier can resume overflow after them.
function trimTotal(dialogue, ocr, keyword, total) {
	const all = [...dialogue, ...ocr, ...keyword];
	if (all.length <= total) return { all, keywordKept: keyword.length };
	const keepKeyword = Math.max(0, total - dialogue.length - ocr.length);
	const kept = keyword.slice(0, keepKeyword);
	return { all: [...dialogue, ...ocr, ...kept], keywordKept: kept.length };
}

// Full evidence assembly. Returns { ocr, dialogue, keyword, all } — `all` is
// the display/prompt order (dialogue first: "what did X say" questions lead
// with speech; then OCR; then filename hits) with every row citation-ready.
//
// Adaptive tiers: the default call (main.js passes no caps) collects at the
// wide tier, then serves the standard slice whenever everything fits —
// clamping a prefix slice reproduces today's output byte-identically, so
// narrow questions are provably unchanged and their citations never
// renumber. Only genuinely broad questions (wide-collected rows > 12) get
// rows 13–16, appended after the standard 12 in display order. Explicit caps
// (tests, ad-hoc callers) take the legacy path verbatim.
function buildAskEvidence({
	query,
	photoRows,
	videoNames,
	transcripts,
	segVideos,
	caps = ASK_CAPS,
}) {
	const trimmed = (query || "").trim();
	if (!trimmed)
		return { ocr: [], dialogue: [], keyword: [], all: [], tier: "standard" };
	const queryTokens = askTokenSet(trimmed);
	const adaptive = caps === ASK_CAPS;
	const collect = adaptive ? ASK_CAPS_WIDE : caps;
	const dialogueW = dialogueEvidence({
		query: trimmed,
		videoNames,
		transcripts,
		segVideos,
		cap: collect.dialogue,
	});
	const ocrW = ocrEvidence({
		queryTokens,
		photoRows,
		cap: collect.ocr,
		snippetChars: collect.snippetChars,
	});
	const keywordW = keywordEvidence({
		queryTokens,
		filenames: [
			...(videoNames || []),
			...(photoRows || []).map((r) => r.filename),
		],
		cap: collect.keyword,
	});
	if (!adaptive) {
		const { all } = trimTotal(dialogueW, ocrW, keywordW, caps.total);
		return {
			ocr: ocrW,
			dialogue: dialogueW,
			keyword: keywordW,
			all,
			tier: "custom",
		};
	}
	if (dialogueW.length + ocrW.length + keywordW.length <= ASK_CAPS.total) {
		// Standard tier — identical to the pre-tier output.
		const dialogue = dialogueW.slice(0, ASK_CAPS.dialogue);
		const ocr = ocrW.slice(0, ASK_CAPS.ocr);
		const keyword = keywordW.slice(0, ASK_CAPS.keyword);
		const { all } = trimTotal(dialogue, ocr, keyword, ASK_CAPS.total);
		return { ocr, dialogue, keyword, all, tier: "standard" };
	}
	// Wide tier: the standard 12 first (citation stability), then per-kind
	// overflow in display order up to 16 total.
	const dialogueS = dialogueW.slice(0, ASK_CAPS.dialogue);
	const ocrS = ocrW.slice(0, ASK_CAPS.ocr);
	const keywordS = keywordW.slice(0, ASK_CAPS.keyword);
	const base = trimTotal(dialogueS, ocrS, keywordS, ASK_CAPS.total);
	const extras = [
		...dialogueW.slice(ASK_CAPS.dialogue),
		...ocrW.slice(ASK_CAPS.ocr),
		...keywordW.slice(base.keywordKept),
	].slice(0, ASK_CAPS_WIDE.total - base.all.length);
	return {
		ocr: ocrW,
		dialogue: dialogueW,
		keyword: keywordW,
		all: [...base.all, ...extras],
		tier: "wide",
	};
}

module.exports = {
	ASK_CAPS,
	ASK_CAPS_WIDE,
	askTokenSet,
	ocrTokenSet,
	ocrEvidence,
	keywordEvidence,
	dialogueDocsFor,
	dialogueEvidence,
	validateScopedFilenames,
	partitionScoped,
	buildAskEvidence,
	truncate,
};
