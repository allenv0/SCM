"use strict";

// Design-review screenshot matrix (ELECTRON_SMOKE_UI_REVIEW=1).
// Boots an isolated MEMORIES_DATA_DIR, captures the empty state, seeds a
// small varied-aspect library (no CLIP — browse-only index like the grid
// fixture), then walks dark/light × key surfaces into review-screenshots/.
//
// Screenshots land under $SCM_REVIEW_SHOTS or <repo>/review-screenshots.

const fs = require("fs");
const path = require("path");

const SECTIONS = [
	"Library",
	"Appearance",
	"Grid",
	"Smart Tabs",
	"Photo Search",
	"Video Search",
	"LLMs Chat",
	"Global Shortcut",
	"Keyboard",
	"Menu Bar",
];

async function runUiReview(ctx) {
	const { win, loadLibrary, resetLibraryCaches } = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	if (!win) throw new Error("no window");

	const shotDir =
		process.env.SCM_REVIEW_SHOTS ||
		path.join(process.cwd(), "review-screenshots");
	fs.mkdirSync(shotDir, { recursive: true });

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const js = (code) => win.webContents.executeJavaScript(code);

	async function waitFor(label, expr, timeoutMs = 30000) {
		const deadline = Date.now() + timeoutMs;
		let last = false;
		while (Date.now() < deadline) {
			last = await js(expr).catch(() => false);
			if (last) return last;
			await sleep(250);
		}
		throw new Error(
			`timeout waiting for ${label} (last: ${JSON.stringify(last)})`,
		);
	}

	async function shot(name) {
		// Let React paint + CSS transitions settle a frame.
		await sleep(350);
		const img = await win.webContents.capturePage();
		const file = path.join(shotDir, `${name}.png`);
		await fs.promises.writeFile(file, img.toPNG());
		console.log(`[ui-review] → ${file}`);
	}

	async function setTheme(theme) {
		// Mirror useTheme.applyTheme + persistence without needing Settings open.
		await js(`
			(() => {
				const dark = ${JSON.stringify(theme)} === "dark";
				try { localStorage.setItem("scm-theme", ${JSON.stringify(theme)}); } catch {}
				document.documentElement.classList.toggle("dark", dark);
				document.documentElement.classList.toggle("light", !dark);
			})()
		`);
		await sleep(200);
	}

	async function closeDialogs() {
		await js(`
			(() => {
				const close = document.querySelector('[aria-label="Close settings"]');
				if (close) close.click();
				const esc = (el) => el && el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
				esc(document.activeElement || document.body);
			})()
		`);
		await sleep(250);
		// Second Escape closes lightbox / model picker if open.
		await js(`
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		`);
		await sleep(200);
	}

	// ── 1. Empty state (library not seeded yet) ─────────────────────────
	// Wait until the app has settled into EITHER the empty state or a grid
	// (a previous partial run could leave rows in the temp dir).
	const bootSettled = await waitFor(
		"empty state or search bar",
		`document.body.innerText.includes('No memories yet')
			|| !!document.querySelector('input[aria-label="Search memories"]')`,
		45000,
	).catch(() => false);
	const emptyReady = await js(
		`document.body.innerText.includes('No memories yet')`,
	).catch(() => false);
	void bootSettled;

	await setTheme("dark");
	if (emptyReady) await shot("01-empty-dark");
	await setTheme("light");
	if (emptyReady) await shot("02-empty-light");
	await setTheme("dark");
	if (!emptyReady) {
		console.warn("[ui-review] empty state not visible — skipping 01/02");
	}

	// ── 2. Seed a small varied-aspect library (browse-only) ─────────────
	await seedLibrary({
		win,
		loadLibrary,
		resetLibraryCaches,
		js,
		waitFor,
		sleep,
	});
	await sleep(600);
	await waitFor(
		"grid + search bar",
		`!!document.querySelector('input[aria-label="Search memories"]')`,
		30000,
	);
	// Wait for tiles to paint.
	await waitFor(
		"memory tiles",
		`document.querySelectorAll('img[alt^="Memory:"]').length > 0`,
		20000,
	).catch(() =>
		console.warn("[ui-review] no tiles yet — grid shot may be sparse"),
	);

	// ── 3. Grid + chrome, dark then light ───────────────────────────────
	await setTheme("dark");
	await shot("03-grid-dark");

	// Search modes row (Files / Scenes / OCR / …) is part of the grid header;
	// OCR mode on shows the mode-pill selected treatment.
	await js(`
		(() => {
			const b = document.querySelector('button[aria-label="OCR search mode"]');
			if (b) b.click();
			return Boolean(b);
		})()
	`);
	await sleep(500);
	await shot("04-mode-pills-ocr-dark");
	// Back to Files for subsequent shots.
	await js(`
		(() => {
			const b = document.querySelector('button[aria-label="File search mode"]');
			if (b) b.click();
		})()
	`);
	await sleep(300);

	await setTheme("light");
	await shot("05-grid-light");
	await setTheme("dark");

	// ── 4. Settings sections (dark) + Appearance (light) ────────────────
	await js(`document.querySelector('button[title="Settings (⌘,)"]')?.click()`);
	await waitFor(
		"settings dialog",
		`!!document.querySelector('[role="dialog"][aria-label="Settings"]')`,
	);

	for (const label of SECTIONS) {
		await js(`
			(() => {
				const btn = [...document.querySelectorAll('[aria-label="Settings sections"] button')]
					.find(b => b.textContent.trim() === ${JSON.stringify(label)});
				if (btn) btn.click();
				return Boolean(btn);
			})()
		`);
		await sleep(350);
		const slug = label.toLowerCase().replace(/\s+/g, "-");
		await shot(`06-settings-${slug}-dark`);
	}

	// Appearance under light theme (theme radios + light shell).
	await js(`
		(() => {
			const btn = [...document.querySelectorAll('[aria-label="Settings sections"] button')]
				.find(b => b.textContent.trim() === 'Appearance');
			if (btn) btn.click();
		})()
	`);
	await sleep(300);
	await setTheme("light");
	await shot("07-settings-appearance-light");
	await setTheme("dark");

	// ── 5. LLMs Chat panel detail (already on ai section if we re-click) ─
	await js(`
		(() => {
			const btn = [...document.querySelectorAll('[aria-label="Settings sections"] button')]
				.find(b => b.textContent.trim() === 'LLMs Chat');
			if (btn) btn.click();
		})()
	`);
	await sleep(350);
	await shot("08-settings-llms-chat-dark");

	await closeDialogs();

	// ── 6. Model picker ─────────────────────────────────────────────────
	await js(
		`document.querySelector('button[aria-haspopup="listbox"]')?.click()`,
	);
	const pickerOpen = await waitFor(
		"model picker",
		`!!document.querySelector('[role="listbox"][aria-label="AI model"]')`,
		8000,
	).catch(() => false);
	if (pickerOpen) await shot("09-model-picker-dark");
	await js(`
		document.querySelector('[aria-label="Close model picker"]')?.click();
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	`);
	await sleep(300);

	// ── 7. Save-as-tab dialog ───────────────────────────────────────────
	await js(`
		(() => {
			const input = document.querySelector('input[aria-label="Search memories"]');
			if (!input) return false;
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			setter.call(input, 'sunset walk');
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		})()
	`);
	await sleep(500);
	await js(
		`document.querySelector('button[aria-label="Save this search as a tab"]')?.click()`,
	);
	const saveOpen = await waitFor(
		"save-tab dialog",
		`!!document.querySelector('[aria-label="Name this tab"]')`,
		5000,
	).catch(() => false);
	if (saveOpen) await shot("10-save-tab-dialog-dark");
	// Cancel without persisting a junk tab.
	await js(`
		(() => {
			const d = document.querySelector('[aria-label="Name this tab"]');
			if (!d) return;
			const backdrop = d.parentElement?.querySelector('.absolute.inset-0');
			if (backdrop) backdrop.click();
			else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		})()
	`);
	await sleep(300);
	await js(`
		(() => {
			const clear = document.querySelector('button[aria-label="Clear search"]');
			if (clear) clear.click();
		})()
	`);
	await sleep(300);

	// ── 8. Context menu on a tile ───────────────────────────────────────
	await js(`
		(() => {
			const card = document.querySelector('img[alt^="Memory:"]')?.closest('.group')
				|| document.querySelector('img[alt^="Memory:"]')?.parentElement;
			if (!card) return false;
			const rect = card.getBoundingClientRect();
			const ev = new MouseEvent('contextmenu', {
				bubbles: true, cancelable: true, view: window,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
				button: 2,
			});
			card.dispatchEvent(ev);
			return true;
		})()
	`);
	const menuOpen = await waitFor(
		"context menu",
		`!!document.querySelector('[aria-label="Tile actions"]')`,
		4000,
	).catch(() => false);
	if (menuOpen) await shot("11-context-menu-dark");
	await js(`
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	`);
	await sleep(250);

	// ── 9. Lightbox + AI insights ───────────────────────────────────────
	await js(`
		(() => {
			const img = document.querySelector('img[alt^="Memory:"]');
			if (!img) return false;
			img.click();
			return true;
		})()
	`);
	const lightboxOpen = await waitFor(
		"lightbox",
		`!!document.querySelector('button[aria-label="Close"]')`,
		6000,
	).catch(() => false);
	if (lightboxOpen) {
		await shot("12-lightbox-dark");
		// Cmd+I toggles AI insights while lightbox is open.
		await js(`
			window.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'i', metaKey: true, bubbles: true, cancelable: true,
			}));
			document.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'i', metaKey: true, bubbles: true, cancelable: true,
			}));
		`);
		await sleep(700);
		await shot("13-ai-insights-dark");
		await js(`
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		`);
		await sleep(400);
	}

	// ── 10. Drop overlay ────────────────────────────────────────────────
	await js(`
		(() => {
			const dt = new DataTransfer();
			window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
			window.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		})()
	`);
	await sleep(400);
	const dropShown = await js(
		`document.body.innerText.includes('Drop photos or folders')`,
	).catch(() => false);
	if (dropShown) await shot("14-drop-overlay-dark");
	await js(`
		(() => {
			const dt = new DataTransfer();
			window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
			window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		})()
	`);
	await sleep(300);

	// ── 11. Narrow window (min width) ───────────────────────────────────
	const bounds = win.getBounds();
	try {
		win.setBounds({ ...bounds, width: 900, height: 700 });
		await sleep(600);
		await shot("15-narrow-900-dark");
	} catch (err) {
		console.warn("[ui-review] narrow resize failed:", err.message);
	}

	// ── Summary ─────────────────────────────────────────────────────────
	const files = fs
		.readdirSync(shotDir)
		.filter((f) => f.endsWith(".png"))
		.sort();
	console.log(`[ui-review] ${files.length} screenshots in ${shotDir}`);
	console.log("[ui-review] OK");
}

// Varied solid JPEGs + index/bin headers — same contract as
// scripts/perf-grid-fixture.js, but small N and mixed aspect ratios so the
// masonry layout is actually exercised.
async function seedLibrary({
	win,
	loadLibrary,
	resetLibraryCaches,
	js,
	waitFor,
	sleep,
}) {
	const memoriesDir = process.env.MEMORIES_DATA_DIR;
	const n = Number(process.env.SCM_REVIEW_GRID_N || 72);
	const dataDir = path.join(memoriesDir, "library");
	const photosDir = path.join(dataDir, "photos");
	fs.mkdirSync(photosDir, { recursive: true });

	const sharp = (await import("sharp")).default;
	// Portrait / landscape / square ladder — enough variety for columns.
	const shapes = [
		{ width: 240, height: 320 },
		{ width: 320, height: 240 },
		{ width: 280, height: 280 },
		{ width: 200, height: 360 },
		{ width: 360, height: 200 },
	];
	const palettes = [
		[180, 90, 70],
		[70, 120, 180],
		[90, 160, 100],
		[160, 130, 70],
		[120, 90, 160],
		[60, 60, 70],
	];
	const images = new Array(n);
	const now = Date.now();
	const sourceMtimes = new Array(n);
	const DIM = 128;

	for (let i = 0; i < n; i++) {
		const name = `review-${String(i).padStart(3, "0")}.jpg`;
		images[i] = name;
		const shape = shapes[i % shapes.length];
		const rgb = palettes[i % palettes.length];
		// Slight per-image brightness so tiles aren't flat-identical.
		const boost = (i * 7) % 40;
		await sharp({
			create: {
				width: shape.width,
				height: shape.height,
				channels: 3,
				background: {
					r: Math.min(255, rgb[0] + boost),
					g: Math.min(255, rgb[1] + (boost % 25)),
					b: Math.min(255, rgb[2] + (boost % 15)),
				},
			},
		})
			.jpeg({ quality: 70 })
			.toFile(path.join(photosDir, name));
		// Newest-first: ~20 min apart so All/File ordering is stable.
		sourceMtimes[i] = now - i * 1200000;
	}

	const index = {
		images,
		dim: DIM,
		sourceMtimes,
		ocr: new Array(n).fill(""),
		ocrWords: new Array(n).fill([]),
		screenshotHints: new Array(n).fill(false),
		ocrRevision: 0,
	};
	fs.writeFileSync(
		path.join(dataDir, "memories-index.json"),
		JSON.stringify(index),
	);

	for (const file of [
		"memory-embeddings.bin",
		"memory-phrase-embeddings.bin",
	]) {
		const buf = Buffer.allocUnsafe(8 + n * DIM * 4);
		buf.writeInt32LE(n, 0);
		buf.writeInt32LE(DIM, 4);
		const floats = new Float32Array(buf.buffer, buf.byteOffset + 8, n * DIM);
		for (let r = 0; r < n; r++) {
			let norm = 0;
			const base = r * DIM;
			for (let k = 0; k < DIM; k++) {
				const v = Math.random() * 2 - 1;
				floats[base + k] = v;
				norm += v * v;
			}
			norm = Math.sqrt(norm) || 1;
			for (let k = 0; k < DIM; k++) floats[base + k] /= norm;
		}
		fs.writeFileSync(path.join(dataDir, file), buf);
	}

	console.log(`[ui-review] seeded ${n} rows → ${dataDir}`);

	// loadLibrary() is a singleton — clear the in-memory cache so the next
	// loadLibrary() re-reads the files we just wrote, then poke the renderer.
	if (typeof resetLibraryCaches === "function") resetLibraryCaches();
	if (typeof loadLibrary === "function") loadLibrary();
	try {
		const { BrowserWindow } = require("electron");
		for (const w of BrowserWindow.getAllWindows()) {
			w.webContents.send("memories:status", { type: "library-updated" });
		}
	} catch {
		/* best-effort broadcast */
	}
	await sleep(500);

	const hasTiles = await js(
		`document.querySelectorAll('img[alt^="Memory:"]').length`,
	).catch(() => 0);
	if (!hasTiles) {
		console.log("[ui-review] soft broadcast saw 0 tiles — reloading renderer");
		win.webContents.reload();
		await waitFor(
			"grid after reload",
			`!!document.querySelector('input[aria-label="Search memories"]')`,
			30000,
		);
		await waitFor(
			"tiles after reload",
			`document.querySelectorAll('img[alt^="Memory:"]').length > 0`,
			20000,
		);
	}
}

module.exports = { runUiReview };
