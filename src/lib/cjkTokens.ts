// Shared CJK tokenization spec for OCR multi-language support.
//
// Spaceless scripts (Han / Hiragana / Katakana / Hangul) cannot use
// whitespace tokenization: "台北車站" is one whitespace token but three
// searchable units. The agreed rule (see MDs/OCR-Languages-Support.md):
// extract CJK runs, expand each run to overlapping bigrams, keep single-char
// runs as-is (a lone 駅/酒 is meaningful, unlike English "a"/"i").
//
// This module is the single source of truth for the RENDERER. main.js and
// indexer/ocr-worker.js carry small plain-JS ports of the same functions
// (they cannot import TS) — keep the three in sync when changing this file:
//   - main.js: rankTokens / ocrWordTokenSet / rankOcrWordMatch CJK branches
//   - indexer/ocr-worker.js: isRealWord / cleanText CJK branches
//   - src/lib/ocrHighlights.ts: CJK substring path

// One or more CJK code points: Han (zh), Hiragana + Katakana (ja), Hangul (ko).
// Japanese mixed-script adjacency (Kanji + Hiragana + Katakana) stays one run
// so bigrams span the script boundary, matching how the text is written.
// The trailing escapes cover marks the Unicode Script property leaves as
// Common but Japanese reads as word characters: ー (U+30FC prolonged sound
// mark — スクリーン would otherwise split mid-word), ・ (U+30FB katakana
// middle dot), 々〻 (iteration marks), ゝゞ (hiragana iteration), ｰ (halfwidth
// prolonged sound mark). Without them a スクリーンショット query loses its
// boundary bigrams (リー/ーン).
export const CJK_EXTRA =
	"\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70";

export const CJK_RUN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]+/gu;

const CJK_CHAR_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70]/u;

/** True when the single character (or any char in the string) is CJK. */
export function isCjkChar(ch: string): boolean {
	if (!ch) return false;
	CJK_CHAR_RE.lastIndex = 0;
	return CJK_CHAR_RE.test(ch);
}

/** True when the text contains at least one CJK code point. */
export function containsCjk(text: string): boolean {
	if (!text) return false;
	CJK_RUN_RE.lastIndex = 0;
	return CJK_RUN_RE.test(text);
}

/** All CJK runs in the text, in order (e.g. ["東京", "駅"] for "東京 駅"). */
export function extractCjkRuns(text: string): string[] {
	if (!text) return [];
	CJK_RUN_RE.lastIndex = 0;
	return text.match(CJK_RUN_RE) ?? [];
}

/**
 * Overlapping bigrams for one CJK run: "台北車站" → ["台北","北車","車站"].
 * A single-char run stays as-is (["駅"]) — lone Han/Hangul/Kana chars are
 * searchable units, not noise.
 */
export function cjkBigramsForRun(run: string): string[] {
	if (!run) return [];
	const chars = [...run];
	if (chars.length <= 1) return chars.length === 1 ? [run] : [];
	const out: string[] = [];
	for (let i = 0; i < chars.length - 1; i++) {
		out.push(chars[i] + chars[i + 1]);
	}
	return out;
}

/** All bigrams for every CJK run in the text, deduplicated, order-stable. */
export function cjkBigramsForText(text: string): string[] {
	const seen = new Set<string>();
	for (const run of extractCjkRuns(text)) {
		for (const bigram of cjkBigramsForRun(run)) {
			if (!seen.has(bigram)) seen.add(bigram);
		}
	}
	return [...seen];
}
