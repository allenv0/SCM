// Screenshot name signals — the vocabulary the Screenshot tab classifier
// matches against. Kept separate from categories.ts so the table can be read
// (and extended) without wading through the classification logic.
//
// Three match kinds, ordered by how they are matched:
//   STRONG_SUBSTRINGS  — case-insensitive "contains anywhere". Only phrases
//                        that are (near) unambiguous screenshot-speak qualify:
//                        full localized screencapture names, CJK words that
//                        filenames glue directly to dates ("截屏2024-01-15"),
//                        and unique tool brand names.
//   EXACT_TOKENS       — a whole separator-delimited token must equal the
//                        entry. Used for short/risky words ("scr" must not
//                        match "scratch.png"; "captura" must not match
//                        "capturaone.png").
//   TOKEN_SEQUENCES    — adjacent tokens ("screen shot", "screen grab"),
//                        covering the old macOS "Screen Shot 2018-…" names
//                        and hyphen/underscore variants.
//
// Localization sources: the default filename macOS screencapture writes per
// UI language, plus the Windows Snipping Tool / Win+PrintScreen names where
// they differ. Extend freely — every entry here only ever WIDENS recall of
// the Screenshots tab; the manual override is the safety net for the rest.

export const STRONG_SUBSTRINGS: readonly string[] = [
	// English (all script variants of the OS names)
	"screenshot",
	"screencapture",
	"screen capture",
	"screengrab",
	"screen grab",

	// macOS/Windows localized screencapture names (lowercase)
	"bildschirmfoto", // de
	"captura de pantalla", // es
	"capture d'écran", // fr (U+2019)
	"capture d'écran", // fr (ASCII apostrophe)
	"istantanea", // it
	"captura de tela", // pt-BR
	"captura de ecrã", // pt-PT
	"schermafbeelding", // nl
	"skärmbild", // sv
	"skjermbilde", // nb
	"skærmbillede", // da
	"kuvakaappaus", // fi
	"zrzut ekranu", // pl
	"snímek obrazovky", // cs
	"képernyőkép", // hu
	"ekran görüntüsü", // tr
	"снимок экрана", // ru
	"знімок екрана", // uk
	"στιγμιότυπο οθόνης", // el
	"captură de ecran", // ro
	"لقطة شاشة", // ar
	"צילום מסך", // he
	"ภาพหน้าจอ", // th
	"ảnh chụp màn hình", // vi
	"tangkapan layar", // id
	"スクリーンショット", // ja
	"스크린샷", // ko
	"화면 캡처", // ko (spaced)
	"화면캡처", // ko (fused)
	"截屏", // zh-CN (macOS glues the date straight on: 截屏2024-01-15…)
	"截圖", // zh-TW/HK
	"屏幕截圖", // zh alternate
	"屏幕截图", // zh-CN alternate

	// Third-party capture tools with distinctive brand names (unique enough
	// for substring matching; ShareX/Greenshot default to date-based names a
	// filename heuristic must never guess, so they are deliberately absent).
	"cleanshot", // CleanShot X
	"flameshot",
	"shottr",
	"xnip",
	"gyazo",
	"snipaste",
	"monosnap",
];

// Short or generic words that may ONLY match as a whole token. "scr" keeps
// the legacy abbreviation bucket (scr-settings.png, scr-2024.jpg) without
// dragging scratch.png/script.png back in.
export const EXACT_TOKENS: readonly string[] = [
	"scr",
	"snag", // Snagit's "Snag_2024-…"
	"captura", // bare macOS/Windows Spanish short form; generic as substring
	"capture", // bare macOS/Windows French short form; generic as substring
];

// Adjacent-token phrases (tokens split on separators): "Screen Shot 2018-…",
// "screen-shot.png", "my_screen_grab.jpg".
export const TOKEN_SEQUENCES: readonly string[][] = [
	["screen", "shot"],
	["screen", "grab"],
	["screen", "capture"],
];

// Original-path folder segments that mark a screenshot (Windows saves
// Win+PrintScreen captures to Pictures\Screenshots; users organize into
// "Screenshots" folders). Matched case-insensitively as a whole path
// segment. Deliberately NOT "Desktop" — macOS saves screenshots there but
// the Desktop holds every kind of file.
export const SCREENSHOT_FOLDER_SEGMENTS: readonly string[] = [
	"screenshots",
	"screenshot",
];
