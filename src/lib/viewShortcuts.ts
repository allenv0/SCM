// View shortcuts (Settings → Keyboard): the five semantic library views
// behind Cmd+1–5, each pairing a category tab with a search mode. Pure
// helpers live here so storage parsing, key normalization, and conflict
// detection are unit-testable without a DOM.
//
// The accelerator format matches Electron ("CommandOrControl+Shift+3") —
// the same strings ShortcutPanel records for the global focus shortcut —
// so one normalization function serves both the recorder and the matcher.
// A recorded combo that duplicates another view or hits the reserved list
// is refused at record time; hand-edited storage falls back per-entry.

export type ViewId =
	| "all-files"
	| "videos-scenes"
	| "screenshots-ocr"
	| "all-llms"
	| "videos-dialogue";

export const VIEW_IDS: ViewId[] = [
	"all-files",
	"videos-scenes",
	"screenshots-ocr",
	"all-llms",
	"videos-dialogue",
];

/** Display label per view (the combined tab + mode it activates). */
export const VIEW_LABELS: Record<ViewId, string> = {
	"all-files": "All tab + Files search",
	"videos-scenes": "Videos tab + Scenes search",
	"screenshots-ocr": "Screenshots tab + OCR search",
	"all-llms": "All tab + LLMs chat",
	"videos-dialogue": "Videos tab + Dialogue search",
};

/** One-line description for the Keyboard editor rows. */
export const VIEW_DESCRIPTIONS: Record<ViewId, string> = {
	"all-files": "Home — full library, whole-file ranking",
	"videos-scenes": "Exact moments inside videos, by sight",
	"screenshots-ocr": "Visible text on screenshots and posters",
	"all-llms": "Answered from library text and speech",
	"videos-dialogue": "Exact moments by what is said",
};

export type ViewShortcuts = Record<ViewId, string>;

export const VIEW_SHORTCUTS_KEY = "scm-view-shortcuts";

export const DEFAULT_VIEW_SHORTCUTS: ViewShortcuts = {
	"all-files": "CommandOrControl+1",
	"videos-scenes": "CommandOrControl+2",
	"screenshots-ocr": "CommandOrControl+3",
	"all-llms": "CommandOrControl+4",
	"videos-dialogue": "CommandOrControl+5",
};

// In-app combos that already mean something else (App's Cmd+, / Cmd+I,
// the File → Import menu's Cmd+O) or belong to the OS/window chrome
// (Quit, Close, Hide). Recording one of these is refused with a message
// naming the owner; matching never consults this list (a hand-edited
// duplicate still dispatches — deterministically, first view wins).
export const RESERVED_VIEW_SHORTCUTS: Record<string, string> = {
	"CommandOrControl+,": "Settings (⌘,)",
	"CommandOrControl+I": "Import / AI Insights (⌘I)",
	"CommandOrControl+O": "Import photos menu (⌘O)",
	"CommandOrControl+Q": "Quit",
	"CommandOrControl+W": "Close window",
	"CommandOrControl+H": "Hide",
};

/** Canonical key token for an accelerator: mirrors the recorder below. */
function canonicalKeyToken(key: string): string {
	let k = key;
	if (k === " ") k = "Space";
	else if (k === "ArrowUp") k = "Up";
	else if (k === "ArrowDown") k = "Down";
	else if (k === "ArrowLeft") k = "Left";
	else if (k === "ArrowRight") k = "Right";
	else if (k === "Escape") k = "Escape";
	else if (k === "Enter") k = "Enter";
	else if (k === "Backspace") k = "Backspace";
	else if (k === "Delete") k = "Delete";
	else if (k === "Tab") k = "Tab";
	if (k.length === 1) k = k.toUpperCase();
	return k;
}

/**
 * Build an Electron accelerator string from a keydown event — the SINGLE
 * normalization both the Settings recorder and the grid matcher use, so
 * the two can never drift apart. Returns null when the combo is
 * incomplete (no modifier held), a bare modifier press, or a repeat.
 */
export function eventToAccelerator(e: {
	repeat: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
}): string | null {
	if (e.repeat) return null;
	// Must have at least one modifier.
	if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
	// Ignore bare modifier presses.
	if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
	const parts: string[] = [];
	if (e.metaKey) parts.push("CommandOrControl");
	if (e.ctrlKey) parts.push("Control");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");
	parts.push(canonicalKeyToken(e.key));
	return parts.join("+");
}

/**
 * Convert an Electron accelerator string into a human-friendly display
 * (e.g. "CommandOrControl+Shift+Space" → "⌘⇧ Space").
 */
export function displayShortcut(accel: string): string {
	return accel
		.replace(/CommandOrControl/gi, "⌘")
		.replace(/Command/gi, "⌘")
		.replace(/Control/gi, "Ctrl")
		.replace(/Alt/gi, "⌥")
		.replace(/Shift/gi, "⇧")
		.replace(/\+/g, " ");
}

/** Structural check: at least one modifier + a key token. */
function isAcceleratorShape(accel: string): boolean {
	const parts = accel.split("+");
	if (parts.length < 2) return false;
	const mods = parts.slice(0, -1);
	const key = parts[parts.length - 1];
	if (key.length === 0) return false;
	return mods.every((m) =>
		["CommandOrControl", "Command", "Control", "Alt", "Shift"].includes(m),
	);
}

/**
 * Parse stored view shortcuts into a valid map; any invalid, missing, or
 * non-string entry falls back to its default, so hand edits and older
 * storage shapes can never break dispatch.
 */
export function parseViewShortcuts(raw: unknown): ViewShortcuts {
	const out = { ...DEFAULT_VIEW_SHORTCUTS };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	const obj = raw as Record<string, unknown>;
	for (const id of VIEW_IDS) {
		const v = obj[id];
		if (typeof v === "string" && isAcceleratorShape(v)) out[id] = v;
	}
	return out;
}

export function readStoredViewShortcuts(): ViewShortcuts {
	try {
		const raw = localStorage.getItem(VIEW_SHORTCUTS_KEY);
		if (!raw) return { ...DEFAULT_VIEW_SHORTCUTS };
		return parseViewShortcuts(JSON.parse(raw));
	} catch {
		// Storage unavailable or corrupt — session still gets defaults.
		return { ...DEFAULT_VIEW_SHORTCUTS };
	}
}

export function writeStoredViewShortcuts(map: ViewShortcuts): void {
	try {
		localStorage.setItem(VIEW_SHORTCUTS_KEY, JSON.stringify(map));
	} catch {
		// Persisting is best-effort; the session still uses the new map.
	}
}

/** Does this keydown event equal the stored accelerator? */
export function matchAccelerator(
	e: {
		repeat: boolean;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		key: string;
	},
	accel: string,
): boolean {
	const built = eventToAccelerator(e);
	return built !== null && built === accel;
}

/** Views sharing one combo (each group has 2+ ids); empty when clean. */
export function findDuplicateViews(map: ViewShortcuts): ViewId[][] {
	const byAccel = new Map<string, ViewId[]>();
	for (const id of VIEW_IDS) {
		const list = byAccel.get(map[id]) ?? [];
		list.push(id);
		byAccel.set(map[id], list);
	}
	return [...byAccel.values()].filter((g) => g.length > 1);
}
