// Email-address detection over OCR text — the membership signal for the
// built-in "Email" tab (photos whose visible text contains an email
// address). Pure and dependency-free so the renderer can classify rows at
// library-refresh time and unit tests can pin the tolerance rules.
//
// Why tolerant: the input is Tesseract's joined word text, not clean prose.
// An address is usually read as one word ("allen@example.com"), but common
// OCR noise glues a comma in place of the dot ("allen@example,com") or
// splits the TLD off ("allen@example. com"). People also DICTATE addresses
// to dodge scrapers ("allen at example dot com", "support [at] example [dot]
// com") — those are matched explicitly below. False-positive-safe by
// construction: a bare "at" with only a LITERAL dot ("interned at
// Acme.AI", "working at Example.com") is ordinary prose and never
// qualifies — a bare "at" counts only alongside a spelled-out dot word
// strictly AFTER it in the SAME candidate ("allen at gmail dot com"),
// while bracketed "[at]" counts with either dot shape. Prose like
// "meet me at the office" (no TLD
// tail) can never qualify either. Deliberately a one-way concept: the flag
// only says "contains an address"; nothing here decides whether a query
// means email.
const LOCAL_SRC = "[A-Za-z0-9][A-Za-z0-9._%+-]*";
const DOMAIN_LABEL_SRC = "[A-Za-z0-9-]+";
// Spelled-out dot (bare "dot"/"dots" as whole words only — never inside
// another word — plus bracket/paren/brace/angle variants), absorbing the
// surrounding spaces so the result is the single token the cleaner needs.
const DOT_WORD_SRC =
	"\\s*(?:\\[dots?\\]|\\(dots?\\)|\\{dots?\\}|<dots?>|\\bdots?\\b)\\s*";
const DOT_LIT_INTER_SRC = "\\.";
const DOT_LIT_FINAL_SRC = "\\. ?";
const DOT_SEP_INTER_SRC = `(?:${DOT_LIT_INTER_SRC}|${DOT_WORD_SRC})`;
const DOT_SEP_FINAL_SRC = `(?:${DOT_LIT_FINAL_SRC}|${DOT_WORD_SRC})`;
const TLD_SRC = "[A-Za-z]{2,}(?![A-Za-z0-9])";
const AT_BARE_SRC = "\\s*\\bat\\b\\s*";
const AT_BRACK_SRC = "\\s*(?:\\[at\\]|\\(at\\)|\\{at\\}|<at>)\\s*";

function chain(src: string): string {
	return `${LOCAL_SRC}${src}${DOMAIN_LABEL_SRC}(?:${DOT_SEP_INTER_SRC}${DOMAIN_LABEL_SRC})*${DOT_SEP_FINAL_SRC}${TLD_SRC}`;
}

// Literal "@" (dot words allowed: "allen@example dot com"). Dictated shapes
// are separate so bare-"at" prose can't sneak in through normalization.
const LITERAL_RE = new RegExp(chain("@"), "gi");
const BARE_AT_RE = new RegExp(chain(AT_BARE_SRC), "gi");
const BRACK_AT_RE = new RegExp(chain(AT_BRACK_SRC), "gi");

// Locality check for bare-"at" candidates: a spelled-out dot word must
// appear strictly AFTER the "at" separator (any-post-at), i.e. in the
// domain/TLD portion — never just anywhere in the span. "allen at example
// dot com" passes; "interned at Acme.AI" (literal dot only) does not — even
// when another dictated address elsewhere in the text contains a dot word.
// A "dot" sitting in or before the local part can never satisfy the gate.
const DOT_WORD_CHECK_RE =
	/(?:\[dots?\]|\(dots?\)|\{dots?\}|<dots?>|\bdots?\b)/i;
// Splitter for the post-"at" gate: ^LOCAL + bare-"at" separator. Group 1 is
// the separator; everything after it is the domain chain under test. LOCAL
// is contiguous alphanumerics so it can never itself contain a whole-word
// "at"/"dot" — the first ^LOCAL + separator match is unambiguous.
const BARE_AT_SPLIT_RE = new RegExp(`^${LOCAL_SRC}(\\s*\\bat\\b\\s*)`, "i");

// Underscore-drop repair (Tesseract splits "celeste_li@example.com" into
// "celeste li@example.com" — the thin "_" is lost as a space). The worker's
// glue pass can't help: the anchor "li@example.com" already validates, so it
// never expands left, and its joiner only inserts ".". Repaired here,
// text-only, on the renderer's next refresh (no re-OCR needed).
//
// Conservative by construction: exactly one space between the left word and
// the match (Tesseract's joiner), left word a bare content fragment,
// anchor local part short (a truncated tail like "li", not "johndoe"), and
// the "_" join must strictly validate. "Contact johndoe@x.com" is left
// alone; "celeste li@x.com" becomes "celeste_li@x.com". Known residual:
// all-lowercase prose before a short local ("contact li@x.com") still
// glues — text-only can't tell it from a dropped "_" (geometry lives in
// the worker, which would need a re-OCR pass to help).
const UNDERSCORE_REPAIR_LOCAL_MAX = 4;
const UNDERSCORE_REPAIR_LEFT_RE = /^[A-Za-z0-9._%+-]+$/;
const UNDERSCORE_REPAIR_LEFT_TAIL_RE = /[A-Za-z0-9._%+-]+$/;
const UNDERSCORE_REPAIR_SEPARATOR_RE =
	/^(?:\[at\]|\(at\)|\{at\}|<at>|\bat\b|\[dots?\]|\(dots?\)|\{dots?\}|<dots?>|\bdots?\b)$/i;
// Conjunctions/prepositions that join prose around addresses ("a@x.com and
// b@y.org") — never local-part fragments. Without this, "and A@X.com"
// repairs to "and_A@X.com" and breaks dedupe.
const UNDERSCORE_REPAIR_STOPWORDS = new Set([
	"and",
	"or",
	"the",
	"to",
	"of",
	"in",
	"on",
	"for",
	"vs",
	"via",
	"cc",
	"bcc",
]);

/** Where a match came from: real "@", bracketed obfuscation, or dictated. */
export type EmailTier = "literal" | "bracketed" | "dictated";

/** One extracted address plus its match evidence (for tooltips/debugging). */
export interface EmailMatch {
	/** Cleaned lowercase address for display/copy. */
	address: string;
	/** Exact substring from the caller's original text (pre-normalization). */
	raw: string;
	tier: EmailTier;
	/** Start offset in the original text (first-seen order). */
	index: number;
}

/** Portion of a bare-"at" hit after the "at" separator ("" when unparseable). */
function postAtPortion(hit: string): string {
	const m = BARE_AT_SPLIT_RE.exec(hit);
	if (!m) return "";
	return hit.slice(m[0].length);
}

// Try to repair an underscore Tesseract dropped as a space: given a literal
// "@" hit and its offset in commaNorm, look exactly one space behind for a
// bare left fragment and rejoin with "_". Returns the repaired hit plus the
// left start and the raw span length (space in source, "_" in hit — same
// length except when the left fragment already ends with "_"), or null.
function tryUnderscoreRepair(
	commaNorm: string,
	hit: string,
	index: number,
): { hit: string; index: number; rawLen: number } | null {
	if (index <= 0 || commaNorm[index - 1] !== " ") return null;
	const at = hit.indexOf("@");
	if (at <= 0) return null;
	const local = hit.slice(0, at);
	// Conservative gate: only a short anchor tail suggests a dropped "_".
	// A full local part ("johndoe" in "Contact johndoe@x.com") is left alone.
	if (local.length > UNDERSCORE_REPAIR_LOCAL_MAX) return null;
	const leftMatch = UNDERSCORE_REPAIR_LEFT_TAIL_RE.exec(
		commaNorm.slice(0, index - 1),
	);
	if (!leftMatch) return null;
	const left = leftMatch[0];
	if (left.length < 2 || !UNDERSCORE_REPAIR_LEFT_RE.test(left)) return null;
	if (UNDERSCORE_REPAIR_SEPARATOR_RE.test(left)) return null;
	// Conservative guards: the left fragment is a local-part piece, never a
	// domain run ("x.com" in "a@x.com b@y.org") and never sentence-case
	// prose ("Contact" in "Contact li@x.com"). Dots live in domains and
	// dotted locals are out of scope for this pass; a leading capital reads
	// as prose, not a truncated tail.
	if (left.includes(".")) return null;
	if (/^[A-Z]/.test(left)) return null;
	if (UNDERSCORE_REPAIR_STOPWORDS.has(left.toLowerCase())) return null;
	const leftStart = index - 1 - left.length;
	// The char before the left fragment must be a boundary, never email
	// content: start, whitespace, or sentence punctuation — not "@" (a prior
	// address's "x.com" tail) nor word chars (mid-word slice).
	if (leftStart > 0 && !/[\s:;()[\]{}<>'"]/.test(commaNorm[leftStart - 1] ?? ""))
		return null;
	const repaired = left.endsWith("_") ? left + hit : `${left}_${hit}`;
	if (!cleanEmailHit(repaired)) return null;
	return { hit: repaired, index: leftStart, rawLen: index + hit.length - leftStart };
}

// Clean one raw regex hit into a displayable address: fold any at/dot
// words, collapse the "gmail. com" split, drop sentence punctuation,
// lowercase (addresses are case-insensitive — one canonical form keeps
// dedupe + copy predictable).
function cleanEmailHit(raw: string): string | null {
	let s = raw
		.replace(/\s*(?:\[at\]|\(at\)|\{at\}|<at>|\bat\b)\s*/gi, "@")
		.replace(/\s*(?:\[dots?\]|\(dots?\)|\{dots?\}|<dots?>|\bdots?\b)\s*/gi, ".")
		.replace(/\s+/g, "")
		.replace(/[.,;:)\]}'"]+$/g, "");
	s = s.replace(/^[([{'"]+/, "");
	// A hit is only as good as its tail: "a@b.1x" must not survive.
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(
			s,
		)
	)
		return null;
	return s.toLowerCase();
}

/**
 * Every email address visible in OCR text, with match evidence.
 * Same tolerance as containsEmailAddress (comma-for-dot, split TLD,
 * dictated at/dot with per-candidate provenance), deduped
 * case-insensitively in first-seen order, capped so a spammy screenshot
 * can't flood a card. Empty for null/blank input.
 *
 * `raw` is sliced from the caller's original text (comma normalization is
 * 1:1, so indices transfer) — what the tile tooltip shows as "found as".
 */
export function extractEmailMatches(
	text: string | null | undefined,
	limit = 5,
): EmailMatch[] {
	if (!text || !text.trim()) return [];
	// Comma-for-dot OCR noise ("allen@example,com"). Same length, so match
	// indices stay comparable across the three passes below and transfer
	// back onto the original text for `raw`.
	const commaNorm = text.replace(/,/g, ".");
	const candidates: { hit: string; index: number; tier: EmailTier; rawLen?: number }[] = [];
	for (const m of commaNorm.matchAll(LITERAL_RE)) {
		const hit = m[0];
		const index = m.index ?? 0;
		const repaired = tryUnderscoreRepair(commaNorm, hit, index);
		if (repaired) {
			candidates.push({ hit: repaired.hit, index: repaired.index, tier: "literal", rawLen: repaired.rawLen });
		} else {
			candidates.push({ hit, index, tier: "literal" });
		}
	}
	for (const m of commaNorm.matchAll(BRACK_AT_RE)) {
		candidates.push({ hit: m[0], index: m.index ?? 0, tier: "bracketed" });
	}
	for (const m of commaNorm.matchAll(BARE_AT_RE)) {
		// Bare "at" needs a dot word strictly AFTER the separator — not just
		// anywhere in the span — or prose like "interned at Acme.AI"
		// qualifies. A "dot" in/before the local part never counts.
		if (!DOT_WORD_CHECK_RE.test(postAtPortion(m[0]))) continue;
		candidates.push({ hit: m[0], index: m.index ?? 0, tier: "dictated" });
	}
	candidates.sort((a, b) => a.index - b.index);
	const out: EmailMatch[] = [];
	const seen = new Set<string>();
	for (const { hit, index, tier, rawLen } of candidates) {
		const cleaned = cleanEmailHit(hit);
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push({
			address: cleaned,
			raw: text.slice(index, index + (rawLen ?? hit.length)),
			tier,
			index,
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Every email address visible in OCR text, cleaned for display.
 * Thin map over extractEmailMatches — same order, dedupe, and cap, so the
 * two can never disagree about WHAT counts.
 */
export function extractEmailAddresses(
	text: string | null | undefined,
	limit = 5,
): string[] {
	return extractEmailMatches(text, limit).map((m) => m.address);
}

export function containsEmailAddress(text: string | null | undefined): boolean {
	return extractEmailAddresses(text, 1).length > 0;
}

/**
 * Tooltip copy for one extracted address: what the detector actually saw.
 * Pure so tile, expanded sheet, and lightbox rows stay identical — and so
 * the next phantom is debuggable from the UI instead of the index JSON.
 */
export function formatEmailEvidence(
	match: Pick<EmailMatch, "address" | "raw" | "tier">,
): string {
	const { address, raw, tier } = match;
	if (tier === "dictated") return `Found as "${raw}" (spelled-out at/dot)`;
	if (tier === "bracketed") return `Found as "${raw}" (obfuscated at/dot)`;
	if (raw.toLowerCase() !== address.toLowerCase()) return `Found as "${raw}"`;
	return "Found in photo text";
}
