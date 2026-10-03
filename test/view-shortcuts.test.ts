import { expect, test } from "bun:test";
import {
	DEFAULT_VIEW_SHORTCUTS,
	RESERVED_VIEW_SHORTCUTS,
	VIEW_IDS,
	displayShortcut,
	eventToAccelerator,
	findDuplicateViews,
	matchAccelerator,
	parseViewShortcuts,
} from "../src/lib/viewShortcuts";

function key(
	over: Partial<{
		repeat: boolean;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		key: string;
	}> = {},
) {
	return {
		repeat: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		key: "1",
		...over,
	};
}

test("defaults reproduce the historical Cmd+1–5 mapping", () => {
	expect(DEFAULT_VIEW_SHORTCUTS).toEqual({
		"all-files": "CommandOrControl+1",
		"videos-scenes": "CommandOrControl+2",
		"screenshots-ocr": "CommandOrControl+3",
		"all-llms": "CommandOrControl+4",
		"videos-dialogue": "CommandOrControl+5",
	});
	expect(VIEW_IDS).toHaveLength(5);
});

test("eventToAccelerator builds canonical combos and rejects incomplete ones", () => {
	expect(eventToAccelerator(key({ metaKey: true }))).toBe("CommandOrControl+1");
	expect(
		eventToAccelerator(key({ metaKey: true, shiftKey: true, key: "3" })),
	).toBe("CommandOrControl+Shift+3");
	expect(eventToAccelerator(key({ metaKey: true, key: " " }))).toBe(
		"CommandOrControl+Space",
	);
	expect(eventToAccelerator(key({ metaKey: true, key: "a" }))).toBe(
		"CommandOrControl+A",
	);
	// No modifier, bare modifier, and repeats are incomplete.
	expect(eventToAccelerator(key())).toBeNull();
	expect(eventToAccelerator(key({ metaKey: true, key: "Meta" }))).toBeNull();
	expect(eventToAccelerator(key({ metaKey: true, repeat: true }))).toBeNull();
});

test("matchAccelerator uses the same normalization as the recorder", () => {
	expect(
		matchAccelerator(key({ metaKey: true, key: "3" }), "CommandOrControl+3"),
	).toBe(true);
	expect(
		matchAccelerator(key({ metaKey: true, key: "3" }), "CommandOrControl+4"),
	).toBe(false);
	// Shift combos never equal their plain-digit cousins (no double-fire).
	expect(
		matchAccelerator(
			key({ metaKey: true, shiftKey: true, key: "3" }),
			"CommandOrControl+3",
		),
	).toBe(false);
	expect(
		matchAccelerator(
			key({ metaKey: true, shiftKey: true, key: "3" }),
			"CommandOrControl+Shift+3",
		),
	).toBe(true);
});

test("displayShortcut renders accelerators mac-style", () => {
	expect(displayShortcut("CommandOrControl+Shift+3")).toBe("⌘ ⇧ 3");
	expect(displayShortcut("CommandOrControl+,")).toBe("⌘ ,");
});

test("parseViewShortcuts falls back per-entry on garbage", () => {
	expect(parseViewShortcuts(null)).toEqual(DEFAULT_VIEW_SHORTCUTS);
	expect(parseViewShortcuts([])).toEqual(DEFAULT_VIEW_SHORTCUTS);
	expect(
		parseViewShortcuts({
			"all-files": "CommandOrControl+9",
			"screenshots-ocr": "nope",
			"all-llms": 42,
		}),
	).toEqual({
		...DEFAULT_VIEW_SHORTCUTS,
		"all-files": "CommandOrControl+9",
	});
});

test("findDuplicateViews groups shared combos", () => {
	expect(findDuplicateViews({ ...DEFAULT_VIEW_SHORTCUTS })).toEqual([]);
	expect(
		findDuplicateViews({
			...DEFAULT_VIEW_SHORTCUTS,
			"all-llms": "CommandOrControl+3",
		}),
	).toEqual([["screenshots-ocr", "all-llms"]]);
});

test("reserved list covers Settings, Import, and window chrome", () => {
	for (const accel of [
		"CommandOrControl+,",
		"CommandOrControl+I",
		"CommandOrControl+O",
		"CommandOrControl+Q",
		"CommandOrControl+W",
		"CommandOrControl+H",
	]) {
		expect(RESERVED_VIEW_SHORTCUTS[accel]).toBeTruthy();
	}
});
