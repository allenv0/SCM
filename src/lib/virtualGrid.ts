// Pure row-window math for the virtualized masonry grid. Every tile is an
// exact 4:3 box (MemoryCard's aspect-[4/3] + p-1 shell + border), so rows
// have one uniform height and the layout is computable from item count,
// column count, and the scroll window — no per-item measurement. Extracted
// from MasonryGrid so the slice/height math is unit-testable without a DOM
// (same pattern as gridColumns.ts).

// Row geometry constants. ROW_GAP must stay in sync with the grid's CSS
// gap-4 (GRID_GAP in gridColumns.ts); CARD_ASPECT with MemoryCard's
// aspect-[4/3]; CARD_SHELL is the p-1 shell (8px) + 1px border × 2.
export const ROW_GAP = 16;
export const CARD_ASPECT = 4 / 3;
export const CARD_SHELL = 10;

export interface VirtualGridLayout {
	/** Width of one tile (fractional); 0 when the container has no width. */
	colWidth: number;
	/** Row height: the measured card height, or the geometric estimate. */
	rowHeight: number;
	/** One row + the inter-row gap. */
	stride: number;
	/** Number of full rows the items occupy. */
	rowCount: number;
	/** Container height — the scrollable span of the whole grid. */
	totalHeight: number;
	/** First mounted row index (0-based, clamped to [0, rowCount)). */
	startRow: number;
	/** Last mounted row index (inclusive, clamped). */
	endRow: number;
	/** Item index of the first mounted card. */
	sliceStart: number;
	/** Item index one past the last mounted card. */
	sliceEnd: number;
}

export interface VirtualGridOptions {
	itemCount: number;
	columns: number;
	/** Measured width of the grid container (clientWidth). */
	width: number;
	scrollTop: number;
	viewportH: number;
	/** Rows to mount beyond the visible window on each side. Defaults to one
	 *  full viewport of rows + 2 (computed from the layout's own stride), so
	 *  fast scrolling never flashes empty space. */
	overscanRows?: number;
	/** Measured height of a rendered card; null until the first measurement. */
	measuredRowH?: number | null;
}
export function virtualGridLayout(opts: VirtualGridOptions): VirtualGridLayout {
	const { itemCount, columns, width, scrollTop, viewportH } = opts;
	const colWidth = width > 0 ? (width - (columns - 1) * ROW_GAP) / columns : 0;
	const rowHeight =
		opts.measuredRowH ?? Math.round(colWidth / CARD_ASPECT) + CARD_SHELL;
	const stride = rowHeight + ROW_GAP;
	const rowCount = colWidth > 0 ? Math.ceil(itemCount / columns) : 0;
	const totalHeight =
		rowCount > 0 ? rowCount * rowHeight + (rowCount - 1) * ROW_GAP : 0;

	// The visible window ± the overscan band. scrollTop can exceed the
	// document height transiently (a tab switch shrinking the list), so the
	// clamps below keep the slice inside the item range.
	const overscanRows =
		opts.overscanRows ?? Math.ceil(viewportH / Math.max(stride, 1)) + 2;
	const firstRow = colWidth > 0 ? Math.floor(scrollTop / stride) : 0;
	const lastRow = Math.ceil((scrollTop + viewportH) / stride);
	const startRow = Math.max(0, firstRow - overscanRows);
	const endRow = Math.min(rowCount - 1, lastRow + overscanRows);
	const sliceStart = startRow * columns;
	const sliceEnd = Math.min(itemCount, (endRow + 1) * columns);

	return {
		colWidth,
		rowHeight,
		stride,
		rowCount,
		totalHeight,
		startRow,
		endRow,
		sliceStart,
		sliceEnd,
	};
}
