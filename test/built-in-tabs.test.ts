import { expect, test } from "bun:test";
import {
	BUILT_IN_TABS,
	BUILT_IN_TAB_INFO,
	ENABLED_TABS_KEY,
	TOGGLEABLE_TABS,
	isAlwaysOn,
	isBuiltInTab,
	parseEnabledTabs,
	readStoredEnabledTabs,
	visibleBuiltInTabs,
	writeStoredEnabledTabs,
} from "../src/lib/builtInTabs";

// bun:test has no DOM localStorage — minimal in-memory stub.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
};

test("registry lists All/Videos locked on, Screenshots/Email toggleable", () => {
	expect([...BUILT_IN_TABS]).toEqual(["All", "Videos", "Screenshots", "Email"]);
	expect([...TOGGLEABLE_TABS]).toEqual(["Screenshots", "Email"]);
	expect(isAlwaysOn("All")).toBe(true);
	expect(isAlwaysOn("Videos")).toBe(true);
	expect(isAlwaysOn("Screenshots")).toBe(false);
	expect(isAlwaysOn("Email")).toBe(false);
	expect(isBuiltInTab("Screenshots")).toBe(true);
	expect(isBuiltInTab("Beach Trip")).toBe(false);
	for (const id of BUILT_IN_TABS) {
		expect(BUILT_IN_TAB_INFO[id].label).toBe(id);
		expect(BUILT_IN_TAB_INFO[id].blurb.length).toBeGreaterThan(0);
	}
});

test("missing storage defaults to everything on (current behavior)", () => {
	expect(parseEnabledTabs(null)).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
	expect(parseEnabledTabs(undefined)).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
});

test("record shape honors explicit off, backfills new tabs to default", () => {
	expect(parseEnabledTabs({ Screenshots: false })).toEqual(
		new Set(["All", "Videos", "Email"]),
	);
	expect(parseEnabledTabs({ Screenshots: true, Email: false })).toEqual(
		new Set(["All", "Videos", "Screenshots"]),
	);
	// A tab missing from an old record appears (defaultOn), not hidden.
	expect(parseEnabledTabs({})).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
});

test("always-on tabs are forced on even when storage says off", () => {
	expect(
		parseEnabledTabs({ All: false, Videos: false, Screenshots: true } as never),
	).toEqual(new Set(["All", "Videos", "Screenshots", "Email"]));
});

test("corrupt storage falls back to defaults, never a blank bar", () => {
	expect(parseEnabledTabs("garbage")).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
	expect(parseEnabledTabs([])).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
	expect(parseEnabledTabs({ Screenshots: false, Email: false })).toEqual(
		new Set(["All", "Videos"]),
	);
	// Unknown ids are dropped; always-on tabs keep the bar non-blank.
	expect(parseEnabledTabs(["Nope"])).toEqual(new Set(["All", "Videos"]));
});

test("visibleBuiltInTabs preserves tab-bar order", () => {
	expect(visibleBuiltInTabs(new Set(["All", "Videos", "Email"]))).toEqual([
		"All",
		"Videos",
		"Email",
	]);
	expect(
		visibleBuiltInTabs(new Set(["All", "Videos", "Screenshots", "Email"])),
	).toEqual(["All", "Videos", "Screenshots", "Email"]);
});

test("write round-trips as a record and read honors it", () => {
	store.delete(ENABLED_TABS_KEY);
	expect(readStoredEnabledTabs()).toEqual(
		new Set(["All", "Videos", "Screenshots", "Email"]),
	);
	writeStoredEnabledTabs(new Set(["All", "Videos", "Email"]));
	expect(JSON.parse(store.get(ENABLED_TABS_KEY)!)).toEqual({
		Screenshots: false,
		Email: true,
	});
	expect(readStoredEnabledTabs()).toEqual(new Set(["All", "Videos", "Email"]));
	store.delete(ENABLED_TABS_KEY);
});
