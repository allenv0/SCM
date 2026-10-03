import { useCallback, useState } from "react";
import {
	DEFAULT_VIEW_SHORTCUTS,
	readStoredViewShortcuts,
	writeStoredViewShortcuts,
	type ViewId,
	type ViewShortcuts,
} from "@/lib/viewShortcuts";

/**
 * Owns the five semantic view shortcuts (Settings → Keyboard): which key
 * combo jumps to each library view. Mount once (App); MasonryGrid reads
 * the map for dispatch and the Settings sheet drives it via props.
 * Persisted in localStorage under the same best-effort pattern as the
 * theme and grid density.
 */
export function useViewShortcuts() {
	const [viewShortcuts, setViewShortcuts] = useState<ViewShortcuts>(
		readStoredViewShortcuts,
	);

	const setViewShortcut = useCallback((id: ViewId, accel: string) => {
		setViewShortcuts((prev) => {
			const next = { ...prev, [id]: accel };
			writeStoredViewShortcuts(next);
			return next;
		});
	}, []);

	const resetViewShortcuts = useCallback(() => {
		const next = { ...DEFAULT_VIEW_SHORTCUTS };
		setViewShortcuts(next);
		writeStoredViewShortcuts(next);
	}, []);

	return { viewShortcuts, setViewShortcut, resetViewShortcuts };
}
