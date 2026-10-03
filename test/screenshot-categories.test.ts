import { expect, test } from "bun:test";
import { getCategory } from "../src/lib/categories";

// The Screenshots tab's tiered classifier: override > filename tokens >
// import-time metadata hint > source folder segment. Every positive here is
// a real-world screenshot name on macOS/Windows; every negative is a file
// that the legacy `startsWith("scr")` rule wrongly classified.

test("filenames: screenshot token anywhere in the name", () => {
	for (const filename of [
		"Screenshot (3).png", // Windows Win+PrintScreen
		"screenshot_20240115-103045.png", // Android
		"Screenshot 2024-01-15 103045.png",
		"My screenshot.png",
		"2024-01-15 screenshot.png",
		"flutter-screenshot-1.png",
	]) {
		expect(getCategory({ filename })).toBe("Screenshots");
	}
});

test("filenames: legacy whole-token 'scr' abbreviation keeps working", () => {
	for (const filename of [
		"scr-settings.png",
		"scr 2024.png",
		"scr-2024-2048-game.jpg",
	]) {
		expect(getCategory({ filename })).toBe("Screenshots");
	}
});

test("filenames: old macOS 'Screen Shot' two-word names", () => {
	for (const filename of [
		"Screen Shot 2018-01-15 at 10.30.45 AM.png",
		"screen-shot.png",
		"my_screen_grab.jpg",
		"screencapture-01.png",
	]) {
		expect(getCategory({ filename })).toBe("Screenshots");
	}
});

test("filenames: localized screencapture names (macOS + Windows)", () => {
	for (const filename of [
		"Bildschirmfoto 2024-01-15 um 10.30.45.png", // de
		"Captura de pantalla 2024-01-15 a las 10.30.45.png", // es
		"Captura 2024-01-15.png", // es short form
		"Capture d'écran 2024-01-15 à 10.30.45.png", // fr (ASCII apostrophe)
		"Capture d’écran 2024-01-15 à 10.30.45.png", // fr (U+2019)
		"Capture 2024-01-15.png", // fr short form
		"Istantanea 2024-01-15 alle 10.30.45.png", // it
		"Captura de Tela 2024-01-15 às 10.30.45.png", // pt-BR
		"Schermafbeelding 2024-01-15 om 10.30.45.png", // nl
		"Skärmbild 2024-01-15 kl. 10.30.45.png", // sv
		"Skjermbilde 2024-01-15 kl 10.30.45.png", // nb
		"Kuvakaappaus 2024-01-15 klo 10.30.45.png", // fi
		"Zrzut ekranu 2024-01-15.png", // pl
		"Ekran görüntüsü 2024-01-15.png", // tr
		"Снимок экрана 2024-01-15 в 10.30.45.png", // ru
		"Знімок екрана 2024-01-15.png", // uk
		"スクリーンショット 2024-01-15 10.30.45.png", // ja
		"스크린샷 2024-01-15.png", // ko
		"화면 캡처 2024-01-15.png", // ko
		// macOS zh-CN glues the date straight onto the word — no separator.
		"截屏2024-01-15 上午10.30.45.png",
		"截圖20240115.png", // zh-TW
	]) {
		expect(getCategory({ filename })).toBe("Screenshots");
	}
});

test("filenames: third-party capture tool default names", () => {
	for (const filename of [
		"CleanShot 2024-01-15 at 10.30.45.png",
		"Snag_2024-01-15_103045.png", // Snagit
		"flameshot_2024-01-15.png",
		"gyazo-abc123.png",
		"Snipaste_2024-01-15.png",
		"monosnap design.png",
		"Xnip2024-01-15.png",
	]) {
		expect(getCategory({ filename })).toBe("Screenshots");
	}
});

test("filenames: scr- words are no longer false positives", () => {
	for (const filename of [
		"scratch.png",
		"scratchpad.jpg",
		"script-diagram.png",
		"scrabble-night.jpg",
		"scrum-board.jpg",
		"screaming-cat.jpg",
		"screens-for-sale.png",
		"ScrollWork.png",
		"capturaone.png",
	]) {
		expect(getCategory({ filename })).toBe("Projects");
	}
});

test("filenames: fused 'scr123' abbreviations are a documented miss", () => {
	// The prefix rule caught these; token matching does not. Accepted
	// tradeoff — covered by the metadata probe and the manual override.
	expect(getCategory({ filename: "scr123.png" })).toBe("Projects");
});

test("metadata hint wins for renamed screenshots", () => {
	expect(
		getCategory({
			filename: "vacation-day-3.png",
			screenshotHint: true,
		}),
	).toBe("Screenshots");
	// A probed-negative hint must not classify by itself.
	expect(
		getCategory({ filename: "vacation-day-3.png", screenshotHint: false }),
	).toBe("Projects");
	// null/absent = not yet probed (legacy row mid-backfill).
	expect(getCategory({ filename: "vacation.png", screenshotHint: null })).toBe(
		"Projects",
	);
});

test("source folder segment: …/Screenshots/ imports are screenshots", () => {
	for (const sourcePath of [
		"/Users/me/Pictures/Screenshots/IMG_0001.png", // macOS user folder
		"C:\\Users\\me\\Pictures\\Screenshots\\photo.png", // Windows default
		"/mnt/archive/screenshots/dump.png", // case-insensitive, singular
	]) {
		expect(getCategory({ filename: "photo.png", sourcePath })).toBe(
			"Screenshots",
		);
	}
});

test("source folder segment: Desktop is deliberately NOT a signal", () => {
	// macOS saves screenshots to the Desktop by default, but the Desktop
	// holds every kind of file.
	expect(
		getCategory({
			filename: "photo.png",
			sourcePath: "/Users/me/Desktop/photo.png",
		}),
	).toBe("Projects");
});

test("manual override beats every automatic signal", () => {
	expect(
		getCategory({
			filename: "Screenshot (1).png",
			screenshotHint: true,
			sourcePath: "/x/Screenshots/a.png",
			override: "Projects",
		}),
	).toBe("Projects");
	expect(
		getCategory({ filename: "random-holiday.png", override: "Screenshots" }),
	).toBe("Screenshots");
});
