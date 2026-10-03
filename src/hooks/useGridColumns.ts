import { useCallback, useState } from "react";
import {
	GRID_COLUMNS_KEY,
	readStoredGridColumns,
	type GridColumnsSetting,
} from "@/lib/gridColumns";

/**
 * Owns the library grid density preference: Auto (today's responsive
 * CSS-columns behavior) or a fixed 2–5 photos-per-row count. Mount once
 * (App); the Settings sheet's Grid section drives it via props. Persisted in
 * localStorage under the same pattern as the theme.
 */
export function useGridColumns() {
	const [gridColumns, setGridColumns] = useState<GridColumnsSetting>(
		readStoredGridColumns,
	);

	const update = useCallback((next: GridColumnsSetting) => {
		setGridColumns(next);
		try {
			localStorage.setItem(GRID_COLUMNS_KEY, String(next));
		} catch {
			// Persisting is best-effort; the session still applies the choice.
		}
	}, []);

	return { gridColumns, setGridColumns: update };
}
