/**
 * App-icon catalog for Settings → Appearance → App Icon.
 * The 6 variants live as 1024×1024 PNGs in public/images/app-icons/
 * (padded to 832 content + 96 transparent margin so Dock size matches
 * HIG). Renderer references them at /images/app-icons/<id>.png
 * (vite copies public/ → dist/, and the app:// handler serves from dist/).
 * Main process loads from disk (fs, asar-aware) via candidates:
 *   dist/images/app-icons/ and public/images/app-icons/. Originals kept
 *   in assets/original-app-icons/.
 */
export const APP_ICON_IDS = [
	"scm-vhs",
	"scm-vhs-player",
	"scm-kodak",
	"scm-bot",
	"vh1",
	"vh2",
] as const;

export type AppIconId = (typeof APP_ICON_IDS)[number];

export const DEFAULT_APP_ICON: AppIconId = "scm-vhs"; // VHS — Retro tape (default for new installs)

export interface AppIconInfo {
	id: AppIconId;
	label: string;
	blurb: string;
	/** Filename without extension, e.g. "scm-vhs" → scm-vhs.png */
	file: string;
}

export const APP_ICONS: AppIconInfo[] = [
	{ id: "scm-vhs", label: "VHS", blurb: "Retro tape", file: "scm-vhs" },
	{
		id: "scm-vhs-player",
		label: "VHS Player",
		blurb: "Player deck",
		file: "scm-vhs-player",
	},
	{ id: "scm-kodak", label: "Kodak", blurb: "Film stock", file: "scm-kodak" },
	{ id: "scm-bot", label: "Bot", blurb: "Neutral bot", file: "scm-bot" },
	{ id: "vh1", label: "Matrix Green", blurb: "Green dots", file: "vh1" },
	{ id: "vh2", label: "Matrix Blue", blurb: "Blue dots", file: "vh2" },
];

export function parseAppIcon(value: unknown): AppIconId {
	if (
		typeof value === "string" &&
		(APP_ICON_IDS as readonly string[]).includes(value)
	) {
		return value as AppIconId;
	}
	return DEFAULT_APP_ICON;
}

export function appIconInfo(id: AppIconId): AppIconInfo {
	return APP_ICONS.find((i) => i.id === id) ?? APP_ICONS[0];
}

/** Renderer-side URL for preview <img src>. */
export function appIconUrl(id: AppIconId): string {
	return `/images/app-icons/${id}.png`;
}
