// Grid density preference (Settings → Grid): Auto (the responsive
// CSS-columns layout) or a fixed photos-per-row count of 2–5. Pure helpers
// live here so storage parsing and the narrow-window clamp are unit-testable
// without a DOM.

export type GridColumnsSetting = "auto" | 2 | 3 | 4 | 5;

export const GRID_COLUMNS_KEY = "scm-grid-columns";

// Narrow-window auto-shrink: tiles never go below GRID_MIN_TILE wide before
// the grid drops to fewer columns. GRID_GAP must stay in sync with the
// Tailwind `gap-4` on the grid container.
export const GRID_MIN_TILE = 150;
export const GRID_GAP = 16;

// The Settings control's options, in display order (ascending density,
// "Auto" last as the reset-to-responsive default).
export const GRID_COLUMN_OPTIONS: GridColumnsSetting[] = [2, 3, 4, 5, "auto"];

/** Parses a stored value into a valid setting; anything else → "auto". */
export function parseGridColumns(raw: string | null): GridColumnsSetting {
	if (raw === "auto") return "auto";
	const n = raw === null ? NaN : Number(raw);
	return n === 2 || n === 3 || n === 4 || n === 5
		? (n as GridColumnsSetting)
		: "auto";
}

export function readStoredGridColumns(): GridColumnsSetting {
	try {
		return parseGridColumns(localStorage.getItem(GRID_COLUMNS_KEY));
	} catch {
		// Storage unavailable (private mode etc.) — fall back to Auto.
		return "auto";
	}
}

/**
 * Resolves a setting to the rendered column count for a given container
 * width. "auto" returns null — the CSS breakpoint classes own that behavior.
 * A fixed choice is a CEILING: when the container is too narrow to hold all N
 * tiles at GRID_MIN_TILE each, drop to the widest count that fits (floor 2),
 * so a narrow window never squeezes tiles below the minimum.
 */
export function effectiveColumnCount(
	width: number,
	setting: GridColumnsSetting,
): number | null {
	if (setting === "auto") return null;
	const fits = (c: number) => c * GRID_MIN_TILE + (c - 1) * GRID_GAP <= width;
	for (let c = setting; c >= 2; c--) if (fits(c)) return c;
	return 2;
}
