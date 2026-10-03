import { test, expect } from "bun:test";
import {
	virtualGridLayout,
	ROW_GAP,
	CARD_ASPECT,
	CARD_SHELL,
} from "@/lib/virtualGrid";

// Geometry used across cases: a 1152px container at 4 columns mirrors the
// deep-test window (1280×800, lg:max-w-6xl) — colWidth 276, card height 217.
const WIDTH = 1152;
const COLS = 4;
const COL_W = (WIDTH - (COLS - 1) * ROW_GAP) / COLS;
const CARD_H = Math.round(COL_W / CARD_ASPECT) + CARD_SHELL;
const STRIDE = CARD_H + ROW_GAP;
const VIEWPORT = 800;

test("row geometry matches the uniform 4:3 card model", () => {
	expect(COL_W).toBe(276);
	expect(CARD_H).toBe(217);
	expect(STRIDE).toBe(233);
});

test("small library fully mounts near the top (all rows ≤ overscan reach)", () => {
	// 33 items = 9 rows; overscan of 6 covers every row from the top.
	const l = virtualGridLayout({
		itemCount: 33,
		columns: COLS,
		width: WIDTH,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 6,
	});
	expect(l.rowCount).toBe(9);
	expect(l.sliceStart).toBe(0);
	expect(l.sliceEnd).toBe(33);
	expect(l.totalHeight).toBe(9 * CARD_H + 8 * ROW_GAP);
});

test("large library mounts a bounded window, not the whole list", () => {
	const total = 50_000;
	const l = virtualGridLayout({
		itemCount: total,
		columns: COLS,
		width: WIDTH,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 6,
	});
	expect(l.rowCount).toBe(total / COLS);
	// Only the first rows mount: visible (ceil(800/233)=4) + overscan (6) →
	// rows 0..10 = 44 cards — a bounded window, not the whole library.
	expect(l.sliceEnd).toBeLessThanOrEqual(11 * COLS);
	expect(l.sliceEnd).toBeLessThan(48);
	expect(l.sliceEnd).toBeGreaterThan(0);
	// Container height spans the whole library — the scrollbar is real.
	expect(l.totalHeight).toBeGreaterThan(total * 50);
});

test("scrolled to the bottom the slice includes the last item", () => {
	const total = 50_000;
	const rows = total / COLS;
	const l = virtualGridLayout({
		itemCount: total,
		columns: COLS,
		width: WIDTH,
		scrollTop: rows * STRIDE, // bottom of the grid
		viewportH: VIEWPORT,
		overscanRows: 6,
	});
	expect(l.endRow).toBe(rows - 1);
	expect(l.sliceEnd).toBe(total);
	// The top of the library is NOT mounted.
	expect(l.sliceStart).toBeGreaterThan(0);
});

test("mid-scroll slice excludes both distant tails", () => {
	const total = 50_000;
	const rows = total / COLS;
	const l = virtualGridLayout({
		itemCount: total,
		columns: COLS,
		width: WIDTH,
		scrollTop: rows * STRIDE * 0.5, // middle of the grid
		viewportH: VIEWPORT,
		overscanRows: 6,
	});
	expect(l.sliceStart).toBeGreaterThan(0);
	expect(l.sliceEnd).toBeLessThan(total);
	// Mounted span is bounded: visible window + overscan on both sides.
	const mountedRows = l.endRow - l.startRow + 1;
	expect(mountedRows).toBeLessThanOrEqual(
		Math.ceil(VIEWPORT / STRIDE) + 2 * 6 + 1,
	);
});

test("measured row height overrides the estimate", () => {
	const l = virtualGridLayout({
		itemCount: 100,
		columns: COLS,
		width: WIDTH,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 4,
		measuredRowH: 220,
	});
	expect(l.rowHeight).toBe(220);
	expect(l.stride).toBe(220 + ROW_GAP);
	expect(l.totalHeight).toBe(25 * 220 + 24 * ROW_GAP);
});

test("no width → no rows, zero height, empty slice", () => {
	const l = virtualGridLayout({
		itemCount: 100,
		columns: COLS,
		width: 0,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 4,
	});
	expect(l.colWidth).toBe(0);
	expect(l.rowCount).toBe(0);
	expect(l.totalHeight).toBe(0);
	expect(l.sliceEnd).toBe(0);
});

test("empty item list → zero height", () => {
	const l = virtualGridLayout({
		itemCount: 0,
		columns: COLS,
		width: WIDTH,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 4,
	});
	expect(l.totalHeight).toBe(0);
	expect(l.sliceEnd).toBe(0);
});

test("scrollTop beyond the list clamps to the last rows", () => {
	const l = virtualGridLayout({
		itemCount: 40,
		columns: COLS,
		width: WIDTH,
		scrollTop: 1_000_000, // far past the bottom
		viewportH: VIEWPORT,
		overscanRows: 6,
	});
	expect(l.endRow).toBe(l.rowCount - 1);
	expect(l.sliceEnd).toBe(40);
});

test("single column degrades to a uniform vertical strip", () => {
	const l = virtualGridLayout({
		itemCount: 50,
		columns: 1,
		width: 400,
		scrollTop: 0,
		viewportH: 800,
		overscanRows: 4,
	});
	expect(l.rowCount).toBe(50);
	expect(l.colWidth).toBe(400);
	expect(l.stride).toBe(Math.round(400 / CARD_ASPECT) + CARD_SHELL + ROW_GAP);
});

test("overscan 0 mounts only the visible window", () => {
	const l = virtualGridLayout({
		itemCount: 10_000,
		columns: COLS,
		width: WIDTH,
		scrollTop: 0,
		viewportH: VIEWPORT,
		overscanRows: 0,
	});
	const visibleRows = Math.ceil(VIEWPORT / STRIDE);
	expect(l.endRow).toBeLessThanOrEqual(visibleRows);
	expect(l.startRow).toBe(0);
});
