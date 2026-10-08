// Built-in tab registry (Settings → Smart Tabs): which browse tabs exist,
// which are always on, and which the user can toggle. Pure helpers live
// here so storage parsing and visibility filtering are unit-testable
// without a DOM.
//
// Today the toggleable set is Screenshots + Email + YouTube (all default
// ON, so existing installs see no change). Future smart tabs (Documents,
// Receipts, …) join by adding one entry + one detector — the tab bar,
// ghost-tab guard, reserved-name guard, and Settings UI all read this
// registry, so no per-tab wiring is needed.

export type BuiltInTabId =
	"All" | "Videos" | "Screenshots" | "Email" | "YouTube";

export type BuiltInTabKind = "all" | "exclusive" | "overlapping";

export interface BuiltInTabInfo {
	readonly id: BuiltInTabId;
	readonly label: string;
	/** One-line Settings copy explaining what the tab shows. */
	readonly blurb: string;
	/** True for All/Videos: rendered always, never toggleable. */
	readonly alwaysOn: boolean;
	/** Initial visibility for toggleable tabs (fresh installs + upgrades). */
	readonly defaultOn: boolean;
	readonly kind: BuiltInTabKind;
}

export const BUILT_IN_TABS: readonly BuiltInTabId[] = [
	"All",
	"Videos",
	"Screenshots",
	"Email",
	"YouTube",
] as const;

export const BUILT_IN_TAB_INFO: Record<BuiltInTabId, BuiltInTabInfo> = {
	All: {
		id: "All",
		label: "All",
		blurb: "Full library — every photo and video. Always on.",
		alwaysOn: true,
		defaultOn: true,
		kind: "all",
	},
	Videos: {
		id: "Videos",
		label: "Videos",
		blurb: "Video files by extension, with scene search. Always on.",
		alwaysOn: true,
		defaultOn: true,
		kind: "exclusive",
	},
	Screenshots: {
		id: "Screenshots",
		label: "Screenshots",
		blurb:
			"Screen captures — filename vocabulary, import-time metadata probe, source folder, or your manual override.",
		alwaysOn: false,
		defaultOn: true,
		kind: "exclusive",
	},
	Email: {
		id: "Email",
		label: "Email",
		blurb:
			"Photos whose visible OCR text contains an email address. Overlapping view — items keep their category too.",
		alwaysOn: false,
		defaultOn: true,
		kind: "overlapping",
	},
	YouTube: {
		id: "YouTube",
		label: "YouTube",
		blurb:
			"Videos downloaded with yt-dlp. Overlapping view — items stay under Videos too.",
		alwaysOn: false,
		defaultOn: true,
		kind: "overlapping",
	},
};

/** Toggleable subset in tab-bar order — what Settings → Smart Tabs lists. */
export const TOGGLEABLE_TABS: readonly BuiltInTabId[] = BUILT_IN_TABS.filter(
	(id) => !BUILT_IN_TAB_INFO[id].alwaysOn,
);

export const ENABLED_TABS_KEY = "memories-enabled-tabs";

export function isBuiltInTab(id: string): id is BuiltInTabId {
	return (BUILT_IN_TABS as readonly string[]).includes(id);
}

export function isAlwaysOn(id: string): boolean {
	return isBuiltInTab(id) && BUILT_IN_TAB_INFO[id].alwaysOn;
}

/**
 * Parse a persisted enabled-set into a valid Set. The canonical shape is
 * a record ({ Screenshots: true, Email: false }); a plain array of ids
 * (["Screenshots"]) is also accepted defensively. Unknown ids are
 * dropped, always-on tabs are forced on, and a toggleable tab missing
 * from the record backfills to its defaultOn — so a newly shipped tab
 * appears ON for existing installs, while an explicit false stays off.
 * Corrupt storage falls back to all-defaults (never a blank bar).
 */
export function parseEnabledTabs(raw: unknown): Set<string> {
	const defaults = new Set<string>(
		BUILT_IN_TABS.filter(
			(id) => BUILT_IN_TAB_INFO[id].alwaysOn || BUILT_IN_TAB_INFO[id].defaultOn,
		),
	);
	if (raw === null || raw === undefined) return defaults;
	if (Array.isArray(raw)) {
		if (raw.length === 0) return defaults;
		const out = new Set<string>();
		for (const entry of raw) {
			if (typeof entry === "string" && isBuiltInTab(entry)) out.add(entry);
		}
		for (const id of BUILT_IN_TABS) {
			if (BUILT_IN_TAB_INFO[id].alwaysOn) out.add(id);
		}
		return out.size === 0 ? defaults : out;
	}
	if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		const out = new Set<string>();
		for (const id of BUILT_IN_TABS) {
			const info = BUILT_IN_TAB_INFO[id];
			if (info.alwaysOn) {
				out.add(id);
				continue;
			}
			const v = obj[id];
			if (typeof v === "boolean") {
				if (v) out.add(id);
			} else if (info.defaultOn) {
				out.add(id);
			}
		}
		return out.size === 0 ? defaults : out;
	}
	return defaults;
}

export function readStoredEnabledTabs(): Set<string> {
	try {
		const raw = localStorage.getItem(ENABLED_TABS_KEY);
		if (!raw) return parseEnabledTabs(null);
		return parseEnabledTabs(JSON.parse(raw));
	} catch {
		// Storage unavailable or corrupt — session still gets defaults.
		return parseEnabledTabs(null);
	}
}

export function writeStoredEnabledTabs(enabled: Set<string>): void {
	try {
		// Record shape (not an id list) so a tab shipped later backfills to
		// its defaultOn instead of reading as "user turned it off".
		const record: Record<string, boolean> = {};
		for (const id of TOGGLEABLE_TABS) record[id] = enabled.has(id);
		localStorage.setItem(ENABLED_TABS_KEY, JSON.stringify(record));
	} catch {
		// Persisting is best-effort; the session still uses the new set.
	}
}

/** Visible built-ins in tab-bar order for the current enabled-set. */
export function visibleBuiltInTabs(enabled: Set<string>): BuiltInTabId[] {
	return BUILT_IN_TABS.filter(
		(id) => BUILT_IN_TAB_INFO[id].alwaysOn || enabled.has(id),
	);
}
