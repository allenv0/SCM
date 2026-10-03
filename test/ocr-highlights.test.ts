import { expect, test } from "bun:test";
import { matchingOcrWordBoxes } from "../src/lib/ocrHighlights";

const words = [
	{ text: "AI", x: 0.1, y: 0.2, w: 0.08, h: 0.06 },
	{ text: "AI-powered", x: 0.2, y: 0.2, w: 0.24, h: 0.06 },
	{ text: "painting", x: 0.1, y: 0.4, w: 0.2, h: 0.06 },
	{ text: "Research", x: 0.1, y: 0.6, w: 0.2, h: 0.06 },
];

test("OCR highlights match complete query words, not incidental substrings", () => {
	expect(matchingOcrWordBoxes("AI", words).map((word) => word.text)).toEqual([
		"AI",
		"AI-powered",
	]);
});

test("OCR highlights include every visible word from a multi-word query", () => {
	expect(
		matchingOcrWordBoxes("ai research", words).map((word) => word.text),
	).toEqual(["AI", "AI-powered", "Research"]);
});

test("OCR highlights tolerate punctuation and hyphens in the query", () => {
	expect(matchingOcrWordBoxes("ai,", words).map((word) => word.text)).toEqual([
		"AI",
		"AI-powered",
	]);
	expect(
		matchingOcrWordBoxes("ai-powered", words).map((word) => word.text),
	).toEqual(["AI", "AI-powered"]);
});

test("substring mode explains the OCR tab's substring ranking", () => {
	// The OCR tab ranks "ai" against any text containing it, so its boxes
	// must light the containing words ("painting") — otherwise ranked
	// results render with no annotation at all.
	expect(
		matchingOcrWordBoxes("ai", words, { substring: true }).map((w) => w.text),
	).toEqual(["AI", "AI-powered", "painting"]);
	// Files mode keeps whole-word semantics: no box for the "ai" inside
	// "painting".
	expect(matchingOcrWordBoxes("ai", words).map((w) => w.text)).toEqual([
		"AI",
		"AI-powered",
	]);
});
