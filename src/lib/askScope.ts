// Ask-mode scope parsing (MDs/Ask-Mode-Plan.md): a leading `/scope` token
// narrows the library the question searches — "/screenshots what did Bill
// Gurley say" answers only from Screenshots rows. Pure and dependency-free
// so the grid can parse before the IPC call; the scope → filename mapping
// lives here too because tab membership (category/hasEmail) is derived
// renderer-side and the main process must not re-implement it.
//
// This mirrors nothing on main: main validates every filename against the
// live index (indexOf guard), so scope drift degrades to "fewer results",
// never wrong ones.

import { isVideoFile } from "@/lib/media";

export type AskScope = "all" | "screenshots" | "videos" | "email";

export const ASK_SCOPE_IDS: AskScope[] = [
	"all",
	"screenshots",
	"videos",
	"email",
];

export const ASK_SCOPE_LABELS: Record<AskScope, string> = {
	all: "the whole library",
	screenshots: "Screenshots",
	videos: "Videos",
	email: "Email",
};

export interface AskScopeResult {
	scope: AskScope;
	/** The question with the scope token stripped ("" when only a scope). */
	query: string;
}

// Leading-scope parser: "/screenshots what did X say" → screenshots. The
// token must be the first word, followed by whitespace. Bare "/screenshots"
// parses with an empty query (the grid treats that as "still typing").
export function parseAskScope(text: string): AskScopeResult {
	const trimmed = (text || "").trim();
	const match = /^\/([a-z]+)\b[\s,]*/i.exec(trimmed);
	if (!match) return { scope: "all", query: trimmed };
	const token = match[1].toLowerCase();
	if (!ASK_SCOPE_IDS.includes(token as AskScope)) {
		return { scope: "all", query: trimmed };
	}
	return {
		scope: token as AskScope,
		query: trimmed.slice(match[0].length).trim(),
	};
}

/** The minimal row shape the scope filter needs (ImageItem from the grid). */
export interface AskScopeItem {
	filename: string;
	category: string;
	hasEmail: boolean;
}

// Scope → filenames. Videos tab membership is the file extension (same rule
// as the grid's category derivation); Screenshots/Email reuse the derived
// per-row flags the tabs themselves display.
export function scopedFilenames(
	items: AskScopeItem[],
	scope: AskScope,
): string[] {
	if (scope === "all") return items.map((i) => i.filename);
	return items
		.filter((i) =>
			scope === "videos"
				? isVideoFile(i.filename)
				: scope === "screenshots"
					? i.category === "Screenshots"
					: scope === "email"
						? i.hasEmail
						: true,
		)
		.map((i) => i.filename);
}
