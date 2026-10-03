import { expect, test } from "bun:test";
import {
	importResultToast,
	resultSummary,
	shortName,
} from "../src/lib/importToast";
import type { ImportResult } from "../src/types";

function res(over: Partial<ImportResult>): ImportResult {
	return { added: [], skipped: [], errors: [], watched: [], ...over };
}

test("clean batch is success", () => {
	const t = importResultToast(res({ added: ["a.jpg"] }));
	expect(t.tone).toBe("success");
	expect(t.message).toBe("Photos added");
});

test("empty batch is default", () => {
	const t = importResultToast(res({}));
	expect(t.tone).toBe("default");
	expect(t.message).toBe("Nothing to import");
});

test("skipped-only batch names the count", () => {
	const t = importResultToast(res({ skipped: ["a.jpg", "b.jpg"] }));
	expect(t.message).toBe("2 already imported");
});

test("guard refusal names the folder AND the reason", () => {
	const t = importResultToast(
		res({
			errors: [
				{
					file: "SCM-Movies",
					error: "An import is already running — try again when it finishes.",
				},
			],
		}),
	);
	expect(t.tone).toBe("error");
	expect(t.message).toBe(
		"Some files failed AI indexing: SCM-Movies — An import is already running — try again when it finishes.",
	);
});

test("partial batch keeps the prefix and warns", () => {
	const t = importResultToast(
		res({
			added: ["ok.jpg"],
			errors: [{ file: "bad.jpg", error: "Unsupported file type" }],
		}),
	);
	expect(t.tone).toBe("warning");
	expect(t.message).toBe(
		"Photos added · Some files failed AI indexing: bad.jpg — Unsupported file type",
	);
});

test("multi-error lists two files and dedupes reasons", () => {
	const t = importResultToast(
		res({
			errors: [
				{ file: "a.jpg", error: "File not found" },
				{ file: "b.mp4", error: "File not found" },
				{ file: "c.jpg", error: "Copy stalled (no progress for 30s)" },
			],
		}),
	);
	expect(t.message).toBe(
		"Some files failed AI indexing: a.jpg, b.mp4, … — File not found · Copy stalled (no progress for 30s)",
	);
});

test("long technical reasons truncate with ellipsis", () => {
	const long = `ffmpeg exited 1: ${"x".repeat(200)}`;
	const t = importResultToast(
		res({ errors: [{ file: "v.mp4", error: long }] }),
	);
	expect(t.message.endsWith("…")).toBe(true);
	expect(t.message.length).toBeLessThan(
		"Some files failed AI indexing: v.mp4 — ".length + 140 + 1,
	);
});

test("watch suffix survives alongside the reason", () => {
	const t = importResultToast(
		res({
			added: ["a.jpg"],
			errors: [{ file: "b.jpg", error: "File not found" }],
			watched: ["SCM-Movies"],
		}),
	);
	expect(t.message).toBe(
		"Photos added · Some files failed AI indexing: b.jpg — File not found · Watching SCM-Movies for new photos",
	);
});

test("shortName truncates long names", () => {
	expect(shortName("abc")).toBe("abc");
	expect(shortName("a".repeat(40))).toBe(`${"a".repeat(29)}…`);
});

test("resultSummary composes added + skipped", () => {
	expect(resultSummary(null)).toBe(null);
	expect(resultSummary(res({ added: ["a"], skipped: ["b", "c"] }))).toBe(
		"Photos added · 2 already imported",
	);
});
