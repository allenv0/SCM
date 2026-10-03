import { expect, test } from "bun:test";
import {
	addSavedSearch,
	isSaved,
	loadSavedSearches,
	normalizePrompt,
	removeSavedSearch,
	updateSavedSearch,
} from "../src/lib/savedSearches";

// bun:test has no DOM localStorage — minimal in-memory stub (the module
// only touches getItem/setItem/removeItem inside try/catch).
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
};

test("dialogue mode round-trips through add/parse", () => {
	const list = addSavedSearch(
		[],
		"where she explains pricing",
		"Pricing",
		"dialogue",
	);
	expect(list).toHaveLength(1);
	expect(list[0].mode).toBe("dialogue");
	expect(isSaved("where she explains pricing", list)).toBe(true);
});

test("all four modes survive add/update", () => {
	for (const mode of ["files", "scenes", "ocr", "dialogue"] as const) {
		const list = addSavedSearch([], `q-${mode}`, `L-${mode}`, mode);
		expect(list[0].mode).toBe(mode);
		const updated = updateSavedSearch(list, `q-${mode}`, { mode });
		expect(updated[0].mode).toBe(mode);
	}
});

test("unknown modes backfill to files (forward-safe for older builds)", () => {
	expect(addSavedSearch([], "q", "L", "blended" as never)[0].mode).toBe(
		"files",
	);
	expect(
		updateSavedSearch([{ prompt: "q", label: "L", mode: "files" }], "q", {
			mode: "vibes" as never,
		})[0].mode,
	).toBe("files");
});

test("persisted dialogue tabs load back with mode intact", () => {
	const tabs = [
		{ prompt: "pricing talk", label: "Pricing", mode: "dialogue" },
		{ prompt: "sunset", label: "Sunset", mode: "scenes" },
		"bare prompt",
		{ prompt: "x", label: "X" }, // missing mode → files
	];
	localStorage.setItem("memories-saved-tabs", JSON.stringify(tabs));
	const loaded = loadSavedSearches();
	expect(loaded.find((t) => t.prompt === "pricing talk")?.mode).toBe(
		"dialogue",
	);
	expect(loaded.find((t) => t.prompt === "sunset")?.mode).toBe("scenes");
	expect(loaded.find((t) => t.prompt === "bare prompt")?.mode).toBe("files");
	expect(loaded.find((t) => t.prompt === "x")?.mode).toBe("files");
	localStorage.removeItem("memories-saved-tabs");
});

test("remove + case-insensitive dedupe cover dialogue tabs", () => {
	const list = addSavedSearch([], "Pricing Talk", "Pricing", "dialogue");
	expect(
		addSavedSearch(list, "pricing talk", "Other", "dialogue"),
	).toHaveLength(1);
	expect(removeSavedSearch(list, "PRICING TALK")).toHaveLength(0);
	expect(normalizePrompt("  pricing   talk ")).toBe("pricing talk");
});
