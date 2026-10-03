import { expect, test } from "bun:test";
import { keywordMatchMemories } from "../src/lib/memoryRank";

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
