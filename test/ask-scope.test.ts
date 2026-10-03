import { describe, expect, test } from "bun:test";
import {
	parseAskScope,
	scopedFilenames,
	ASK_SCOPE_IDS,
} from "../src/lib/askScope";

// Ask scope parsing (MDs/Ask-Mode-Plan.md): the leading /scope token routes
// the question at a tab-sized slice of the library. The scope → filename
// mapping is renderer-side (tab membership is derived here); main validates
// every filename against the live index, so drift degrades, never lies.

describe("parseAskScope", () => {
	test("parses a leading scope token and strips it", () => {
		expect(parseAskScope("/screenshots what did Bill Gurley say")).toEqual({
			scope: "screenshots",
			query: "what did Bill Gurley say",
		});
		expect(parseAskScope("/videos birthday song")).toEqual({
			scope: "videos",
			query: "birthday song",
		});
		expect(parseAskScope("/email invoice from")).toEqual({
			scope: "email",
			query: "invoice from",
		});
		expect(parseAskScope("/all anything")).toEqual({
			scope: "all",
			query: "anything",
		});
	});

	test("is case-insensitive and tolerates trailing separator", () => {
		expect(parseAskScope("/Screenshots, hello").scope).toBe("screenshots");
		expect(parseAskScope("/VIDEOS  x").scope).toBe("videos");
	});

	test("unknown or non-leading slash tokens stay part of the query", () => {
		expect(parseAskScope("/unknown query")).toEqual({
			scope: "all",
			query: "/unknown query",
		});
		expect(parseAskScope("what is /screenshots")).toEqual({
			scope: "all",
			query: "what is /screenshots",
		});
	});

	test("a bare scope parses with an empty query (still typing)", () => {
		expect(parseAskScope("/screenshots")).toEqual({
			scope: "screenshots",
			query: "",
		});
	});

	test("plain text is scope all", () => {
		expect(parseAskScope("beach sunset")).toEqual({
			scope: "all",
			query: "beach sunset",
		});
		expect(parseAskScope("")).toEqual({ scope: "all", query: "" });
	});
});

describe("scopedFilenames", () => {
	const items = [
		{ filename: "shot.png", category: "Screenshots", hasEmail: false },
		{ filename: "bill.png", category: "Projects", hasEmail: true },
		{ filename: "film.mp4", category: "Videos", hasEmail: false },
	];

	test("all spans everything in order", () => {
		expect(scopedFilenames(items, "all")).toEqual([
			"shot.png",
			"bill.png",
			"film.mp4",
		]);
	});

	test("screenshots follows the derived category, videos the extension", () => {
		expect(scopedFilenames(items, "screenshots")).toEqual(["shot.png"]);
		expect(scopedFilenames(items, "videos")).toEqual(["film.mp4"]);
		expect(scopedFilenames(items, "email")).toEqual(["bill.png"]);
	});

	test("the scope id table stays canonical", () => {
		expect([...ASK_SCOPE_IDS].sort()).toEqual([
			"all",
			"email",
			"screenshots",
			"videos",
		]);
	});
});
