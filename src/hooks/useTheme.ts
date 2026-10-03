import { useCallback, useEffect, useState } from "react";

export type ThemeSetting = "light" | "dark" | "system";

const STORAGE_KEY = "scm-theme";

function systemPrefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies a theme setting to <html> as the dark/light class pair the
 *  stylesheets key on. Kept in sync with the no-flash inline script in
 *  index.html — change both together. */
export function applyTheme(setting: ThemeSetting): void {
	const dark = setting === "system" ? systemPrefersDark() : setting === "dark";
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
}

export function readStoredTheme(): ThemeSetting {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") {
			return stored;
		}
	} catch {
		// Storage unavailable (private mode etc.) — fall through to system.
	}
	return "system";
}

/**
 * Owns the app's appearance setting: light / dark / follow-system.
 * Mount once (App) so the OS-preference subscription lives for the
 * session; the Settings sheet's Appearance section drives it via props.
 */
export function useTheme() {
	const [setting, setSetting] = useState<ThemeSetting>(readStoredTheme);

	// Apply on mount too — the inline script already did this before paint,
	// but re-applying is idempotent and covers the storage-unavailable case.
	useEffect(() => {
		applyTheme(setting);
	}, [setting]);

	// While following the system, track OS preference changes live.
	useEffect(() => {
		if (setting !== "system") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyTheme("system");
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [setting]);

	const update = useCallback((next: ThemeSetting) => {
		setSetting(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Persisting is best-effort; the session still switches.
		}
	}, []);

	return { theme: setting, setTheme: update };
}
