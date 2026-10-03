// OCR text-language preference (Settings → Photo Search → Text languages):
// which tesseract traineddata files the OCR worker loads. English is always
// on (locked); every other entry is a toggle. Pure helpers live here so
// parsing is unit-testable without a DOM or IPC bridge.
//
// MIRROR WARNING: this table duplicates indexer/ocr-lang-list.js (the plain-JS
// single source of truth the worker, settings.js and main.js require). The
// renderer cannot import across the bundle boundary, so the copy is
// deliberate — and test/cjk-tokens.test.ts asserts the two stay identical
// (ids, order, defaults, labels). When adding a language, add it in BOTH
// files (append at the end of its group — never reorder: a reorder rewrites
// every library's ocrLangs stamp and triggers a full re-OCR).

export type OcrLangId =
	| "chi_sim"
	| "chi_tra"
	| "jpn"
	| "kor"
	| "fra"
	| "deu"
	| "spa"
	| "por"
	| "ita"
	| "nld"
	| "swe"
	| "dan"
	| "nor"
	| "fin"
	| "pol"
	| "ces"
	| "ron"
	| "hun"
	| "hrv"
	| "slk"
	| "slv"
	| "lit"
	| "lav"
	| "est"
	| "tur"
	| "rus"
	| "ukr"
	| "bul"
	| "srp"
	| "ell"
	| "ara"
	| "heb"
	| "hin"
	| "vie"
	| "ind";

export interface OcrLangInfo {
	id: OcrLangId;
	label: string;
	native: string;
	size: string;
}

export interface OcrLangGroup {
	id: string;
	label: string;
	langs: OcrLangInfo[];
}

export const OCR_LANG_GROUPS: OcrLangGroup[] = [
	{
		id: "cjk",
		label: "Chinese, Japanese & Korean",
		langs: [
			{
				id: "chi_sim",
				label: "Simplified Chinese",
				native: "简体中文",
				size: "~2.4MB",
			},
			{
				id: "chi_tra",
				label: "Traditional Chinese",
				native: "繁體中文",
				size: "~2.4MB",
			},
			{ id: "jpn", label: "Japanese", native: "日本語", size: "~2.7MB" },
			{ id: "kor", label: "Korean", native: "한국어", size: "~2.5MB" },
		],
	},
	{
		id: "western",
		label: "Western Europe",
		langs: [
			{ id: "fra", label: "French", native: "Français", size: "~4MB" },
			{ id: "deu", label: "German", native: "Deutsch", size: "~4MB" },
			{ id: "spa", label: "Spanish", native: "Español", size: "~4MB" },
			{ id: "por", label: "Portuguese", native: "Português", size: "~4MB" },
			{ id: "ita", label: "Italian", native: "Italiano", size: "~4MB" },
			{ id: "nld", label: "Dutch", native: "Nederlands", size: "~4MB" },
			{ id: "swe", label: "Swedish", native: "Svenska", size: "~4MB" },
			{ id: "dan", label: "Danish", native: "Dansk", size: "~4MB" },
			{ id: "nor", label: "Norwegian", native: "Norsk", size: "~4MB" },
			{ id: "fin", label: "Finnish", native: "Suomi", size: "~4MB" },
		],
	},
	{
		id: "central",
		label: "Central & Eastern Europe",
		langs: [
			{ id: "pol", label: "Polish", native: "Polski", size: "~4MB" },
			{ id: "ces", label: "Czech", native: "Čeština", size: "~4MB" },
			{ id: "ron", label: "Romanian", native: "Română", size: "~4MB" },
			{ id: "hun", label: "Hungarian", native: "Magyar", size: "~4MB" },
			{ id: "hrv", label: "Croatian", native: "Hrvatski", size: "~4MB" },
			{ id: "slk", label: "Slovak", native: "Slovenčina", size: "~4MB" },
			{ id: "slv", label: "Slovenian", native: "Slovenščina", size: "~4MB" },
			{ id: "lit", label: "Lithuanian", native: "Lietuvių", size: "~4MB" },
			{ id: "lav", label: "Latvian", native: "Latviešu", size: "~4MB" },
			{ id: "est", label: "Estonian", native: "Eesti", size: "~4MB" },
			{ id: "tur", label: "Turkish", native: "Türkçe", size: "~4MB" },
		],
	},
	{
		id: "cyrillic",
		label: "Cyrillic & Greek",
		langs: [
			{ id: "rus", label: "Russian", native: "Русский", size: "~4MB" },
			{ id: "ukr", label: "Ukrainian", native: "Українська", size: "~4MB" },
			{ id: "bul", label: "Bulgarian", native: "Български", size: "~4MB" },
			{ id: "srp", label: "Serbian", native: "Српски", size: "~4MB" },
			{ id: "ell", label: "Greek", native: "Ελληνικά", size: "~4MB" },
		],
	},
	{
		id: "asia",
		label: "Middle East & Asia",
		langs: [
			{ id: "ara", label: "Arabic", native: "العربية", size: "~4MB" },
			{ id: "heb", label: "Hebrew", native: "עברית", size: "~4MB" },
			{ id: "hin", label: "Hindi", native: "हिन्दी", size: "~4MB" },
			{ id: "vie", label: "Vietnamese", native: "Tiếng Việt", size: "~5MB" },
			{
				id: "ind",
				label: "Indonesian",
				native: "Bahasa Indonesia",
				size: "~4MB",
			},
		],
	},
];

export const OCR_LANG_IDS: OcrLangId[] = OCR_LANG_GROUPS.flatMap((g) =>
	g.langs.map((l) => l.id),
);

/** Default: eng (locked) + the CJK set. Everything else is opt-in — each
 *  extra model slows background recognition. */
export const DEFAULT_OCR_LANGS: OcrLangId[] = [
	"chi_sim",
	"chi_tra",
	"jpn",
	"kor",
];

export const OCR_LANG_LABELS: Record<OcrLangId, string> = Object.fromEntries(
	OCR_LANG_GROUPS.flatMap((g) => g.langs.map((l) => [l.id, l.label])),
) as Record<OcrLangId, string>;

export const OCR_LANG_BLURBS: Record<OcrLangId, string> = Object.fromEntries(
	OCR_LANG_GROUPS.flatMap((g) =>
		g.langs.map((l) => [l.id, `${l.native} · ${l.size}`]),
	),
) as Record<OcrLangId, string>;

/** Parse a stored/bridge value into a valid selection. Unknown entries
 *  are dropped; a non-array falls back to the default so a hand-edited
 *  settings.json can never break the OCR queue. An explicitly empty array
 *  is honored (eng-only). */
export function parseOcrLangs(raw: unknown): OcrLangId[] {
	if (!Array.isArray(raw)) return [...DEFAULT_OCR_LANGS];
	const ids = new Set<OcrLangId>(OCR_LANG_IDS);
	const out: OcrLangId[] = [];
	for (const entry of raw) {
		if (typeof entry === "string" && ids.has(entry as OcrLangId)) {
			const id = entry as OcrLangId;
			if (!out.includes(id)) out.push(id);
		}
	}
	return out;
}

/** The tesseract language string: eng always first, then the enabled models
 *  in canonical order (e.g. "eng+chi_sim+chi_tra+jpn+kor"). */
export function resolveOcrLangString(enabled: readonly OcrLangId[]): string {
	const ordered = OCR_LANG_IDS.filter((id) => enabled.includes(id));
	return ["eng", ...ordered].join("+");
}

/** True when two selections resolve to the same worker language string. */
export function sameOcrLangs(
	a: readonly OcrLangId[],
	b: readonly OcrLangId[],
): boolean {
	return resolveOcrLangString(a) === resolveOcrLangString(b);
}
