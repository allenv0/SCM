import { useCallback, useState } from "react";
import {
	isAlwaysOn,
	readStoredEnabledTabs,
	writeStoredEnabledTabs,
} from "@/lib/builtInTabs";

/**
 * Owns the built-in tab visibility set (Settings → Smart Tabs): which
 * toggleable tabs (Screenshots, Email, …) render in the tab bar. Mount
 * once (App); MasonryGrid reads the set for filtering and the Settings
 * sheet drives it via props. Persisted in localStorage as a record
 * ({ Screenshots: bool, … }) under the same best-effort pattern as the
 * theme and grid density — always-on tabs (All, Videos) are forced on
 * and can never be toggled off.
 */
export function useEnabledTabs() {
	const [enabledTabs, setEnabledTabs] = useState<Set<string>>(
		readStoredEnabledTabs,
	);

	const setTabEnabled = useCallback((id: string, on: boolean) => {
		// The locked tabs are not toggleable — ignore instead of writing a
		// state the registry would force back on at the next parse.
		if (isAlwaysOn(id)) return;
		setEnabledTabs((prev) => {
			if (prev.has(id) === on) return prev;
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			writeStoredEnabledTabs(next);
			return next;
		});
	}, []);

	return { enabledTabs, setTabEnabled };
}
