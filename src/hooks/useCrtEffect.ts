import { useCallback, useState } from "react";
import { CRT_EFFECT_KEY, readStoredCrtEffect } from "@/lib/crtEffect";

/**
 * Owns the lightbox CRT screen-effect preference: true (default) opens
 * photos/videos on the retro monitor frame; false is a plain viewer.
 * Mount once (App); the Settings sheet's Appearance section drives it via
 * props and MasonryGrid applies it. Persisted in localStorage under the
 * same best-effort pattern as the theme and grid density.
 */
export function useCrtEffect() {
	const [crtEffect, setCrtEffectState] = useState<boolean>(readStoredCrtEffect);

	const setCrtEffect = useCallback((next: boolean) => {
		setCrtEffectState(next);
		try {
			localStorage.setItem(CRT_EFFECT_KEY, next ? "true" : "false");
		} catch {
			// Persisting is best-effort; the session still applies the choice.
		}
	}, []);

	return { crtEffect, setCrtEffect };
}
