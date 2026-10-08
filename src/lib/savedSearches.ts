// Saved searches ("save a search prompt as a tab"): a saved search pairs
// the query it runs (prompt) with the display name the user chose at save
// time (label) and the search mode it was saved in (mode). The tab's
// identity IS the prompt, so identity survives restarts and duplicates are
// trivial to detect — while the label is free to be anything, including
// something different from the query.

const SAVED_TABS_KEY = "memories-saved-tabs";
const MAX_SAVED_TABS = 20;

export type SavedTabMode = "files" | "scenes" | "ocr" | "dialogue";

export interface SavedTab {
	/** The search query this tab runs (its identity). */
	readonly prompt: string;
	/** The display name on the tab — chosen by the user, may differ. */
	readonly label: string;
	/** The search mode (Files/Scenes/Dialogue/OCR) this tab was saved in. */
	readonly mode: SavedTabMode;
	/** YouTube agent: when true this saved search is an "interest" that
	 *  auto-matches newly downloaded videos. Absent = false (back-compat). */
	readonly watch?: boolean;
}

export function normalizePrompt(p: string): string {
	return p.trim().replace(/\s+/g, " ");
}

// Parse one persisted entry, backfilling defaults for every generation of
// the format: bare prompt strings (label = prompt, mode = files) and
// { prompt, label } pairs missing the mode. `watch` (YouTube interests)
// backfills to false.
function parseSavedTab(entry: unknown): SavedTab | null {
	if (typeof entry === "string") {
		const p = normalizePrompt(entry);
		return p ? { prompt: p, label: p, mode: "files" } : null;
	}
	if (typeof entry !== "object" || entry === null) return null;
	const e = entry as Record<string, unknown>;
	if (typeof e.prompt !== "string" || typeof e.label !== "string") return null;
	const p = normalizePrompt(e.prompt);
	if (!p) return null;
	const l = normalizePrompt(e.label);
	const mode: SavedTabMode =
		e.mode === "scenes" || e.mode === "ocr" || e.mode === "dialogue"
			? e.mode
			: "files";
	const watch = e.watch === true;
	return watch
		? { prompt: p, label: l || p, mode, watch }
		: { prompt: p, label: l || p, mode };
}

export function loadSavedSearches(): SavedTab[] {
	try {
		const raw = localStorage.getItem(SAVED_TABS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map(parseSavedTab).filter((t): t is SavedTab => t !== null);
	} catch {
		return [];
	}
}

export function saveSavedSearches(list: SavedTab[]): void {
	try {
		localStorage.setItem(SAVED_TABS_KEY, JSON.stringify(list));
	} catch {
		/* localStorage can be unavailable (private mode) — tabs just don't persist */
	}
}

// Case-insensitive membership on the prompt: "Beach Trip" hides the save
// button for "beach trip" and vice versa.
export function isSaved(prompt: string, list: SavedTab[]): boolean {
	const p = normalizePrompt(prompt).toLowerCase();
	return list.some((t) => normalizePrompt(t.prompt).toLowerCase() === p);
}

// Add a saved search, oldest dropped past the cap. Returns the new list.
// label falls back to the prompt when not given; mode defaults to files.
export function addSavedSearch(
	list: SavedTab[],
	prompt: string,
	label?: string,
	mode: SavedTabMode = "files",
	max = MAX_SAVED_TABS,
	watch = false,
): SavedTab[] {
	const p = normalizePrompt(prompt);
	if (!p || isSaved(p, list)) return list;
	const l = normalizePrompt(label ?? "") || p;
	const m: SavedTabMode =
		mode === "scenes" || mode === "ocr" || mode === "dialogue" ? mode : "files";
	const entry: SavedTab = watch
		? { prompt: p, label: l, mode: m, watch: true as const }
		: { prompt: p, label: l, mode: m };
	return [...list, entry].slice(-max);
}

// Remove a saved search (by prompt — the tab's identity). Returns the new
// list.
export function removeSavedSearch(
	list: SavedTab[],
	prompt: string,
): SavedTab[] {
	const p = normalizePrompt(prompt).toLowerCase();
	return list.filter((t) => normalizePrompt(t.prompt).toLowerCase() !== p);
}

// Update an existing saved search's label and/or mode. The prompt is the
// tab's identity and never changes. Returns the new list.
export function updateSavedSearch(
	list: SavedTab[],
	prompt: string,
	patch: { label?: string; mode?: SavedTabMode; watch?: boolean },
): SavedTab[] {
	const p = normalizePrompt(prompt).toLowerCase();
	return list.map((t) => {
		if (normalizePrompt(t.prompt).toLowerCase() !== p) return t;
		const label =
			patch.label !== undefined
				? normalizePrompt(patch.label) || t.label
				: t.label;
		const mode: SavedTabMode =
			patch.mode === "scenes" ||
			patch.mode === "ocr" ||
			patch.mode === "dialogue"
				? patch.mode
				: "files";
		if (patch.watch === undefined) return { ...t, label, mode };
		if (patch.watch) return { ...t, label, mode, watch: true as const };
		const { watch: _omit, ...rest } = t;
		void _omit;
		return { ...rest, label, mode };
	});
}

/** Saved searches flagged as YouTube interests (watch:true). */
export function watchedInterests(list: SavedTab[]): SavedTab[] {
	return list.filter((t) => t.watch === true);
}

export function savedTabLabel(label: string, max = 24): string {
	return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}
