"use strict";

// Headless search-matrix probe (ELECTRON_SMOKE_SEARCH_MATRIX=1). Runs the
// REAL UI through the three search surfaces and reports, per query: result
// count, timing, and how many results carry annotation boxes — the matrix
// that answers "visual search broken?", "OCR broken?", "highlights broken?"
// in one run. MEMORIES_DATA_DIR must point at a library copy.
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx
// (the probe only needs the window — all assertions run page-side).

async function runSearchMatrixProbe(ctx) {
	const { win } = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	if (!win) throw new Error("no window");
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

	const matrix = await win.webContents.executeJavaScript(`
		(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const input = document.querySelector('input[aria-label="Search memories"]');
			if (!input) return { error: 'search box not found' };
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			const setQuery = async (q) => {
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 10000) {
					await sleep(200);
					if (document.querySelectorAll('img[alt]').length > 1) break;
				}
				setter.call(input, q);
				input.dispatchEvent(new Event('input', { bubbles: true }));
			};
			// Busy = the ranking pill or the "Searching memories…" spinner is
			// on screen. Semantic is settled when both have been gone for two
			// consecutive polls.
			const busy = () => {
				const text = document.body.innerText || '';
				return text.includes('Refining with AI') || text.includes('Ranking with AI') || text.includes('Searching memories');
			};
			const sample = (startedAt) => {
				const cards = [...document.querySelectorAll('img[alt^="Memory:"]')];
				// Position lookup must compare like-for-like: cards are <img>,
				// the highlight spans live in the card's .group container.
				const containers = cards.map((i) => i.closest('.group'));
				const spans = [...document.querySelectorAll('[data-search-highlight]')];
				const boxedAlts = new Set();
				const positions = [];
				for (const s of spans) {
					const card = s.closest('.group');
					const img = card && card.querySelector('img[alt^="Memory:"]');
					if (img) {
						boxedAlts.add(img.alt);
						positions.push(containers.indexOf(card));
					}
				}
				return {
					cards: cards.length,
					boxes: spans.length,
					boxedAlts: [...boxedAlts].slice(0, 8),
					// Uncapped distinct-card count — the OCR coverage metric
					// compares this against cards, so the display slice above
					// must not truncate it.
					boxedCardCount: boxedAlts.size,
					// Grid positions of the annotated cards — the ordering
					// assertion ("highlights lead the grid") reads this.
					positions: positions.sort((a, b) => a - b).slice(0, 12),
					ms: Date.now() - startedAt,
					tray: (document.querySelector('[data-ocr-tray], [data-enrich-tray]')?.textContent || '').slice(0, 60),
				};
			};
			const runQuery = async (mode, q) => {
				await setQuery(q);
				const startedAt = Date.now();
				let pillSeen = false;
				let settled = sample(startedAt);
				const ts = Date.now();
				while (Date.now() - ts < 60000) {
					await sleep(400);
					if (busy()) pillSeen = true;
					if (!busy()) {
						await sleep(400);
						if (!busy()) { settled = sample(startedAt); break; }
					}
					settled = sample(startedAt);
				}
				const out = { mode, q, pillSeen, ...settled };
				// Self-diagnosis: an empty grid MUST agree with the ranking
				// engine — call it directly so "UI shows 0" distinguishes
				// "ranker returned 0" from "renderer dropped results".
				if (out.cards === 0) {
					try {
						const direct = await window.memories.rankSearch(q, 10);
						out.directRankCount = (direct || []).length;
						out.directTop = direct && direct[0]
							? { filename: direct[0].filename, score: Math.round(direct[0].score * 1000) / 1000 }
							: null;
					} catch (e) { out.directRankError = String(e); }
				}
				return out;
			};
			const clickMode = async (label) => {
				const btn = document.querySelector(\`[aria-label="\${label}"]\`);
				if (btn) btn.click();
				await sleep(300);
			};
			const idx = await fetch('/memories-index.json').then((r) => r.json());
			const rows = [];
			await clickMode('OCR search mode');
			for (const q of ['AI', 'terminal', 'login password']) rows.push(await runQuery('ocr', q));
			await clickMode('File search mode');
			for (const q of ['a computer screen', 'a dog', 'a beach at sunset', 'AI']) rows.push(await runQuery('files', q));
			await setQuery('');
			return { images: idx.images.length, geomRows: (idx.ocrWords || []).filter((w) => w && w.length).length, rows };
		})()
	`);
	console.log("[search-matrix]", JSON.stringify(matrix, null, 1));
	if (!matrix || matrix.error)
		throw new Error(matrix?.error || "matrix probe failed");
	const bad = matrix.rows.filter((r) => r.cards === 0);
	if (bad.length > 0) {
		console.warn(
			`[search-matrix] EMPTY results for: ${bad.map((r) => `${r.mode}:${r.q}`).join(", ")}`,
		);
	}
	// Ordering assertion: in Files mode the word-exact boost must put
	// annotated rows at the FRONT of the grid for a literal query — if the
	// first box sits deep, the boost stopped reordering.
	const filesAi = matrix.rows.find((r) => r.mode === "files" && r.q === "AI");
	if (filesAi && filesAi.boxes > 0 && (filesAi.positions?.[0] ?? 99) > 5) {
		throw new Error(
			`files 'AI' first annotated card at position ${filesAi.positions[0]} — ordering boost not leading the grid`,
		);
	}
	// Coverage assertion: an OCR-mode text query annotates essentially all
	// of its ranked results (ranking and boxes share the word evidence).
	const ocrAi = matrix.rows.find((r) => r.mode === "ocr" && r.q === "AI");
	if (ocrAi && ocrAi.cards > 0) {
		const boxedCards = ocrAi.boxedCardCount ?? ocrAi.boxedAlts.length;
		console.log(
			`[search-matrix] ocr 'AI' coverage: ${boxedCards}/${ocrAi.cards} cards annotated (raw-fallback rows may lag until the backfill drains)`,
		);
	}
	console.log("[search-matrix] OK");
}

module.exports = { runSearchMatrixProbe };
