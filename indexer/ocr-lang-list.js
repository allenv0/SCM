"use strict";

// Canonical OCR language table — the SINGLE source of truth for every
// allowlist in the OCR pipeline. Plain Node (no Electron, no TS) so all
// three main-process consumers can require it directly:
//   - indexer/ocr-worker.js (tesseract language string)
//   - main-lib/settings.js (parse/validate/resolve)
//   - main.js (set-ocr-langs IPC validation)
// The renderer's src/lib/ocrLangs.ts mirrors this table in TS (it cannot
// import across the bundle boundary); test/cjk-tokens.test.ts asserts the
// two stay identical (ids, order, defaults, labels), so drift fails loudly.
//
// English is always on (locked) and is NOT in this table. Everything here is
// a settings toggle. Order is canonical: it defines the tesseract language
// string order ("eng+chi_sim+..."), so a settings reorder never restarts
// work — only membership changes do. Append new languages at the end of
// their group; never reorder existing entries (a reorder rewrites every
// library's ocrLangs stamp and triggers a full re-OCR).
//
// Sizes are tessdata_fast approximations for the Settings blurbs, not exact.

const OCR_LANG_GROUPS = [
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

// Flat id list in canonical order (derived — the ordering `resolve*`
// functions must use).
const OCR_LANG_IDS = OCR_LANG_GROUPS.flatMap((g) => g.langs.map((l) => l.id));

// Default selection: the CJK set (fresh-install behavior since the CJK
// rollout). Everything else is opt-in — each extra model slows background
// recognition, so the default stays at five.
const DEFAULT_OCR_LANGS = ["chi_sim", "chi_tra", "jpn", "kor"];

const OCR_LANG_BY_ID = Object.fromEntries(
	OCR_LANG_GROUPS.flatMap((g) => g.langs.map((l) => [l.id, l])),
);

module.exports = {
	OCR_LANG_GROUPS,
	OCR_LANG_IDS,
	OCR_LANG_BY_ID,
	DEFAULT_OCR_LANGS,
};
