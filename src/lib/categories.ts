// Screenshot tab classification. Historically this was a single
// `filename.startsWith("scr")` check lifted from the site's
// app/memories/page.tsx; the desktop app now runs a richer deterministic
// classifier (see screenshotWords.ts) so real screenshots on macOS/Windows
// stop falling out of the tab:
//   1. manual override        — user's explicit Add to/Remove from
//                               Screenshots (keyed by content hash in main)
//   2. filename tokens        — "screenshot" anywhere, localized screencapture
//                               names, tool brands, whole-token "scr"
//   3. import-time metadata   — PNG/JPEG text chunks naming a screenshot
//                               (rename-proof; probed by screenshot-probe.js)
//   4. source folder segment  — imported from a …/Screenshots/ folder
// Everything else lands in the Projects bucket (no tab — non-screenshots
// surface under All). Videos never reach this classifier: App.tsx routes
// them to the Videos tab first.

import {
	EXACT_TOKENS,
	SCREENSHOT_FOLDER_SEGMENTS,
	STRONG_SUBSTRINGS,
	TOKEN_SEQUENCES,
} from "./screenshotWords";

export type CategoryOverride = "Screenshots" | "Projects";

export interface CategoryInput {
	filename: string;
	/** Original import path recorded by main (library.sources). */
	sourcePath?: string | null;
	/** Import-time PNG/JPEG metadata probe result. */
	screenshotHint?: boolean | null;
	/** User's manual category decision; wins over every heuristic. */
	override?: CategoryOverride | null;
}

function filenameLooksLikeScreenshot(filename: string): boolean {
	const lower = filename.toLowerCase();

	for (const phrase of STRONG_SUBSTRINGS) {
		if (lower.includes(phrase)) return true;
	}

	// Tokenize on separators (space, -, _, ., (), …): runs of [a-z0-9].
	// CJK/special-script names never tokenize, but they are all covered as
	// substrings above.
	const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
	if (tokens.length === 0) return false;

	for (const token of tokens) {
		if (EXACT_TOKENS.includes(token)) return true;
	}
	for (const [first, second] of TOKEN_SEQUENCES) {
		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i] === first && tokens[i + 1] === second) return true;
		}
	}
	return false;
}

function sourceInScreenshotsFolder(
	sourcePath: string | null | undefined,
): boolean {
	if (!sourcePath) return false;
	const segments = sourcePath.replace(/\\/g, "/").toLowerCase().split("/");
	return segments.some((segment) =>
		SCREENSHOT_FOLDER_SEGMENTS.includes(segment),
	);
}

export function getCategory({
	filename,
	sourcePath,
	screenshotHint,
	override,
}: CategoryInput): string {
	if (override === "Screenshots") return "Screenshots";
	if (override === "Projects") return "Projects";
	if (filenameLooksLikeScreenshot(filename)) return "Screenshots";
	if (screenshotHint === true) return "Screenshots";
	if (sourceInScreenshotsFolder(sourcePath)) return "Screenshots";
	// Every remaining file lands in the Projects bucket.
	return "Projects";
}
