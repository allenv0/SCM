import { expect, test } from "bun:test";
import {
	GRID_GAP,
	GRID_MIN_TILE,
	effectiveColumnCount,
	parseGridColumns,
	type GridColumnsSetting,
} from "../src/lib/gridColumns";

test("parseGridColumns accepts the stored auto value", () => {
	expect(parseGridColumns("auto")).toBe("auto");
});

test("parseGridColumns accepts stored counts 2..5", () => {
	for (const n of ["2", "3", "4", "5"]) {
		expect(parseGridColumns(n)).toBe(Number(n) as GridColumnsSetting);
	}
});

test("parseGridColumns rejects garbage, out-of-range counts, and null", () => {
	expect(parseGridColumns(null)).toBe("auto");
	expect(parseGridColumns("")).toBe("auto");
	expect(parseGridColumns("1")).toBe("auto");
	expect(parseGridColumns("6")).toBe("auto");
	expect(parseGridColumns("two")).toBe("auto");
	expect(parseGridColumns("3.5")).toBe("auto");
});

test("effectiveColumnCount returns null for Auto (CSS classes own it)", () => {
	expect(effectiveColumnCount(1200, "auto")).toBeNull();
	expect(effectiveColumnCount(0, "auto")).toBeNull();
});

test("effectiveColumnCount renders the chosen count when it fits", () => {
	// Wide container: every choice fits at GRID_MIN_TILE + gaps.
	for (const setting of [2, 3, 4, 5] as const) {
		const need = setting * GRID_MIN_TILE + (setting - 1) * GRID_GAP;
		expect(effectiveColumnCount(need, setting)).toBe(setting);
		expect(effectiveColumnCount(need + 100, setting)).toBe(setting);
	}
});

test("effectiveColumnCount clamps on narrow containers", () => {
	// 5 needs 5*150 + 4*16 = 814; at 700 only 4*150 + 3*16 = 648 fit.
	expect(effectiveColumnCount(700, 5)).toBe(4);
	expect(effectiveColumnCount(648, 5)).toBe(4);
	// One px short of 4-wide: drops to 3.
	expect(effectiveColumnCount(647, 5)).toBe(3);
	// 2 never clamps below 2.
	expect(effectiveColumnCount(0, 2)).toBe(2);
});

test("effectiveColumnCount never exceeds the chosen count", () => {
	expect(effectiveColumnCount(100000, 3)).toBe(3);
	expect(effectiveColumnCount(100000, 2)).toBe(2);
});

test("exact-boundary fits and one-px-short clamps (rule 4 boundaries)", () => {
	// width = c*MIN + (c-1)*GAP fits c; width-1 must drop to c-1.
	for (const c of [3, 4, 5] as const) {
		const exact = c * GRID_MIN_TILE + (c - 1) * GRID_GAP;
		expect(effectiveColumnCount(exact, c)).toBe(c);
		const below = effectiveColumnCount(exact - 1, c);
		expect(below).toBe(c - 1);
	}
});
