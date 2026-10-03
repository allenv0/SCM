import { queryHasCjk, queryTokens } from "@/lib/memoryRank";
import { cjkBigramsForText, containsCjk } from "@/lib/cjkTokens";

// A normalized rectangle from Tesseract's word-level OCR output. Keeping the
// coordinates relative to the recognized image lets the same geometry line up
// with both the grid thumbnail and the full-size source, regardless of their
// rendered size.
export interface OcrWordBox {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

function wordTokens(text: string): string[] {
	const out = new Set<string>();
	// Unicode-aware split: Cyrillic, Greek, Arabic, Hebrew and Devanagari
	// words survive exactly like Latin ones (old [^a-z0-9] erased them).
	for (const token of text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0)) {
		out.add(token);
	}
	// CJK side: index the word's Han/Hiragana/Katakana/Hangul bigrams so a
	// bigram query ("車站") matches the word/line that contains it ("台北車站").
	// Tesseract returns CJK as whole lines, so this is what makes per-line
	// boxes light for CJK queries.
	for (const bigram of cjkBigramsForText(text.toLowerCase())) {
		out.add(bigram);
	}
	return [...out];
}

export interface OcrMatchOptions {
	// Substring containment instead of whole-word equality. The OCR tab's
	// ranking (ocrTokenMatch) is substring-based — "ai" matches the text
	// inside "email" — so its boxes must explain THAT evidence: ranking a
	// photo for a substring while drawing no box reads as "highlight
	// broken". Files mode keeps whole-word matching: there the box is a
	// literal "the word is written on this photo" annotation over semantic
	// results, and lighting "painting" for an "ai" query would be noise.
	substring?: boolean;
}

// Return the physical OCR words that correspond to a search query. Word-based
// by default: a search for "AI" should light up "AI" (or "AI-powered"), not
// the "ai" inside "painting". queryTokens splits on whitespace only, so a
// typed "ai," or "AI-powered" arrives as one punctuated token — re-split on
// non-alphanumerics (the same rule wordTokens applies on the OCR side) so
// punctuation and hyphens in the QUERY don't blind the matcher to the same
// shapes in the WORDS. CJK queries always use substring matching: CJK text is
// spaceless and tesseract returns whole lines, so a bigram query ("車站")
// must light the line ("台北車站") that contains it.
export function matchingOcrWordBoxes(
	query: string,
	words: OcrWordBox[] | null | undefined,
	options: OcrMatchOptions = {},
): OcrWordBox[] {
	const rawTokens = queryTokens(query);
	const tokens = [
		...new Set(
			rawTokens.flatMap((token) => {
				// CJK bigrams pass through untouched (they are already units).
				if (containsCjk(token)) return [token.toLowerCase()];
				return token
					.toLowerCase()
					.split(/[^\p{L}\p{N}]+/u)
					.filter(Boolean);
			}),
		),
	];
	if (tokens.length === 0 || !words?.length) return [];
	// CJK queries behave like the OCR tab's substring mode even in Files mode:
	// exact-word semantics make no sense for spaceless scripts.
	const cjkQuery = queryHasCjk(query);

	return words.filter((word) => {
		if (options.substring || cjkQuery) {
			const lower = word.text.toLowerCase();
			return tokens.some((token) => lower.includes(token));
		}
		const tokensInWord = wordTokens(word.text);
		return tokens.some((token) => tokensInWord.includes(token));
	});
}
