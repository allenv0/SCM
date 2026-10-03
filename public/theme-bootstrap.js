// Theme bootstrap — loaded synchronously in <head> before the React bundle
// so the first paint never flashes the wrong theme. Mirrors useTheme.ts:
// localStorage("scm-theme") holds "light" | "dark" | "system"; system
// follows prefers-color-scheme. Kept as a separate file (not inline) so the
// app's Content-Security-Policy can use a strict script-src 'self' (M-02).
(function () {
	var theme = "system";
	try {
		var stored = localStorage.getItem("scm-theme");
		if (stored === "light" || stored === "dark" || stored === "system") {
			theme = stored;
		}
	} catch {
		/* localStorage unavailable (private mode) — fall back to system */
	}
	var dark =
		theme === "dark" ||
		(theme === "system" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);
	var root = document.documentElement;
	root.classList.toggle("dark", dark);
	root.classList.toggle("light", !dark);
})();
