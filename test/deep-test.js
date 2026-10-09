"use strict";

// Deep full-feature test (ELECTRON_SMOKE=1 + ELECTRON_SMOKE_DEEP=1). Unlike
// the targeted smokes (e2e = import+ranking, phase4 = scene pipeline+OCR),
// this builds a 33-file fixture library and exercises EVERY user-facing
// feature through the real renderer, plus main-process integrity:
//
//   import (photos, GIF, text images, playable + unplayable videos,
//           enough volume to paginate)
//   background OCR + enrichment (both tray pills appear, both queues drain)
//   renderer: infinite-scroll pagination, category tabs, lightbox (open,
//            arrow-key nav, prev/next buttons, Escape, video element,
//            unplayable notice), saved-search tabs, model picker, all three
//            search modes (Files / Scenes / OCR) + empty states, drag-drop
//            overlay, context-menu delete (photo + video)
//   main: protocol serving (photo, poster, scene poster, video Range,
//         models manifest, segment sidecars), persistence alignment,
//         delete cleanup (index row, copy, posters, scene segments),
//         phrase-bin heal, threshold calibration
//
// Must run with a temp MEMORIES_DATA_DIR (the smoke:deep script sets it and
// symlinks the model cache + OCR traineddata for offline reuse).

const path = require("path");
const fs = require("fs");

module.exports = { runDeepTest };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE = {
	// Solid-color photos (fast embeds, distinct semantic content).
	photos: [
		"deep-blue.jpg",
		"deep-red.jpg",
		"deep-green.jpg",
		"deep-purple.jpg",
		"mac-desk.jpg", // "mac" → no category tab (Projects bucket)
		"apple-ui.jpg", // "apple" → no category tab (Projects bucket)
	],
	// Text-bearing images (the OCR pipeline's job).
	textImages: [
		// "TEST" must survive OCR: the Files-mode check proves the poster's
		// visible text lifts it above semantic-only matches for the query.
		{ name: "poster-deep.png", words: ["DEEP", "TEST", "POSTER"] },
		{ name: "scr-settings.png", words: ["SETTINGS", "PANEL"] }, // "scr" → Screenshots
	],
	// 21 tiny grid-volume photos so scroll/lightbox/virtualization checks
	// have rows beyond the first viewport (C-04: no pagination pages).
	pgCount: 21,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function runDeepTest(ctx) {
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error(
			"ELECTRON_SMOKE_DEEP requires MEMORIES_DATA_DIR (a temp dir)",
		);
	}
	const { win } = ctx;
	if (!win) throw new Error("deep: no window");

	let passed = 0;
	let failed = 0;
	const check = (name, fn) => {
		try {
			fn();
			passed++;
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failed++;
			console.error(`  ✗ ${name}: ${err.message}`);
		}
	};
	const checkAsync = async (name, fn) => {
		try {
			await fn();
			passed++;
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failed++;
			console.error(`  ✗ ${name}: ${err.message}`);
		}
	};
	const waitFor = async (fn, timeoutMs, label) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			try {
				if (fn()) return;
			} catch {
				/* keep polling */
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	// ---- 1. fixtures + import ------------------------------------------
	console.log("[deep] fixtures + import…");
	const tmp = fs.mkdtempSync(
		path.join(ctx.app.getPath("temp"), "memories-deep-"),
	);
	const sharp = (await import("sharp")).default;

	const solid = async (name, rgb) => {
		const file = path.join(tmp, name);
		await sharp({
			create: {
				width: 96,
				height: 96,
				channels: 3,
				background: { r: rgb[0], g: rgb[1], b: rgb[2] },
			},
		})
			.jpeg()
			.toFile(file);
		return file;
	};
	const textImage = async (name, lines) => {
		const svg = Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320">` +
				`<rect width="640" height="320" fill="#181428"/>` +
				lines
					.map(
						(line, i) =>
							`<text x="40" y="${110 + i * 70}" font-family="Arial" font-size="${44 - i * 6}" fill="white" font-weight="bold">${line}</text>`,
					)
					.join("") +
				`</svg>`,
		);
		const file = path.join(tmp, name);
		await sharp(svg).png().toFile(file);
		return file;
	};

	const ffmpeg = require("../indexer/video-utils.js").resolveFfmpeg();
	const cp = require("child_process");
	const gen = (name, args) => {
		const file = path.join(tmp, name);
		const out = cp.spawnSync(ffmpeg, ["-y", ...args, file], {
			encoding: "utf8",
		});
		if (out.status !== 0 || !fs.existsSync(file)) {
			throw new Error(
				`fixture generation failed for ${name}: ${out.stderr.slice(-300)}`,
			);
		}
		return file;
	};

	const files = [];
	for (const [i, name] of FIXTURE.photos.entries()) {
		files.push(await solid(name, [40 + i * 30, 60 + i * 20, 120 + i * 40]));
	}
	for (const t of FIXTURE.textImages) {
		files.push(await textImage(t.name, t.words));
	}
	for (let i = 0; i < FIXTURE.pgCount; i++) {
		const v = 150 + ((i * 7) % 90);
		files.push(await solid(`pg-${String(i).padStart(2, "0")}.jpg`, [v, v, v]));
	}
	// Animated GIF (red → blue): the middle-frame embed path.
	files.push(
		gen("anim.gif", [
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=96x96:d=0.4",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=96x96:d=0.4",
			"-filter_complex",
			"[0:v][1:v]concat=n=2:v=1:a=0[v];[v]split[a][b];[a]palettegen[p];[b][p]paletteuse",
			"-loop",
			"0",
		]),
	);
	// WebP bytes under a .png name (the Sep-2026 wrong-decoder incident):
	// import must normalize the stored extension to the content.
	files.push(
		await (async () => {
			const file = path.join(tmp, "mislabeled.png");
			await sharp({
				create: {
					width: 96,
					height: 96,
					channels: 3,
					background: { r: 90, g: 60, b: 200 },
				},
			})
				.webp()
				.toFile(file);
			return file;
		})(),
	);
	// Playable h264 video (green).
	files.push(
		gen("playable.mp4", [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=160x120:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
		]),
	);
	// 3-shot clip (black/red/black): the scene-search fixture.
	files.push(
		gen("scene-clip.mp4", [
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=320x240:d=2.5",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=320x240:d=1",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=320x240:d=6.5",
			"-filter_complex",
			"[0:v][1:v][2:v]concat=n=3:v=1:a=0",
			"-pix_fmt",
			"yuv420p",
		]),
	);
	// Unplayable container (searchable-only): mkv.
	files.push(
		gen("unplayable.mkv", [
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x120:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
		]),
	);

	const expect =
		FIXTURE.photos.length + FIXTURE.textImages.length + FIXTURE.pgCount + 4 + 1; // gif + 3 videos + mislabeled webp
	if (files.length !== expect)
		throw new Error(`fixture count ${files.length} != ${expect}`);

	const res = await ctx.importPaths(files);
	check("import: all 34 fixtures added", () => {
		if (res.added.length !== expect) {
			throw new Error(
				`added ${res.added.length}/${expect}: ${JSON.stringify(res)}`,
			);
		}
		if (res.errors.length > 0) {
			throw new Error(`import errors: ${JSON.stringify(res.errors)}`);
		}
	});
	check("import: WebP-as-.png normalized to content extension", () => {
		if (!res.added.includes("mislabeled.webp")) {
			throw new Error(
				`mislabeled file not normalized: ${JSON.stringify(res.added)}`,
			);
		}
	});
	await checkAsync(
		"serve: mislabeled file served with content Content-Type",
		async () => {
			const ct = await win.webContents.executeJavaScript(
				`fetch('/images/projects/mislabeled.webp').then((r) => r.headers.get('content-type'))`,
			);
			if (ct !== "image/webp") {
				throw new Error(`wrong Content-Type for WebP bytes: ${ct}`);
			}
		},
	);

	// ---- 2. background drain: embeds, OCR, enrichment --------------------
	// Watch for both tray pills while the queues drain in the background.
	console.log("[deep] background OCR + enrichment…");
	const trayPoll = win.webContents.executeJavaScript(`
		(async () => {
			const seen = { ocr: false, enrich: false };
			const t0 = Date.now();
			while (Date.now() - t0 < 90000) {
				await new Promise((r) => setTimeout(r, 250));
				if (document.querySelector('[data-ocr-tray]')) seen.ocr = true;
				if (document.querySelector('[data-enrich-tray]')) seen.enrich = true;
				if (seen.ocr && seen.enrich) return seen;
			}
			return seen;
		})()
	`);
	await waitFor(
		() => {
			const b = ctx.binInfo(ctx.loadLibrary().modelId);
			return b && b.rows >= expect;
		},
		120000,
		"embed bins",
	);
	await waitFor(
		() => ctx.getOcrState().queue === 0 && !ctx.getOcrState().inFlight,
		240000,
		"OCR queue drain",
	);
	await waitFor(
		() => ctx.getEnrichQueue() === 0,
		240000,
		"enrichment queue drain",
	);
	const seen = await trayPoll;
	check("trays: OCR + enrich pills appeared during background work", () => {
		if (!seen.ocr) throw new Error("OCR tray never appeared");
		if (!seen.enrich) throw new Error("enrich tray never appeared");
	});

	const l = ctx.loadLibrary();
	const modelId = l.modelId;

	// ---- 3. main-process integrity --------------------------------------
	console.log("[deep] main-process integrity…");
	check("index: every parallel array is aligned", () => {
		const lens = [l.filenames, l.sources, l.ocr, l.embeddings, l.phrases].map(
			(a) => a.length,
		);
		if (new Set(lens).size !== 1) {
			throw new Error(`misaligned arrays: ${JSON.stringify(lens)}`);
		}
		if (lens[0] !== expect)
			throw new Error(`expected ${expect} rows, got ${lens[0]}`);
	});
	check("index: sources recorded for every file", () => {
		for (let i = 0; i < l.filenames.length; i++) {
			if (!l.sources[i] || !fs.existsSync(l.sources[i])) {
				throw new Error(`source missing for ${l.filenames[i]}`);
			}
		}
	});
	check("OCR: every photo has a text row (videos excluded)", () => {
		for (let i = 0; i < l.filenames.length; i++) {
			const isVideo = require("../indexer/video-utils.js").VIDEO_EXTENSIONS.has(
				path.extname(l.filenames[i]).toLowerCase(),
			);
			const row = l.ocr[i];
			if (isVideo) {
				// Videos are never OCR'd — the row must not be a string.
				if (typeof row === "string") {
					throw new Error(`video ${l.filenames[i]} got OCR text`);
				}
			} else if (typeof row !== "string") {
				throw new Error(`photo ${l.filenames[i]} missing OCR row (${row})`);
			}
		}
	});
	check("OCR: poster + screenshot text extracted correctly", () => {
		const posterRow = (
			l.ocr[l.filenames.indexOf("poster-deep.png")] || ""
		).toUpperCase();
		const scrRow = (
			l.ocr[l.filenames.indexOf("scr-settings.png")] || ""
		).toUpperCase();
		for (const w of FIXTURE.textImages[0].words) {
			if (!posterRow.includes(w))
				throw new Error(
					`poster OCR missing ${w}: ${JSON.stringify(posterRow)}`,
				);
		}
		for (const w of FIXTURE.textImages[1].words) {
			if (!scrRow.includes(w))
				throw new Error(
					`screenshot OCR missing ${w}: ${JSON.stringify(scrRow)}`,
				);
		}
	});
	check("segments: every video enriched, scene-clip has ≥3 shots", () => {
		const c = ctx.loadSegments(modelId);
		if (!c.loaded) throw new Error("segment sidecar not loaded");
		for (const name of ["playable.mp4", "scene-clip.mp4", "unplayable.mkv"]) {
			const segs = c.videos.get(name) || [];
			if (segs.length === 0) throw new Error(`${name} has no segments`);
		}
		if ((c.videos.get("scene-clip.mp4") || []).length < 3) {
			throw new Error(`scene-clip should have ≥3 shots`);
		}
	});
	check("thresholds: fresh library uncalibrated (calibrates on demand)", () => {
		if (ctx.thresholdsFor(modelId)) {
			throw new Error("fresh library should start uncalibrated");
		}
	});

	// Calibration on demand (the migrate test covers the post-switch path;
	// here we prove a real library calibrates to a sensible band).
	await checkAsync(
		"calibration: measure + persist thresholds for the library",
		async () => {
			const t = await ctx.calibrateThresholds(modelId);
			if (!t || !(t.minSemanticScore > 0)) {
				throw new Error(`calibration produced nothing: ${JSON.stringify(t)}`);
			}
		},
	);

	// ---- 4. protocol serving --------------------------------------------
	console.log("[deep] protocol…");
	await checkAsync(
		"protocol: photo / poster / scene poster / video range / manifests",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const r = (u, o) => fetch(u, o).then(async (res) => ({
					u,
					s: res.status,
					ct: res.headers.get('content-type'),
					cr: res.headers.get('content-range'),
					len: (await res.arrayBuffer()).byteLength,
				})).catch((e) => ({ u, err: e.message }));
				const [photo, poster, scenePoster, range, models, segs, segBin] = await Promise.all([
					r('/images/projects/deep-blue.jpg'),
					r('/images/posters/playable.jpg'),
					r('/images/posters/scene-clip-scene-0.jpg'),
					r('/images/projects/playable.mp4', { headers: { 'Range': 'bytes=0-99' } }),
					r('/memories-models.json'),
					r('/memory-segments.json'),
					r('/memory-segment-embeddings.bin'),
				]);
				const binHead = new Int32Array(segBin.len ? await (await fetch('/memory-segment-embeddings.bin')).arrayBuffer() : new ArrayBuffer(0), 0, 2);
				const modelsBody = models.s === 200 ? await (await fetch('/memories-models.json')).json() : null;
				return { photo, poster, scenePoster, range, models, modelsCount: modelsBody ? modelsBody.models.length : 0, segs, segBin, binHead: [binHead[0], binHead[1]] };
			})()
		`);
			const ok = (o, s, label) => {
				if (o.s !== s) throw new Error(`${label}: ${o.s} ${JSON.stringify(o)}`);
			};
			ok(out.photo, 200, "photo fetch");
			ok(out.poster, 200, "video poster");
			ok(out.scenePoster, 200, "scene poster");
			ok(out.range, 206, "video range");
			if (!out.range.cr || !out.range.cr.startsWith("bytes 0-99/")) {
				throw new Error(`range header: ${out.range.cr}`);
			}
			if (out.range.len !== 100)
				throw new Error(`range length ${out.range.len}`);
			if (out.models.s !== 200)
				throw new Error(`models manifest fetch: ${out.models.s}`);
			// The manifest lists every REGISTERED model (downloaded or not), so the
			// expected count is the registry size — never a machine-dependent
			// hardcode (the number of cached models varies per machine).
			const registryCount = Object.keys(
				require("../indexer/models").MODELS,
			).length;
			if (out.modelsCount !== registryCount) {
				throw new Error(
					`models manifest count: ${out.modelsCount} (registry has ${registryCount})`,
				);
			}
			if (out.segs.s !== 200)
				throw new Error(`segments meta fetch: ${out.segs.s}`);
			if (out.segBin.s !== 200 || out.binHead[0] < 3) {
				throw new Error(
					`segment bin fetch: ${out.segBin.s} head ${out.binHead}`,
				);
			}
		},
	);

	// ---- 5. renderer feature tests --------------------------------------
	console.log("[deep] renderer features…");

	// 5a. Drag-drop overlay: enter shows, drop/leave hides.
	await checkAsync("UI: drag-drop overlay appears and dismisses", async () => {
		const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const overlay = () => [...document.querySelectorAll('div')].find((d) =>
					(d.textContent || '').includes('Drop photos or folders to index them'));
				const dt = new DataTransfer();
				window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
				const t0 = Date.now();
				while (Date.now() - t0 < 5000) {
					if (overlay()) break;
					await sleep(100);
				}
				if (!overlay()) return { error: 'overlay never appeared' };
				window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
				window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
				const t1 = Date.now();
				while (Date.now() - t1 < 5000) {
					if (!overlay()) return { ok: true };
					await sleep(100);
				}
				return { error: 'overlay never dismissed' };
			})()
		`);
		if (out.error) throw new Error(out.error);
	});

	// 5b. Virtualized grid: the DOM holds only the viewport window
	// (C-04 — cursor pagination is deleted), so "the rest loaded" is proven
	// by the last item being mounted after the scroll, not by a DOM card
	// count — while the mounted count stays bounded and the scroll span
	// stays within one row of drift (windowing, not append-growth).
	// deep-blue is the oldest fixture = the LAST row of the grid.
	// The span is an estimate that converges as rows mount and measure
	// (thumbs/fonts settle async), so exact pixel equality across the
	// scroll is racy — append-growth, the real enemy, moves it by orders
	// of magnitude more than one row.
	await checkAsync(
		"UI: virtualized grid reaches the last item with bounded DOM",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const alts = () => [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
				const t0 = Date.now();
				let firstCount = 0;
				let firstHeight = 0;
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					firstCount = alts().length;
					if (firstCount > 0) {
						firstHeight = document.body.scrollHeight;
						break;
					}
				}
				if (firstCount === 0) {
					return { ok: false, error: 'grid never mounted tiles', n: firstCount };
				}
				if (firstCount >= 150) {
					return { ok: false, error: 'unbounded DOM on first paint', n: firstCount };
				}
				// deep-blue is the oldest fixture = the LAST row of the grid.
				// Keep pushing to the very bottom: thumbs/layout settle async
				// and the span converges as estimated row heights become
				// measured. Settle = span unchanged across consecutive polls
				// with the last row mounted.
				window.scrollTo(0, document.body.scrollHeight);
				const t1 = Date.now();
				let steady = 0;
				let lastH = -1;
				while (Date.now() - t1 < 15000) {
					await sleep(250);
					window.scrollTo(0, document.body.scrollHeight);
					const h = document.body.scrollHeight;
					const a = alts();
					if (!a.some((x) => x.includes('deep-blue'))) {
						steady = 0;
						lastH = -1;
						continue;
					}
					steady = h === lastH ? steady + 1 : 0;
					lastH = h;
					if (steady >= 3) {
						return {
							ok: true,
							first: firstCount,
							last: a.find((x) => x.includes('deep-blue')),
							firstHeight,
							finalHeight: h,
							drift: h - firstHeight,
							finalCount: a.length,
						};
					}
				}
				return { ok: false, error: 'scroll span never settled at the last item', alts: alts().slice(0, 12) };
			})()
		`);
			if (out.error) throw new Error(out.error);
			// Windowing, not append-growth: allow up to one row of drift for
			// estimate convergence — append-growth would move the span by
			// thousands of px, an order of magnitude past this band.
			const SPAN_DRIFT_TOLERANCE_PX = 200;
			if (Math.abs(out.drift) > SPAN_DRIFT_TOLERANCE_PX) {
				throw new Error(
					`scroll span moved on scroll: ${out.firstHeight} -> ${out.finalHeight} (drift ${out.drift}px)`,
				);
			}
			if (out.finalCount >= 150) {
				throw new Error(`unbounded DOM at bottom: ${out.finalCount} tiles`);
			}
		},
	);

	// 5c. Category tabs filter the grid.
	await checkAsync(
		"UI: category tabs filter (Videos/Screenshots)",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
					.find((b) => (b.textContent || '').trim() === t);
				const alts = () => [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
				const expect = async (tab, pred, min) => {
					const btn = tabByText(tab);
					if (!btn) return { tab, error: 'no tab' };
					btn.click();
					const t0 = Date.now();
					while (Date.now() - t0 < 10000) {
						await sleep(250);
						const a = alts();
						if (a.length >= (min || 1) && a.every(pred)) return { tab, count: a.length };
					}
					return { tab, error: 'timeout', alts: alts().slice(0, 12) };
				};
				const out = [];
				out.push(await expect('Videos', (a) => /playable|scene-clip|unplayable/.test(a), 3));
				out.push(await expect('Screenshots', (a) => a.includes('scr-settings')));
				// The Design/Personal tabs were removed — they must not render.
				if (tabByText('Design') || tabByText('Personal')) {
					return { out, error: 'Design/Personal tab still present' };
				}
				const all = tabByText('All');
				all.click();
				// The All tab is the full 33-item browse grid; virtualization
				// mounts only the window around the viewport, so "the full grid
				// is back" is proven by reaching the LAST row (deep-blue), not
				// by a DOM card count.
				const t0 = Date.now();
				while (Date.now() - t0 < 10000) {
					await sleep(250);
					if (alts().length > 0) break;
				}
				window.scrollTo(0, document.body.scrollHeight);
				let lastReached = false;
				const t1 = Date.now();
				while (Date.now() - t1 < 10000) {
					await sleep(250);
					if (alts().some((a) => a.includes('deep-blue'))) {
						lastReached = true;
						break;
					}
				}
				return { out, all: alts().length, lastReached };
			})()
		`);
			for (const r of out.out || []) {
				if (r.error) throw new Error(`${r.tab}: ${r.error}`);
			}
			if (out.error) throw new Error(out.error);
			if (!out.lastReached) {
				throw new Error(
					`All tab did not restore the full grid (last item unreachable): ${out.all} mounted`,
				);
			}
		},
	);

	// 5d. Lightbox: open, arrow-key nav, prev/next, Escape.
	await checkAsync(
		"UI: lightbox open + keyboard/button nav + Escape",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tile = (stem) => [...document.querySelectorAll('img[alt]')]
					.find((i) => (i.getAttribute('alt') || '') === 'Memory: ' + stem)?.closest('.group');
				const lbSrc = () => {
					const img = document.querySelector('.fixed.inset-0.z-50 img');
					return img ? (img.getAttribute('src') || '') : '';
				};
				const waitSrc = async (needle, ms = 8000) => {
					const t = Date.now();
					while (Date.now() - t < ms) {
						await sleep(150);
						if (lbSrc().includes(needle)) return true;
					}
					return false;
				};
				// The grid is newest-imported first, so the earliest fixtures
				// (deep-green/red/blue) live on the LAST page — scroll to the
				// bottom so their tiles render before clicking.
				window.scrollTo(0, document.body.scrollHeight);
				let card;
				const t0 = Date.now();
				while (Date.now() - t0 < 10000) {
					card = tile('deep-red');
					if (card) break;
					await sleep(200);
				}
				if (!card) return { error: 'deep-red tile missing' };
				card.click();
				if (!(await waitSrc('deep-red'))) return { error: 'lightbox did not open', src: lbSrc() };
				// Adjacent in newest-first order: … deep-green → deep-red → deep-blue.
				document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
				if (!(await waitSrc('deep-blue'))) return { error: 'ArrowRight failed', src: lbSrc() };
				document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
				if (!(await waitSrc('deep-red'))) return { error: 'ArrowLeft failed', src: lbSrc() };
				const next = document.querySelector('button[aria-label="Next image"]');
				if (!next) return { error: 'Next button missing' };
				next.click();
				if (!(await waitSrc('deep-blue'))) return { error: 'Next button failed', src: lbSrc() };
				const prev = document.querySelector('button[aria-label="Previous image"]');
				if (!prev) return { error: 'Previous button missing' };
				prev.click();
				if (!(await waitSrc('deep-red'))) return { error: 'Previous button failed', src: lbSrc() };
				document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
				const t1 = Date.now();
				while (Date.now() - t1 < 5000) {
					if (!document.querySelector('.fixed.inset-0.z-50 img')) return { ok: true };
					await sleep(100);
				}
				return { error: 'Escape did not close' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// 5e. Video lightbox: playable renders a <video>; unplayable shows the notice.
	await checkAsync(
		"UI: video lightbox (playable element + unplayable notice)",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				// The videos are the newest imports = the TOP rows of the
				// grid; 5d left the page scrolled to the bottom, and the
				// virtualized grid unmounts off-window rows, so return to
				// the top before looking for the tiles.
				window.scrollTo(0, 0);
				await sleep(200);
				const tile = (stem) => [...document.querySelectorAll('img[alt]')]
					.find((i) => (i.getAttribute('alt') || '') === 'Memory: ' + stem)?.closest('.group');
				const open = async (stem) => {
					let card;
					const t0 = Date.now();
					while (Date.now() - t0 < 10000) {
						card = tile(stem);
						if (card) break;
						await sleep(200);
					}
					if (!card) return 'tile missing: ' + stem;
					card.click();
					return null;
				};
				const close = async () => {
					document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
					const t0 = Date.now();
					while (Date.now() - t0 < 5000) {
						if (!document.querySelector('.fixed.inset-0.z-50 video')) return;
						await sleep(100);
					}
				};
				let err = await open('playable');
				if (err) return { error: err };
				const t0 = Date.now();
				let v = null;
				while (Date.now() - t0 < 8000) {
					await sleep(150);
					v = document.querySelector('.fixed.inset-0.z-50 video');
					if (v && (v.getAttribute('src') || '').includes('playable.mp4')) break;
				}
				if (!v || !(v.getAttribute('src') || '').includes('playable.mp4')) {
					return { error: 'playable video element missing', src: v && v.getAttribute('src') };
				}
				await close();
			err = await open('unplayable');
			if (err) return { error: err };
			const t1 = Date.now();
			while (Date.now() - t1 < 8000) {
				await sleep(150);
				const body = document.body.textContent || '';
				// New UI: 30 s in-app preview (<video src=/images/preview/…>)
				// with a system-player button; legacy fallback is the poster
				// + "Playback not supported" notice. Accept either.
				const pv = document.querySelector('.fixed.inset-0.z-50 video');
				const previewOk = pv && (pv.getAttribute('src') || '').includes('/images/preview/');
				const btnOk = [...document.querySelectorAll('.fixed.inset-0.z-50 button')]
					.some((b) => (b.textContent || '').includes('Open in system player'));
				if ((previewOk && btnOk) || body.includes('Playback not supported')) {
					await close();
					return { ok: true };
				}
			}
			return { error: 'unplayable preview/button missing' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// 5f. Saved-search tabs: save (with a custom name) → restore → remove.
	await checkAsync(
		"UI: saved-search tabs (save / restore / remove)",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				// Clear any stale tab from a previous run.
				const stale = document.querySelector('[aria-label="Remove tab deep tab"]');
				if (stale) stale.click();
				await sleep(300);
				setter.call(input, 'deep');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				let saveBtn;
				while (Date.now() - t0 < 8000) {
					await sleep(150);
					saveBtn = document.querySelector('button[aria-label="Save this search as a tab"]');
					if (saveBtn) break;
				}
				if (!saveBtn) return { error: 'save button never appeared' };
				saveBtn.click();
				// The naming dialog should open, pre-filled with the query.
				const t1 = Date.now();
				let nameInput;
				while (Date.now() - t1 < 5000) {
					await sleep(150);
					nameInput = document.querySelector('input[aria-label="Tab name"]');
					if (nameInput) break;
				}
				if (!nameInput) return { error: 'naming dialog did not open' };
				if ((nameInput.value || '') !== 'deep') return { error: 'dialog not pre-filled with the query', value: nameInput.value };
				// Name the tab DIFFERENTLY from the query to prove the label
				// is its own thing, then confirm with Enter.
				setter.call(nameInput, 'deep tab');
				nameInput.dispatchEvent(new Event('input', { bubbles: true }));
				nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
				const t2 = Date.now();
				let tabBtn;
				while (Date.now() - t2 < 5000) {
					await sleep(150);
					tabBtn = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find((b) =>
						b.querySelector('[aria-label="Remove tab deep tab"]'));
					if (tabBtn) break;
				}
				if (!tabBtn) return { error: 'saved tab did not appear' };
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await sleep(400);
				tabBtn.click();
				const t3 = Date.now();
				while (Date.now() - t3 < 8000) {
					await sleep(200);
					if ((input.value || '') === 'deep') break;
				}
				if ((input.value || '') !== 'deep') return { error: 'tab did not restore the query', value: input.value };
				let hits = 0;
				const t4 = Date.now();
				while (Date.now() - t4 < 8000) {
					await sleep(200);
					hits = [...document.querySelectorAll('img[alt]')].filter((i) =>
						(i.getAttribute('alt') || '').includes('deep')).length;
					if (hits > 0) break;
				}
				const remove = document.querySelector('[aria-label="Remove tab deep tab"]');
				if (!remove) return { error: 'remove button missing', hits };
				remove.click();
				const t5 = Date.now();
				while (Date.now() - t5 < 5000) {
					await sleep(150);
					if (!document.querySelector('[aria-label="Remove tab deep tab"]')) return { ok: true, hits, restored: true };
				}
				return { error: 'tab did not remove', hits };
			})()
		`);
			if (out.error) throw new Error(out.error);
			if (out.hits < 1) throw new Error("saved search produced no results");
		},
	);

	// 5f2. Saved tabs remember their search mode: save under OCR, switch to
	// Files, click the tab — OCR mode (LED on the toggle) must come back.
	await checkAsync("UI: saved tab restores its search mode", async () => {
		const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				// Clear any stale tab from a previous run.
				const stale = document.querySelector('[aria-label="Remove tab ocr deep"]');
				if (stale) stale.click();
				await sleep(300);
				// Type a query, flip to OCR mode, and save it as a tab.
				setter.call(input, 'deep');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const ocrBtn = document.querySelector('button[aria-label="OCR search mode"]');
				if (!ocrBtn) return { error: 'no OCR mode button' };
				ocrBtn.click();
				const t0 = Date.now();
				let saveBtn;
				while (Date.now() - t0 < 8000) {
					await sleep(150);
					saveBtn = document.querySelector('button[aria-label="Save this search as a tab"]');
					if (saveBtn) break;
				}
				if (!saveBtn) return { error: 'save button never appeared' };
				saveBtn.click();
				const t1 = Date.now();
				let nameInput;
				while (Date.now() - t1 < 5000) {
					await sleep(150);
					nameInput = document.querySelector('input[aria-label="Tab name"]');
					if (nameInput) break;
				}
				if (!nameInput) return { error: 'naming dialog did not open' };
				setter.call(nameInput, 'ocr deep');
				nameInput.dispatchEvent(new Event('input', { bubbles: true }));
				nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
				// Leave OCR mode, then click the tab and expect it back.
				const filesBtn = document.querySelector('button[aria-label="File search mode"]');
				if (!filesBtn) return { error: 'no File mode button' };
				filesBtn.click();
				await sleep(300);
				const t2 = Date.now();
				let tabBtn;
				while (Date.now() - t2 < 5000) {
					await sleep(150);
					tabBtn = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find((b) =>
						b.querySelector('[aria-label="Remove tab ocr deep"]'));
					if (tabBtn) break;
				}
				if (!tabBtn) return { error: 'saved tab did not appear' };
				tabBtn.click();
				const t3 = Date.now();
				let ocrLed;
				while (Date.now() - t3 < 5000) {
					await sleep(150);
					ocrLed = document.querySelector('button[aria-label="OCR search mode"] span[class*="ai-ready"]');
					if (ocrLed) break;
				}
				if (!ocrLed) return { error: 'OCR mode was not restored by the tab' };
				// Clean up: remove the tab, return to Files mode, clear input.
				const remove = document.querySelector('[aria-label="Remove tab ocr deep"]');
				if (!remove) return { error: 'remove button missing' };
				remove.click();
				const t4 = Date.now();
				while (Date.now() - t4 < 5000) {
					await sleep(150);
					if (!document.querySelector('[aria-label="Remove tab ocr deep"]')) break;
				}
				document.querySelector('button[aria-label="File search mode"]').click();
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return { ok: true };
			})()
		`);
		if (out.error) throw new Error(out.error);
	});

	// 5f3. Saved tabs can be renamed and re-moded: edit a tab's label and
	// its search mode, then confirm the tab runs the new mode.
	await checkAsync("UI: saved tab rename + mode change", async () => {
		const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				// Clear any stale tab from a previous run.
				const stale = document.querySelector('[aria-label="Remove tab edited"]');
				if (stale) stale.click();
				await sleep(300);
				// Create a tab named 'edit me' (Files mode by default).
				setter.call(input, 'deep');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				let saveBtn;
				while (Date.now() - t0 < 8000) {
					await sleep(150);
					saveBtn = document.querySelector('button[aria-label="Save this search as a tab"]');
					if (saveBtn) break;
				}
				if (!saveBtn) return { error: 'save button never appeared' };
				saveBtn.click();
				const t1 = Date.now();
				let nameInput;
				while (Date.now() - t1 < 5000) {
					await sleep(150);
					nameInput = document.querySelector('input[aria-label="Tab name"]');
					if (nameInput) break;
				}
				if (!nameInput) return { error: 'naming dialog did not open' };
				setter.call(nameInput, 'edit me');
				nameInput.dispatchEvent(new Event('input', { bubbles: true }));
				nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
				const t2 = Date.now();
				let renameBtn;
				while (Date.now() - t2 < 5000) {
					await sleep(150);
					renameBtn = document.querySelector('[aria-label="Rename tab edit me"]');
					if (renameBtn) break;
				}
				if (!renameBtn) return { error: 'saved tab did not appear' };
				// Edit: rename to 'edited' and flip the mode to OCR.
				renameBtn.click();
				const t3 = Date.now();
				let editInput;
				while (Date.now() - t3 < 5000) {
					await sleep(150);
					editInput = document.querySelector('input[aria-label="Tab name"]');
					if (editInput) break;
				}
				if (!editInput) return { error: 'edit dialog did not open' };
				if ((editInput.value || '') !== 'edit me') return { error: 'edit dialog not pre-filled with the label', value: editInput.value };
				const ocrModeBtn = document.querySelector('[role="dialog"] button[aria-label="Tab mode: OCR"]');
				if (!ocrModeBtn) return { error: 'mode selector missing' };
				ocrModeBtn.click();
				setter.call(editInput, 'edited');
				editInput.dispatchEvent(new Event('input', { bubbles: true }));
				editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
				const t4 = Date.now();
				let tabBtn;
				while (Date.now() - t4 < 5000) {
					await sleep(150);
					tabBtn = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find((b) =>
						b.querySelector('[aria-label="Remove tab edited"]'));
					if (tabBtn) break;
				}
				if (!tabBtn) return { error: 'renamed tab did not appear' };
				// Click it: the query comes back AND the new OCR mode applies.
				tabBtn.click();
				const t5 = Date.now();
				let ocrLed;
				while (Date.now() - t5 < 5000) {
					await sleep(150);
					ocrLed = document.querySelector('button[aria-label="OCR search mode"] span[class*="ai-ready"]');
					if (ocrLed) break;
				}
				if (!ocrLed) return { error: 'edited mode was not applied on tab click' };
				if ((input.value || '') !== 'deep') return { error: 'edited tab did not restore the query', value: input.value };
				// Clean up.
				const remove = document.querySelector('[aria-label="Remove tab edited"]');
				if (!remove) return { error: 'remove button missing' };
				remove.click();
				const t6 = Date.now();
				while (Date.now() - t6 < 5000) {
					await sleep(150);
					if (!document.querySelector('[aria-label="Remove tab edited"]')) break;
				}
				document.querySelector('button[aria-label="File search mode"]').click();
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return { ok: true };
			})()
		`);
		if (out.error) throw new Error(out.error);
	});

	// 5g. Model picker: opens with every manifest model, active marked, closes.
	await checkAsync(
		"UI: model picker (manifest models, active check, dismiss)",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const manifest = await fetch('/memories-models.json').then((r) => r.json());
				const expected = manifest && Array.isArray(manifest.models) ? manifest.models.length : 0;
				const btn = document.querySelector('button[aria-haspopup="listbox"]');
				if (!btn) return { error: 'picker button missing' };
				btn.click();
				const t0 = Date.now();
				let options;
				while (Date.now() - t0 < 5000) {
					await sleep(150);
					options = [...document.querySelectorAll('[role="option"]')];
					if (options.length > 0) break;
				}
				if (!options || options.length !== expected) return { error: 'expected ' + expected + ' models, got ' + (options && options.length) };
				const selected = options.find((o) => o.getAttribute('aria-selected') === 'true');
				if (!selected) return { error: 'no active model marked' };
				const label = (selected.textContent || '').replace(/\\s+/g, ' ').trim();
				const capture = document.querySelector('.fixed.inset-0.z-40');
				if (capture) capture.click();
				const t1 = Date.now();
				while (Date.now() - t1 < 5000) {
					await sleep(100);
					if (!document.querySelector('[role="option"]')) return { ok: true, selected: label };
				}
				return { error: 'picker did not close', selected: label };
			})()
		`);
			if (out.error) throw new Error(out.error);
			if (!out.selected || !out.selected.includes("CLIP")) {
				throw new Error(`unexpected active model: ${out.selected}`);
			}
		},
	);

	// 5h. Search modes.
	// Files mode: a query whose ONLY match is the poster's visible text.
	await checkAsync(
		"UI: Files mode finds the poster by its OCR text",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const filesBtn = document.querySelector('button[aria-label="File search mode"]');
				if (filesBtn) filesBtn.click();
				const input = document.querySelector('input[aria-label="Search memories"]');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				// The pre-search grid also contains poster-deep, so the hit only
				// counts once the SEARCH engaged: fewer cards than the grid and
				// the input still holding the query (same discipline as the e2e
				// searchFor helper — a stale full-grid match must not pass).
				const gridCount = document.querySelectorAll('img[alt]').length;
				setter.call(input, 'test');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');						// The OCR boost must lift the poster to the TOP of the ranking
						// for a query whose only literal evidence is the poster's own
						// visible text — no filename token, no phrase overlap. Other
						// weak semantic hits may legitimately trail it, so the claim
						// is first-place, not exclusivity.
						if (
							alts.length > 0 &&
							alts[0].includes('poster-deep') &&
							alts.length < gridCount &&
							(input.value || '') === 'test'
						) {
							setter.call(input, '');
							input.dispatchEvent(new Event('input', { bubbles: true }));
							return { ok: true, alts };
						}
				}
				return { error: 'poster-deep not found by its visible text' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// Scenes mode: exact-moment hit + seek-on-open chip in the lightbox.
	await checkAsync(
		"UI: Scenes mode finds the red moment + lightbox seeks to it",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const scenesBtn = document.querySelector('button[aria-label="Scenes search mode"]');
				if (!scenesBtn) return { error: 'scenes toggle missing' };
				scenesBtn.click();
				const input = document.querySelector('input[aria-label="Search memories"]');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, 'crimson');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 30000) {
					await sleep(400);
					const cards = [...document.querySelectorAll('img[alt]')];
					// File-mode results still render during the debounce; wait
					// for the photos to vanish (scene mode has no photos).
					if (cards.some((i) => /deep-blue|deep-red|deep-green|deep-purple|pg-/.test(i.getAttribute('alt') || ''))) continue;
					const card = cards.find((i) => (i.getAttribute('alt') || '') === 'Memory: scene-clip');
					if (!card) continue;
					const badgeEl = card.closest('.group')?.querySelector('[data-scene-badge]');
					if (badgeEl && /Scene @ 0:0[23]/.test(badgeEl.textContent || '')) {
						card.closest('.group').click();
						const t1 = Date.now();
						while (Date.now() - t1 < 8000) {
							await sleep(200);
							if ((document.body.textContent || '').includes('Jumped to scene')) {
								document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
								const filesBtn = document.querySelector('button[aria-label="File search mode"]');
								if (filesBtn) filesBtn.click();
								setter.call(input, '');
								input.dispatchEvent(new Event('input', { bubbles: true }));
								return { ok: true, badge: badgeEl.textContent.trim() };
							}
						}
						return { error: 'lightbox scene chip missing', badge: badgeEl.textContent.trim() };
					}
				}
				return { error: 'scenes-mode hit not found' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// OCR mode: only visible-text matches (positive + negative).
	await checkAsync(
		"UI: OCR mode returns only visible-text matches",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const ocrBtn = document.querySelector('button[aria-label="OCR search mode"]');
				if (!ocrBtn) return { error: 'OCR toggle missing' };
				ocrBtn.click();
				const input = document.querySelector('input[aria-label="Search memories"]');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, 'settings');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				let found = false;
				while (Date.now() - t0 < 10000) {
					await sleep(200);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.length > 0 && alts.every((a) => a.includes('scr-settings'))) { found = true; break; }
				}
				if (!found) return { error: 'OCR mode did not surface scr-settings' };
				// Negative: 'unplayable' exists ONLY in a filename — OCR mode must find nothing.
				setter.call(input, 'unplayable');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t1 = Date.now();
				while (Date.now() - t1 < 10000) {
					await sleep(200);
					if ((document.body.textContent || '').includes('No images with matching text')) {
						const filesBtn = document.querySelector('button[aria-label="File search mode"]');
						if (filesBtn) filesBtn.click();
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
						return { ok: true };
					}
				}
				return { error: 'OCR mode matched a filename-only query' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	); // 5i. Tab/mode desync regression: hopping category tabs must reset the
	// search mode so a later search doesn't run the WRONG ranker under a
	// filter that can only drop every hit. Two leaks were real: Scenes mode
	// surviving a click on a photo category tab (Screenshots) made every
	// search there run video-only scene ranking that the category filter then
	// emptied; OCR mode under the Videos tab was a guaranteed-empty
	// combination (videos are never OCR'd).
	await checkAsync(
		"UI: Scenes mode exits when a photo-category tab is clicked",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
					.find((b) => (b.textContent || '').trim() === t);
				// Enter Scenes mode so the leak would be armed.
				const scenesBtn = document.querySelector('button[aria-label="Scenes search mode"]');
				if (!scenesBtn) return { error: 'scenes toggle missing' };
				scenesBtn.click();
				await sleep(200);
				// Now click a photo-category tab. The fix resets scene mode here;
				// the old code left it on, so the search below would run scene
				// ranking (videos only) and the Screenshots filter would drop
				// them all.
				const shots = tabByText('Screenshots');
				if (!shots) return { error: 'Screenshots tab missing' };
				shots.click();
				await sleep(300);
				// A Files-mode search under Screenshots must surface scr-settings
				// (Screenshots category, literal filename token) — NOT the
				// scene-empty state.
				setter.call(input, 'settings');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.some((a) => a.includes('scr-settings'))) {
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
						const filesBtn = document.querySelector('button[aria-label="File search mode"]');
						if (filesBtn) filesBtn.click();
						const all = tabByText('All');
						if (all) all.click();
						return { ok: true, alts };
					}
					if ((document.body.textContent || '').includes('No scene matches')) {
						return { error: 'scene mode leaked into a photo-category tab', alts };
					}
				}
				return { error: 'scr-settings not found under Screenshots after exiting Scenes' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// 5j. Stale-scene-card regression: a Scenes-mode search must never leave
	// orphaned video tiles glued to the top of the grid. When the user clicks
	// back to a files-mode tab, the scene results render once more in files
	// mode (the frame between the tab click and the search effect swapping
	// the results); with plain file ids the same video's several scene hits
	// become DUPLICATE React keys, and duplicate-keyed children are orphaned
	// by reconciliation — the grid then starts with stale video cards even
	// after the query is cleared (the "party videos stuck on top" bug).
	// Scene-carrying ids carry their `@t` suffix in every mode so keys stay
	// unique.
	await checkAsync(
		"UI: scene search leaves no stale video cards after clearing",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
					.find((b) => (b.textContent || '').trim() === t);
				const alts = () => [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
				// Videos tab arms Scenes mode.
				const videos = tabByText('Videos');
				if (!videos) return { error: 'Videos tab missing' };
				videos.click();
				await sleep(300);
				// scene-clip.mp4 has TWO black shots — a "black" scene search
				// returns the same video twice, the duplicate-key trigger.
				setter.call(input, 'black');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				let sawScene = false;
				while (Date.now() - t0 < 20000) {
					await sleep(300);
					if (alts().filter((x) => x.includes('scene-clip')).length >= 2) {
						sawScene = true;
						break;
					}
				}
				if (!sawScene) return { error: 'scene search did not yield 2 scene-clip cards' };
				// Back to All (files mode) with the query still set — the frame
				// between this click and the search effect is the bug window.
				const all = tabByText('All');
				if (!all) return { error: 'All tab missing' };
				all.click();
				await sleep(1200);
				// Clear the query: the grid must be plain browse order again —
				// newest-imported first (unplayable was the last file imported).
				const clear = document.querySelector('button[aria-label="Clear search"]');
				if (clear) { clear.click(); await sleep(1200); }
				const a = alts();
				if (a.length === 0) return { error: 'grid empty after clear' };
				if (a[0] !== 'Memory: unplayable') {
					return { error: 'stale scene card glued to the top: ' + a.slice(0, 5).join(' | ') };
				}
				const dups = a.filter((x, i) => a.indexOf(x) !== i);
				if (dups.length > 0) {
					return { error: 'duplicate tiles after clearing: ' + dups.slice(0, 5).join(' | ') };
				}
				// Restore defaults for later checks.
				const filesBtn = document.querySelector('button[aria-label="File search mode"]');
				if (filesBtn) filesBtn.click();
				return { ok: true, first: a[0], count: a.length };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	await checkAsync(
		"UI: OCR mode snaps off the Videos tab (guaranteed-empty combo)",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
					.find((b) => (b.textContent || '').trim() === t);
				const videos = tabByText('Videos');
				if (!videos) return { error: 'Videos tab missing' };
				videos.click();
				await sleep(300);
				const ocrBtn = document.querySelector('button[aria-label="OCR search mode"]');
				if (!ocrBtn) return { error: 'OCR toggle missing' };
				ocrBtn.click();
				await sleep(300);
				// OCR mode must have snapped activeFilter off Videos; scr-settings
				// is a Screenshots photo with visible text — it must rank.
				setter.call(input, 'settings');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 10000) {
					await sleep(200);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.some((a) => a.includes('scr-settings'))) {
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
						const filesBtn = document.querySelector('button[aria-label="File search mode"]');
						if (filesBtn) filesBtn.click();
						const all = tabByText('All');
						if (all) all.click();
						return { ok: true, alts };
					}
				}
				return { error: 'OCR under Videos never surfaced scr-settings (filter not snapped)' };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// Files-mode empty state. On a small synthetic library the noise floor
	// can exceed the semantic cutoff (a nonsense query returns weak hits, not
	// an empty grid — the honest behavior), so measure the top cosine first
	// and only assert the empty state when it is actually reachable.
	await checkAsync(
		"UI: Files mode empty state for a nonsense query",
		async () => {
			const q = "zzzzzzzq";
			const qv = await ctx.askIndexer({ type: "embed-query", text: q });
			const lib = ctx.loadLibrary();
			let top = 0;
			if (qv && qv.vec && qv.vec.length === lib.dim) {
				for (const row of lib.embeddings) {
					let d = 0;
					for (let k = 0; k < lib.dim; k++) d += qv.vec[k] * row[k];
					if (d > top) top = d;
				}
			}
			if (!(top < 0.04)) {
				console.log(
					`  · SKIP files empty state (noise top ${top.toFixed(3)} ≥ 0.04 floor on this library)`,
				);
				return;
			}
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const filesBtn = document.querySelector('button[aria-label="File search mode"]');
				if (filesBtn) filesBtn.click();
				const input = document.querySelector('input[aria-label="Search memories"]');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, ${JSON.stringify(q)});
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					if ((document.body.textContent || '').includes('No matches for')) {
						setter.call(input, '');
					input.dispatchEvent(new Event('input', { bubbles: true }));
					return { ok: true };
				}
			}
			return { error: 'no-match empty state missing' };
		})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// ---- 6. context-menu deletes (photo + video) ------------------------
	console.log("[deep] context-menu deletes…");
	await checkAsync(
		"UI: delete a photo + a video via the tile context menu",
		async () => {
			const out = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				// Reset to the full grid first: clear any query + return to Files
				// mode so the tiles are all visible.
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (input) {
					const setter0 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
					setter0.call(input, '');
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
				const filesBtn0 = document.querySelector('button[aria-label="File search mode"]');
				if (filesBtn0) filesBtn0.click();
				await sleep(400);
				const tile = (stem) => [...document.querySelectorAll('img[alt]')]
					.find((i) => (i.getAttribute('alt') || '') === 'Memory: ' + stem)?.closest('.group');
				const delViaMenu = async (stem) => {
					let card;
					const t0 = Date.now();
					while (Date.now() - t0 < 15000) {
						card = tile(stem);
						if (card) break;
						// The grid is virtualized: only the window around the
						// viewport is mounted, so sweep both ends each retry —
						// newest items live at the TOP, oldest at the BOTTOM
						// (and the infinite-scroll sentinel keeps appending
						// pages while at the bottom).
						const atBottom = Math.abs(
							window.scrollY + window.innerHeight - document.body.scrollHeight,
						) < 8;
						window.scrollTo(0, atBottom ? 0 : document.body.scrollHeight);
						await sleep(250);
					}
					if (!card) return 'tile missing: ' + stem;
					card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, button: 2 }));
					const t1 = Date.now();
					let menu;
					while (Date.now() - t1 < 5000) {
						menu = document.querySelector('[role="menu"]');
						if (menu) break;
						await sleep(100);
					}
					if (!menu) return 'menu did not open for ' + stem;
					const del = [...menu.querySelectorAll('[role="menuitem"]')].find((m) =>
						(m.textContent || '').includes('Delete'));
					if (!del) return 'delete item missing for ' + stem;
					del.click();
					const t2 = Date.now();
					while (Date.now() - t2 < 15000) {
						if (!tile(stem)) return null;
						await sleep(250);
					}
					return 'tile still present after delete: ' + stem;
				};
				const a = await delViaMenu('deep-purple');
				if (a) return { error: a };
				const b = await delViaMenu('unplayable');
				if (b) return { error: b };
				return { ok: true };
			})()
		`);
			if (out.error) throw new Error(out.error);
		},
	);

	// ---- 7. post-delete integrity ---------------------------------------
	console.log("[deep] post-delete integrity…");
	const l2 = ctx.loadLibrary();
	check("delete: library rows dropped to 31 and aligned", () => {
		const expect31 = expect - 2;
		const lens = [
			l2.filenames,
			l2.sources,
			l2.ocr,
			l2.embeddings,
			l2.phrases,
		].map((a) => a.length);
		if (new Set(lens).size !== 1 || lens[0] !== expect31) {
			throw new Error(
				`after delete: ${JSON.stringify(lens)} (expected ${expect31})`,
			);
		}
		if (
			l2.filenames.includes("deep-purple.jpg") ||
			l2.filenames.includes("unplayable.mkv")
		) {
			throw new Error("deleted filenames still present");
		}
	});
	check("delete: library copy + poster removed from disk", () => {
		if (fs.existsSync(path.join(ctx.PHOTOS_DIR, "deep-purple.jpg"))) {
			throw new Error("deleted photo copy still on disk");
		}
		if (fs.existsSync(path.join(ctx.POSTERS_DIR, "unplayable.jpg"))) {
			throw new Error("deleted video poster still on disk");
		}
		const stem = "unplayable";
		for (const entry of fs.readdirSync(ctx.POSTERS_DIR)) {
			if (entry.startsWith(`${stem}-scene-`) && entry.endsWith(".jpg")) {
				throw new Error(`deleted video scene poster remains: ${entry}`);
			}
		}
	});
	check("delete: scene segments for the deleted video removed", () => {
		const c = ctx.loadSegments(l2.modelId);
		if (c.videos.has("unplayable.mkv"))
			throw new Error("deleted video still in segment sidecar");
		if (!c.videos.has("scene-clip.mp4") || !c.videos.has("playable.mp4")) {
			throw new Error("surviving videos lost their segments");
		}
	});
	await checkAsync(
		"delete: served index matches the on-disk library",
		async () => {
			const served = await win.webContents.executeJavaScript(
				"fetch('/memories-index.json').then(r => r.json()).then(j => ({ n: j.images.length, bad: j.images.some((f) => f.includes('deep-purple') || f.includes('unplayable')) }))",
			);
			if (served.n !== l2.filenames.length || served.bad) {
				throw new Error(
					`served index ${JSON.stringify(served)} vs library ${l2.filenames.length}`,
				);
			}
			const b = ctx.binInfo(l2.modelId);
			if (!b || b.rows !== l2.filenames.length) {
				throw new Error(`bins out of sync after delete: ${JSON.stringify(b)}`);
			}
		},
	);

	// ---- 8. phrase-bin heal ---------------------------------------------
	console.log("[deep] phrase-bin heal…");
	await checkAsync(
		"heal: a zeroed phrase row is detected and re-embedded",
		async () => {
			const l3 = ctx.loadLibrary();
			const idx = l3.filenames.indexOf("deep-blue.jpg");
			if (idx === -1) throw new Error("deep-blue.jpg missing");
			// Corrupt in memory AND on disk (the persisted row the next launch
			// would read).
			l3.phrases[idx].fill(0);
			const binFile = ctx.phraseFileFor(l3.modelId);
			const buf = fs.readFileSync(binFile);
			new Float32Array(
				buf.buffer,
				buf.byteOffset + 8 + idx * l3.dim * 4,
				l3.dim,
			).fill(0);
			fs.writeFileSync(binFile, buf);
			const { healed, attempted } = await ctx.healPhraseBin();
			if (attempted < 1 || healed < 1) {
				throw new Error(`heal attempted=${attempted} healed=${healed}`);
			}
			let norm = 0;
			for (let k = 0; k < l3.phrases[idx].length; k++)
				norm += l3.phrases[idx][k] ** 2;
			if (norm < 1e-4) throw new Error("phrase row still zero after heal");
			// And the on-disk bin must carry the repair too.
			const buf2 = fs.readFileSync(binFile);
			const row = new Float32Array(
				buf2.buffer,
				buf2.byteOffset + 8 + idx * l3.dim * 4,
				l3.dim,
			);
			let norm2 = 0;
			for (let k = 0; k < row.length; k++) norm2 += row[k] ** 2;
			if (norm2 < 1e-4)
				throw new Error("on-disk phrase row still zero after heal");
		},
	);

	if (failed > 0) {
		throw new Error(`${failed} deep check(s) failed (${passed} passed)`);
	}
	console.log(`[deep] OK (${passed} checks)`);
}
