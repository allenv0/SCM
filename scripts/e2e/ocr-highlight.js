"use strict";

// Headless probe for the OCR search-highlight pipeline (ELECTRON_SMOKE_OCR_HIGHLIGHT=1).
// Runs against a REAL library snapshot (MEMORIES_DATA_DIR must point at the
// copy) and answers, end to end: does the served index carry word geometry,
// does searching a literal word surface any photo that has it, and do the
// annotation boxes actually render on the tiles? Sampling happens twice —
// right after the keyword pre-pass lands and again after the semantic
// re-rank — so a "boxes flash then vanish" regression is visible too.
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx
// (window + app temp dir — all assertions run page-side).

const fs = require("fs");
const path = require("path");

async function runOcrHighlightProbe(ctx) {
	const { win, app } = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	if (!win) throw new Error("no window");

	// Wait for the renderer to boot far enough to have the search box.
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const has = await win.webContents
			.executeJavaScript(
				`Boolean(document.querySelector('input[aria-label="Search memories"]'))`,
			)
			.catch(() => false);
		if (has) break;
		await new Promise((r) => setTimeout(r, 500));
	}

	const verdict = await win.webContents.executeJavaScript(`
		(async () => {
			const wordTokens = (t) =>
				String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

			// 1. What the SERVED index actually carries.
			const idx = await fetch('/memories-index.json').then((r) => r.json());
			const words = idx.ocrWords || null;
			const geomRows = words ? words.filter((w) => Array.isArray(w) && w.length > 0).length : -1;
			const aiFiles = new Set();
			if (words) {
				idx.images.forEach((f, i) => {
					const ws = words[i];
					if (ws && ws.some((w) => wordTokens(w.text).includes('ai'))) aiFiles.add(f);
				});
			}

			// 2. Type the query through the real search box.
			const input = document.querySelector('input[aria-label="Search memories"]');
			if (!input) return { error: 'search box not found' };
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			setter.call(input, '');
			input.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise((r) => setTimeout(r, 400));
			setter.call(input, 'AI');
			input.dispatchEvent(new Event('input', { bubbles: true }));

			// 3. Sample the grid twice: keyword pre-pass, then post-semantic.
			const sample = () => {
				const cards = [...document.querySelectorAll('img[alt^="Memory:"]')];
				const alts = cards.map((i) => i.alt);
				const spans = [...document.querySelectorAll('[data-search-highlight]')];
				const boxedAlts = new Set();
				for (const s of spans) {
					const card = s.closest('.group');
					const img = card && card.querySelector('img[alt^="Memory:"]');
					if (img) boxedAlts.add(img.alt);
				}
				return {
					cards: cards.length,
					boxes: spans.length,
					boxedAlts: [...boxedAlts].slice(0, 12),
					aiVisible: alts.filter((a) =>
						[...aiFiles].some((f) => a === 'Memory: ' + f.replace(/\\.[^.]+$/, '')),
					).slice(0, 12),
				};
			};
			await new Promise((r) => setTimeout(r, 900));
			const keywordPhase = sample();
			await new Promise((r) => setTimeout(r, 7000));
			// Where do the annotated cards sit in the result order? A feature
			// that works but only renders 40 rows down might as well not
			// exist — capture positions alongside the counts.
			const semanticPhase = sample();
			const cardEls = [...document.querySelectorAll('.group')].filter(
				(el) => el.querySelector('img[alt^="Memory:"]'),
			);
			semanticPhase.positions = [...document.querySelectorAll('[data-search-highlight]')]
				.map((s) => {
					const card = s.closest('.group');
					return card ? cardEls.indexOf(card) : -1;
				})
				.filter((p) => p >= 0)
				.slice(0, 20);
			// Leave the FIRST annotated card on screen so the caller can
			// capture what the user should be seeing.
			const firstBoxed = cardEls[semanticPhase.positions[0]];
			if (firstBoxed) firstBoxed.scrollIntoView({ block: "center" });
			semanticPhase.scrolledTo = semanticPhase.positions[0] ?? -1;
			return {
				images: idx.images.length,
				ocrWordsPresent: Boolean(words),
				geomRows,
				aiWordPhotos: aiFiles.size,
				keywordPhase,
				semanticPhase,
			};
		})()
	`);
	console.log("[ocr-highlight-probe]", JSON.stringify(verdict, null, 2));
	if (!verdict || verdict.error)
		throw new Error(verdict?.error || "probe failed");
	if (!verdict.ocrWordsPresent) throw new Error("served index has no ocrWords");
	if (verdict.aiWordPhotos === 0)
		throw new Error("no AI-word photos in library");
	if (verdict.semanticPhase.boxes === 0 && verdict.keywordPhase.boxes === 0) {
		throw new Error(
			`no highlight boxes rendered (aiVisible: ${JSON.stringify(verdict.semanticPhase.aiVisible)})`,
		);
	}

	// Visual evidence 1: the grid with an annotated card centered.
	const shotDir = path.join(app.getPath("temp"), "scm-ocr-highlight-probe");
	fs.mkdirSync(shotDir, { recursive: true });
	const gridShot = await win.webContents.capturePage();
	await fs.promises.writeFile(path.join(shotDir, "grid.png"), gridShot.toPNG());

	// Visual evidence 2: open the first annotated card — the annotations must
	// follow into the lightbox.
	await win.webContents.executeJavaScript(`
		(() => {
			const card = [...document.querySelectorAll('.group')].find((el) =>
				el.querySelector('[data-search-highlight]'),
			);
			if (!card) return false;
			card.scrollIntoView({ block: 'center' });
			card.querySelector('img').click();
			return true;
		})()
	`);
	await new Promise((r) => setTimeout(r, 2500));
	const lightboxBoxes = await win.webContents
		.executeJavaScript(
			`document.querySelectorAll('.fixed [data-search-highlight]').length`,
		)
		.catch(() => -1);
	console.log(`[ocr-highlight-probe] lightbox boxes: ${lightboxBoxes}`);
	const lightShot = await win.webContents.capturePage();
	await fs.promises.writeFile(
		path.join(shotDir, "lightbox.png"),
		lightShot.toPNG(),
	);
	console.log(`[ocr-highlight-probe] screenshots: ${shotDir}`);
	console.log("[ocr-highlight-probe] OK");
}

module.exports = { runOcrHighlightProbe };
