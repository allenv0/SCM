// CRT monitor screen effect preference (Settings → Appearance): whether
// the photo/video lightbox opens on a retro CRT frame (bezel, curvature,
// phosphor glow, flicker) or a plain full-screen viewer. Pure helpers so
// storage parsing is unit-testable without a DOM (same pattern as
// gridColumns.ts).

export const CRT_EFFECT_KEY = "scm-crt-effect";

/** Parses a stored value; only the literal "false" turns the effect off. */
export function parseCrtEffect(raw: string | null): boolean {
	return raw !== "false";
}

export function readStoredCrtEffect(): boolean {
	try {
		return parseCrtEffect(localStorage.getItem(CRT_EFFECT_KEY));
	} catch {
		// Storage unavailable (private mode etc.) — fall back to CRT on.
		return true;
	}
}
