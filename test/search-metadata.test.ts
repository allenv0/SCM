import { expect, test } from "bun:test";
import {
	keywordMatchMemories,
	ocrMatchMemories,
	ocrTokenMatch,
} from "../src/lib/memoryRank";

const memories = [
	{ filename: "ai-terminal.png" },
	{ filename: "screenshot-2026.png" },
	{ filename: "beach-sunset.jpg" },
	{ filename: "research-paper.pdf" },
	{ filename: "ai-powered-tool.png" },
];

test("keyword results carry dominant='filename' when no OCR text", () => {
	const results = keywordMatchMemories("ai", memories, 10);
	expect(results.length).toBeGreaterThan(0);
	for (const r of results) {
		expect(r.dominant).toBe("filename");
	}
});

test("keyword results rank token matches by count", () => {
	const results = keywordMatchMemories("ai terminal", memories, 10);
	// ai-terminal.png matches both tokens (ai + terminal)
	expect(results[0].filename).toBe("ai-terminal.png");
	expect(results[0].score).toBe(2);
});

test("keyword results with OCR text: dominant='ocr' when OCR wins", () => {
	const ocrTexts = [
		"This image shows AI research", // ai-terminal.png
		"", // screenshot-2026.png
		"A beautiful beach sunset", // beach-sunset.jpg
		"", // research-paper.pdf
		"", // ai-powered-tool.png
	];
	const results = keywordMatchMemories("ai", memories, 10, ocrTexts);
	// First result has "AI" in OCR text → dominant should be "ocr"
	const first = results.find((r) => r.filename === "ai-terminal.png");
	expect(first?.dominant).toBe("ocr");
});

test("keyword results with OCR text: dominant='filename' when filename wins", () => {
	const ocrTexts = [
		"", // ai-terminal.png — no OCR
		"", // screenshot-2026.png
		"A beautiful beach sunset", // beach-sunset.jpg
		"", // research-paper.pdf
		"", // ai-powered-tool.png
	];
	const results = keywordMatchMemories("ai", memories, 10, ocrTexts);
	// ai-terminal.png has "ai" in filename but no OCR → dominant="filename"
	const first = results.find((r) => r.filename === "ai-terminal.png");
	expect(first?.dominant).toBe("filename");
});

test("keyword results with no matches return empty", () => {
	const results = keywordMatchMemories("xyz123", memories, 10);
	expect(results).toEqual([]);
});

// ---------------------------------------------------------------------------
// OCR-tab search (ocrMatchMemories) — the dedicated /all/ocr ranking path.
// Its alignment guard is the contract the indexReady re-run effect depends
// on: a missing/misaligned text index MUST return [] (never guess), and an
// aligned index MUST surface rows whose text contains the query.
// ---------------------------------------------------------------------------

test("ocr search returns [] while the text index has not loaded (null)", () => {
	// searchOcr passes ocrTextsRef.current, which every library-updated
	// invalidation wipes to null until the index re-commits.
	expect(ocrMatchMemories("compute", memories, 10, null)).toEqual([]);
	expect(ocrMatchMemories("compute", memories, 10, undefined)).toEqual([]);
});

test("ocr search returns [] on misaligned texts instead of guessing", () => {
	const short = memories
		.slice(0, memories.length - 1)
		.map(() => "GPU compute cluster");
	expect(ocrMatchMemories("compute", memories, 10, short)).toEqual([]);
});

test("ocr search ranks rows whose visible text contains the query", () => {
	const texts = [
		"terminal window",
		"",
		"GPU compute cluster", // beach-sunset.jpg — exact word
		"paper about computer history", // research-paper.pdf — "compute" ⊂ "computer"
		"",
	];
	const results = ocrMatchMemories("compute", memories, 10, texts);
	// includes() semantics: "computer" contains "compute" (suffix r), but
	// "computing" does NOT (the e drops before -ing) — matching is literal
	// substring, not stemming.
	expect(results.length).toBe(2);
	expect(results[0].filename).toBe("beach-sunset.jpg");
	expect(results[0].score).toBe(1);
	expect(ocrTokenMatch("compute", "paper about computing history")).toBe(0);
});

test("ocr search returns [] for a genuinely absent token on an aligned index", () => {
	const texts = memories.map(() => "unrelated caption text");
	expect(ocrMatchMemories("compute", memories, 10, texts)).toEqual([]);
});
