import { expect, test } from "bun:test";
import {
	cjkBigramsForRun,
	cjkBigramsForText,
	containsCjk,
	extractCjkRuns,
} from "../src/lib/cjkTokens";
import { ocrTokenMatch, queryTokens } from "../src/lib/memoryRank";
import { matchingOcrWordBoxes } from "../src/lib/ocrHighlights";
import {
	DEFAULT_OCR_LANGS,
	OCR_LANG_BLURBS,
	OCR_LANG_GROUPS,
	OCR_LANG_IDS,
	OCR_LANG_LABELS,
	parseOcrLangs,
	resolveOcrLangString,
} from "../src/lib/ocrLangs";
import {
	DEFAULT_OCR_LANGS as JS_DEFAULT,
	OCR_LANG_BY_ID as JS_BY_ID,
	OCR_LANG_GROUPS as JS_GROUPS,
	OCR_LANG_IDS as JS_IDS,
} from "../indexer/ocr-lang-list.js";

test("CJK run extraction covers Han, Hiragana, Katakana, Hangul", () => {
	expect(extractCjkRuns("Photo 東京駅 2024")).toEqual(["東京駅"]);
	expect(extractCjkRuns("スクリーンショット")).toEqual(["スクリーンショット"]);
	expect(extractCjkRuns("스크린샷")).toEqual(["스크린샷"]);
	expect(extractCjkRuns("Hello world")).toEqual([]);
	// Japanese mixed-script adjacency stays one run.
	expect(extractCjkRuns("漢字ひらがなカタカナ")).toEqual([
		"漢字ひらがなカタカナ",
	]);
});

test("CJK bigrams: overlapping pairs, single char stays", () => {
	expect(cjkBigramsForRun("台北車站")).toEqual(["台北", "北車", "車站"]);
	expect(cjkBigramsForRun("駅")).toEqual(["駅"]);
	expect(cjkBigramsForRun("")).toEqual([]);
	expect(cjkBigramsForText("東京 Tokyo 駅")).toEqual(["東京", "駅"]);
});

test("containsCjk detects CJK anywhere", () => {
	expect(containsCjk("台北")).toBe(true);
	expect(containsCjk("Hello")).toBe(false);
	expect(containsCjk("")).toBe(false);
});

test("queryTokens: CJK bigrams added, single Han kept, Latin unchanged", () => {
	expect(queryTokens("台北車站")).toEqual(["台北", "北車", "車站"]);
	expect(queryTokens("駅")).toEqual(["駅"]);
	// Mixed without spaces still yields both sides.
	const mixed = queryTokens("東京Tokyo");
	expect(mixed).toContain("東京");
	expect(mixed).toContain("tokyo");
	// Latin behavior preserved: single chars dropped, deduped.
	expect(queryTokens("a ai ai")).toEqual(["ai"]);
});

test("ocrTokenMatch finds CJK bigrams in OCR text", () => {
	expect(ocrTokenMatch("台北車站", "台北車站出口")).toBe(1);
	expect(ocrTokenMatch("車站", "台北車站")).toBe(1);
	expect(ocrTokenMatch("駅", "東京駅")).toBe(1);
	expect(ocrTokenMatch("스크린샷", "스크린샷 2024")).toBe(1);
	expect(ocrTokenMatch("車站", "Hello world")).toBe(0);
});

test("OCR highlights light CJK lines in both modes", () => {
	const words = [
		{ text: "台北車站", x: 0.1, y: 0.2, w: 0.3, h: 0.08 },
		{ text: "Hello", x: 0.1, y: 0.4, w: 0.2, h: 0.06 },
	];
	expect(matchingOcrWordBoxes("車站", words).map((w) => w.text)).toEqual([
		"台北車站",
	]);
	expect(
		matchingOcrWordBoxes("車站", words, { substring: true }).map((w) => w.text),
	).toEqual(["台北車站"]);
	// Latin whole-word behavior unchanged: "ai" must not light "painting".
	const latin = [{ text: "painting", x: 0, y: 0, w: 0.1, h: 0.05 }];
	expect(matchingOcrWordBoxes("ai", latin).map((w) => w.text)).toEqual([]);
});

test("ocrLangs parse/resolve mirrors main-lib/settings.js", () => {
	expect(parseOcrLangs(undefined)).toEqual([
		"chi_sim",
		"chi_tra",
		"jpn",
		"kor",
	]);
	expect(parseOcrLangs(["chi_tra", "bogus", "chi_tra"])).toEqual(["chi_tra"]);
	expect(resolveOcrLangString(["kor", "jpn"])).toBe("eng+jpn+kor");
	expect(resolveOcrLangString([])).toBe("eng");
	expect(parseOcrLangs(["rus", "fra", "rus"])).toEqual(["rus", "fra"]);
	// Canonical order follows the table, not the input order.
	expect(resolveOcrLangString(["rus", "fra"])).toBe("eng+fra+rus");
});

test("TS mirror matches the shared ocr-lang-list.js table exactly", () => {
	// The renderer copy is deliberate (bundle boundary) — this test is the
	// drift alarm: add a language in BOTH files, appended, never reordered.
	expect(OCR_LANG_IDS).toEqual(JS_IDS);
	expect(DEFAULT_OCR_LANGS).toEqual(JS_DEFAULT);
	expect(OCR_LANG_GROUPS.map((g) => g.id)).toEqual(
		JS_GROUPS.map((g: { id: string }) => g.id),
	);
	expect(OCR_LANG_GROUPS.map((g) => g.label)).toEqual(
		JS_GROUPS.map((g: { label: string }) => g.label),
	);
	const tsLangs = OCR_LANG_GROUPS.flatMap((g) => g.langs);
	const jsLangs = JS_GROUPS.flatMap(
		(g: { langs: { id: string; label: string }[] }) => g.langs,
	);
	expect(tsLangs.map((l) => l.id)).toEqual(jsLangs.map((l) => l.id));
	expect(tsLangs.map((l) => l.label)).toEqual(jsLangs.map((l) => l.label));
	for (const id of JS_IDS as string[]) {
		expect(JS_BY_ID[id].label).toBe(
			(OCR_LANG_LABELS as Record<string, string>)[id],
		);
		expect(OCR_LANG_BLURBS).toHaveProperty(id);
	}
	// Table has real breadth: CJK + Western + Central + Cyrillic + Asia.
	expect(OCR_LANG_IDS.length).toBeGreaterThan(30);
	for (const id of ["fra", "rus", "ara", "hin", "vie"]) {
		expect(OCR_LANG_IDS).toContain(id);
	}
});

test("Tier-1 queries survive tokenization across scripts", () => {
	// Cyrillic / Greek / Arabic / Devanagari are whitespace-separated, so
	// they pass through as whole tokens (length gate still drops 1-char noise).
	expect(queryTokens("привет")).toEqual(["привет"]);
	expect(queryTokens("γειά")).toEqual(["γειά"]);
	expect(queryTokens("مرحبا")).toEqual(["مرحبا"]);
	expect(queryTokens("नमस्ते")).toEqual(["नमस्ते"]);
	expect(queryTokens("café")).toEqual(["café"]);
	expect(queryTokens("a")).toEqual([]);
});

test("ocrTokenMatch finds Tier-1 text", () => {
	expect(ocrTokenMatch("привет", "Привет, мир")).toBe(1);
	expect(ocrTokenMatch("γειά", "Γειά σου")).toBe(1);
	expect(ocrTokenMatch("café", "Café de Paris")).toBe(1);
	expect(ocrTokenMatch("привет", "Hello world")).toBe(0);
});

test("OCR highlights light Tier-1 words, keep Latin whole-word rule", () => {
	const words = [
		{ text: "Привет", x: 0.1, y: 0.2, w: 0.2, h: 0.06 },
		{ text: "painting", x: 0.1, y: 0.4, w: 0.2, h: 0.06 },
	];
	expect(matchingOcrWordBoxes("привет", words).map((w) => w.text)).toEqual([
		"Привет",
	]);
	const rtl = [{ text: "مرحبا بالعالم", x: 0, y: 0, w: 0.3, h: 0.06 }];
	expect(matchingOcrWordBoxes("مرحبا", rtl).map((w) => w.text)).toEqual([
		"مرحبا بالعالم",
	]);
	// Latin whole-word behavior unchanged: "ai" must not light "painting".
	const latin = [{ text: "painting", x: 0, y: 0, w: 0.1, h: 0.05 }];
	expect(matchingOcrWordBoxes("ai", latin).map((w) => w.text)).toEqual([]);
});
