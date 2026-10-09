"use strict";

// E2E smoke driver: import two known-content photos, verify semantic ranking.
// Runs inside the app process; prod seams arrive via ctx (C-01).
// Extracted from main.js verbatim (C-01 9/10), except: relative requires
// re-pointed at scripts/e2e/.., and the two live main-process counters
// (enrichEventsObserved, enrichQueue) arrive as getters — they mutate after
// the driver starts, so a destructured snapshot would go stale.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// E2E smoke: import two known-content photos, verify semantic ranking
// ---------------------------------------------------------------------------

async function runE2E(ctx) {
	const {
		cold = false,
		app,
		BrowserWindow,
		importPaths,
		loadLibrary,
		askIndexer,
		cosine,
		VIDEO_EXTENSIONS,
		segmentsBinFileFor,
		segmentsMetaFileFor,
		getEnrichEventsObserved,
		getEnrichQueue,
	} = ctx;
	const tmp = fs.mkdtempSync(path.join(app.getPath("temp"), "memories-e2e-"));
	const sharp = (await import("sharp")).default;
	const blue = path.join(tmp, "blue-square.jpg");
	const red = path.join(tmp, "red-square.jpg");
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 40, g: 80, b: 220 },
		},
	})
		.jpeg()
		.toFile(blue);
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 220, g: 60, b: 50 },
		},
	})
		.jpeg()
		.toFile(red);

	// Format battery: one playable (mov/h264) and three searchable-only
	// containers (mkv, avi, ts) — the formats that used to be rejected.
	const ffmpeg = (() => {
		try {
			return require("../../indexer/video-utils.js").resolveFfmpeg();
		} catch {
			return null;
		}
	})();
	const genFormats = {
		"green-clip.mp4": [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=96x96:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
		],
		"green-clip.mov": [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=96x96:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
		],
		"green-clip.mkv": [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=96x96:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
		],
		"green-clip.avi": [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=96x96:d=2",
			"-c:v",
			"mpeg4",
		],
		"green-clip.ts": [
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=96x96:d=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
		],
	};
	const generated = [];
	if (ffmpeg) {
		const cp = require("child_process");
		for (const [name, args] of Object.entries(genFormats)) {
			const gen = cp.spawnSync(ffmpeg, ["-y", ...args, path.join(tmp, name)], {
				encoding: "utf8",
			});
			if (gen.status === 0 && fs.existsSync(path.join(tmp, name))) {
				generated.push(path.join(tmp, name));
			} else {
				console.warn(`[e2e] generation failed for ${name}, skipping`);
			}
		}
	} else {
		console.warn("[e2e] no ffmpeg, skipping video checks");
	}

	// Optional real-world files (ELECTRON_SMOKE_IMPORT_FILES): absolute paths,
	// comma-separated, e.g. the user's own movie files. Each must import and
	// get a poster — the actual failure the user hit.
	const extraFiles = (process.env.ELECTRON_SMOKE_IMPORT_FILES || "")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p && fs.existsSync(p));

	// A second in-session batch: imports after the first must extend the
	// SEARCHABLE set, not just the grid. purple-square.jpg shares no filename
	// tokens with the semantic-only probe "a deep violet color", so it can
	// only appear through the freshly reloaded embeddings. (A bland probe
	// like "a minimalist color field" would NOT find purple in the search
	// view: the diversity filter collapses near-duplicates, and purple is a
	// near-duplicate of blue — sim > 0.92. The query must be one purple
	// wins outright.)
	const purple = path.join(tmp, "purple-square.jpg");
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 150, g: 60, b: 200 },
		},
	})
		.jpeg()
		.toFile(purple);

	const files = [blue, red, ...generated, ...extraFiles];
	const win = BrowserWindow.getAllWindows()[0];

	// DOM-driven search through the real UI: clear the search box, wait for
	// the grid to render (baseline count), type into the search box, and
	// poll for an <img alt> containing `needle` (alt = "Memory: {stem}").
	// STRICT by construction: the needle only counts once the SEARCH engine
	// demonstrably ran — the "Ranking/Refining with AI" pill must have been
	// observed (it only exists while the semantic pass is in flight) with
	// the input still holding the query. A hit in the plain grid (query
	// never engaged) is not accepted, which is how an earlier revision of
	// this test false-passed. A query whose tokens appear in NO filename
	// can only match through the semantic path, so that is the detector for
	// a stale renderer index. NOTE: the old "fewer cards than the grid"
	// gate was removed — it assumed the ranking always collapses the
	// library below gridCount, which is not true of the default CLIP model on
	// a small solid-color library (every file honestly clears the low
	// noise floor, so the grid keeps its size while the search re-ranks).
	const searchFor = async (query, needle, timeoutMs = 20000) => {
		return win.webContents.executeJavaScript(`
			(async () => {
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: "search box not found" };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				const gridCount = await (async () => {
					setter.call(input, "");
					input.dispatchEvent(new Event('input', { bubbles: true }));
					const t = Date.now();
					while (Date.now() - t < 10000) {
						await new Promise((r) => setTimeout(r, 200));
						const n = [...document.querySelectorAll('img[alt]')].length;
						if (n > 1) return n;
					}
					return 0;
				})();
				setter.call(input, ${JSON.stringify(query)});
				input.dispatchEvent(new Event('input', { bubbles: true }));
				// The semantic engine must prove it ran: the ranking pill
				// ("Ranking with AI" / "Refining with AI") only renders while
				// semanticPending is true, i.e. between the debounce firing and
				// the query embedding + ranking resolving.
				let pillSeen = false;
				const t0 = Date.now();
				while (Date.now() - t0 < ${timeoutMs}) {
					await new Promise((r) => setTimeout(r, 250));
					const pill = [...document.querySelectorAll('span')].find((s) =>
						/Ranking with AI|Refining with AI/.test((s.textContent || '').trim()),
					);
					if (pill) pillSeen = true;
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt'));
					const matching = alts.filter((a) => a && a.toLowerCase().includes(${JSON.stringify(needle)}));
					if (matching.length > 0 && input.value === ${JSON.stringify(query)} && pillSeen) {
						return { found: matching.slice(0, 5), gridCount, alts: alts.slice(0, 30) };
					}
				}
				return {
					notFound: [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).slice(0, 30),
					inputValue: input.value,
					gridCount,
					pillSeen,
				};
			})()
		`);
	};

	if (cold) {
		// Cold-restart persistence: run against the library written by the
		// previous (warm) session. No import here — the index trio must be
		// exactly what the warm run persisted, and both batches must be
		// searchable on a fresh renderer mount. Batch 1 is probed with "a
		// minimalist color field" (green-clip, the strongest surviving hit),
		// batch 2 with "a deep violet color" (purple wins outright, so the
		// diversity filter cannot collapse it away).
		const q1 = await searchFor("a minimalist color field", "green-clip");
		if (q1.error || !q1.found) {
			throw new Error(
				`cold-start semantic search missing batch-1 photo: ${JSON.stringify(q1)}`,
			);
		}
		const q2 = await searchFor("a deep violet color", "purple-square");
		if (q2.error || !q2.found) {
			throw new Error(
				`cold-start semantic search missing batch-2 photo: ${JSON.stringify(q2)}`,
			);
		}
		console.log(
			"[e2e] cold-start semantic search OK (both batches searchable)",
		);
		const persisted = await win.webContents.executeJavaScript(
			"fetch('/memories-index.json').then(r => r.json()).then(j => ({ n: j.images.length, purple: j.images.includes('purple-square.jpg'), green: j.images.includes('green-clip.mp4') }))",
		);
		const l = loadLibrary();
		if (
			!persisted.purple ||
			!persisted.green ||
			persisted.n !== l.filenames.length
		) {
			throw new Error(`cold-start index wrong: ${JSON.stringify(persisted)}`);
		}
		console.log("[e2e] cold-start index persisted OK");
		return;
	}

	const res = await importPaths(files);
	if (res.added.length !== files.length) {
		throw new Error(`import failed: ${JSON.stringify(res)}`);
	}
	console.log(`[e2e] imported ${res.added.join(", ")}`);

	const l = loadLibrary();
	const blueIdx = l.filenames.indexOf("blue-square.jpg");
	const redIdx = l.filenames.indexOf("red-square.jpg");
	if (blueIdx === -1 || redIdx === -1)
		throw new Error("filenames missing from library");

	const qBlue = await askIndexer({
		type: "embed-query",
		text: "a blue square",
	});
	const qRed = await askIndexer({ type: "embed-query", text: "a red square" });
	if (!qBlue.vec || !qRed.vec) throw new Error("query embed failed");

	const bBlue = cosine(qBlue.vec, l.embeddings[blueIdx]);
	const bRed = cosine(qBlue.vec, l.embeddings[redIdx]);
	const rBlue = cosine(qRed.vec, l.embeddings[blueIdx]);
	const rRed = cosine(qRed.vec, l.embeddings[redIdx]);
	console.log(
		`[e2e] "a blue square": blue=${bBlue.toFixed(3)} red=${bRed.toFixed(3)}`,
	);
	console.log(
		`[e2e] "a red square":  blue=${rBlue.toFixed(3)} red=${rRed.toFixed(3)}`,
	);

	if (!(bBlue > bRed))
		throw new Error(`blue query ranked wrong (${bBlue} vs ${bRed})`);
	if (!(rRed > rBlue))
		throw new Error(`red query ranked wrong (${rRed} vs ${rBlue})`);

	const persisted = await win.webContents.executeJavaScript(
		"fetch('/memories-index.json').then(r => r.json()).then(j => j.images)",
	);
	if (
		!persisted.includes("blue-square.jpg") ||
		!persisted.includes("red-square.jpg")
	) {
		throw new Error(`index served to renderer missing imports: ${persisted}`);
	}

	// Video: poster exists, Range requests work, and the green mp4 ranks for
	// "a green square" in the REAL UI search box (DOM-driven, not cosine math).
	{
		const greenIdx = l.filenames.indexOf(
			generated.length ? "green-clip.mp4" : "",
		);
		if (generated.length && greenIdx === -1)
			throw new Error("video missing from library");
		if (generated.length) {
			const qGreen = await askIndexer({
				type: "embed-query",
				text: "a green square",
			});
			if (!qGreen.vec) throw new Error("green query embed failed");
			const gGreen = cosine(qGreen.vec, l.embeddings[greenIdx]);
			const gBlue = cosine(qGreen.vec, l.embeddings[blueIdx]);
			const gRed = cosine(qGreen.vec, l.embeddings[redIdx]);
			console.log(
				`[e2e] "a green square": green=${gGreen.toFixed(3)} blue=${gBlue.toFixed(3)} red=${gRed.toFixed(3)}`,
			);
			if (!(gGreen > gBlue && gGreen > gRed)) {
				throw new Error(
					`green query ranked wrong (${gGreen} vs ${gBlue} / ${gRed})`,
				);
			}
		}

		// Every imported video (battery + real files) must serve a poster and
		// a satisfiable Range request.
		for (const name of res.added.filter((n) =>
			require("../../indexer/video-utils.js").VIDEO_EXTENSIONS.has(
				require("path").extname(n).toLowerCase(),
			),
		)) {
			const stem = name.replace(/\.[^.]+$/, "");
			const posterStatus = await win.webContents.executeJavaScript(
				`fetch('/images/posters/${stem}.jpg').then(r => ({ s: r.status, t: r.headers.get('content-type') }))`,
			);
			if (posterStatus.s !== 200 || !posterStatus.t.startsWith("image/jpeg")) {
				throw new Error(
					`poster fetch bad for ${name}: ${JSON.stringify(posterStatus)}`,
				);
			}
			const range = await win.webContents.executeJavaScript(`
				fetch('/images/projects/${name}', { headers: { 'Range': 'bytes=0-99' } })
					.then(r => Promise.all([r.status, r.headers.get('content-range'), r.arrayBuffer().then(b => b.byteLength)]))
			`);
			if (range[0] !== 206 || !range[1] || range[2] !== 100) {
				throw new Error(
					`video range fetch bad for ${name}: ${JSON.stringify(range)}`,
				);
			}
		}
		console.log("[e2e] video posters + range serving OK");

		// Scene-segment enrichment (Phase 1): every imported video is analyzed
		// in the background after the batch. Poll the sidecar until all of the
		// batch's videos have a segment entry — each 2s solid-color clip has
		// no shot boundaries, so the interval fallback yields exactly 1
		// segment per video. Also assert the bin header matches the meta
		// total (row-offset alignment).
		{
			const videoNames = res.added.filter((n) =>
				VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase()),
			);
			const metaFile = segmentsMetaFileFor(loadLibrary().modelId);
			const deadline = Date.now() + 60000;
			let meta = null;
			while (Date.now() < deadline) {
				try {
					meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
					const covered = meta.videos || [];
					if (
						videoNames.every((n) =>
							covered.some(
								(v) => v.filename === n && v.segments && v.segments.length > 0,
							),
						)
					) {
						break;
					}
				} catch {
					/* sidecar not written yet */
				}
				await new Promise((r) => setTimeout(r, 500));
			}
			if (!meta) throw new Error("scene-segment sidecar never appeared");
			const missing = videoNames.filter(
				(n) =>
					!(meta.videos || []).some(
						(v) => v.filename === n && v.segments && v.segments.length > 0,
					),
			);
			if (missing.length > 0) {
				throw new Error(`videos missing scene segments: ${missing.join(", ")}`);
			}
			// The sidecar persists asynchronously (serialized queue with
			// fsync): the meta file above can be current while the bin file
			// lags one save behind on a loaded runner. Wait for the bin
			// header to catch up with the meta total before comparing —
			// otherwise a stale bin fails a healthy enrichment.
			const binFile = segmentsBinFileFor(loadLibrary().modelId);
			const drainDeadline = Date.now() + 60000;
			for (;;) {
				const b = fs.readFileSync(binFile);
				const h = new Int32Array(b.buffer, b.byteOffset, 2);
				if (h[0] >= (meta.total || 0)) break;
				if (Date.now() >= drainDeadline) break;
				await new Promise((r) => setTimeout(r, 500));
			}
			// Fresh pair for the strict assert (no commits in flight here:
			// single-chunk clips, coverage already met).
			meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
			const bin = fs.readFileSync(binFile);
			const header = new Int32Array(bin.buffer, bin.byteOffset, 2);
			if (header[0] !== (meta.total || 0)) {
				throw new Error(
					`segment bin header (${header[0]}) != meta total (${meta.total})`,
				);
			}
			console.log(
				`[e2e] scene-segment enrichment OK (${videoNames.length} videos, ${header[0]} segment rows)`,
			);
		}

		// DOM-driven search through the real UI.
		if (generated.length) {
			// 1) Keyword-visible query: "green" appears in green-clip.*
			//    filenames, so this passes even on a stale index.
			const k = await searchFor("a green square", "green-clip");
			if (k.error || !k.found) {
				throw new Error(`UI search failed: ${JSON.stringify(k)}`);
			}
			console.log(
				`[e2e] UI search "a green square" found: ${k.found.join(", ")}`,
			);

			// 2) Semantic-only query: every token ("minimalist", "color",
			//    "field") is absent from every test filename, so results can
			//    only come from the CLIP path. On the pre-fix build the
			//    renderer ranked against a stale mount-time index (0 files
			//    here) → alignment guard returned [] → keyword fallback
			//    found nothing → "No matches". This is THE regression test.
			const s = await searchFor(
				"a minimalist color field",
				"green-clip",
				30000,
			);
			if (s.error || !s.found) {
				throw new Error(
					`semantic-only UI search failed (stale renderer index?): ${JSON.stringify(s)}`,
				);
			}
			console.log(`[e2e] semantic-only UI search found: ${s.found.join(", ")}`);

			// 3) Second in-session import: purple-square.jpg lands AFTER the
			//    first batch. It must become searchable (fresh embeddings
			//    reload), not just visible in the grid.
			const res2 = await importPaths([purple]);
			if (res2.added.length !== 1) {
				throw new Error(`second import failed: ${JSON.stringify(res2)}`);
			}
			const gridPurple = await win.webContents.executeJavaScript(`
				(async () => {
					const input = document.querySelector('input[aria-label="Search memories"]');
					if (input) {
						const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
					}
					const t0 = Date.now();
					while (Date.now() - t0 < 20000) {
						await new Promise((r) => setTimeout(r, 300));
						const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt'));
						if (alts.some((a) => a && a.includes('purple-square'))) return { ok: true };
					}
					return { ok: false };
				})()
			`);
			if (!gridPurple.ok) {
				throw new Error("second import did not appear in the grid");
			}
			const s2 = await searchFor("a deep violet color", "purple-square", 30000);
			if (s2.error || !s2.found) {
				throw new Error(
					`batch-2 photo not searchable (no reload after second import): ${JSON.stringify(s2)}`,
				);
			}
			console.log(
				`[e2e] batch-2 import searchable after live reload: ${s2.found.join(", ")}`,
			);

			// 4) Mechanism check: the served embeddings bin must agree with
			//    the served index after both batches.
			const binCheck = await win.webContents.executeJavaScript(`
				Promise.all([
					fetch('/memories-index.json').then(r => r.json()),
					fetch('/memory-embeddings.bin').then(r => r.arrayBuffer()),
					fetch('/memory-phrase-embeddings.bin').then(r => r.arrayBuffer()),
				]).then(([idx, emb, phr]) => {
					const n1 = new Int32Array(emb, 0, 1)[0];
					const n2 = new Int32Array(phr, 0, 1)[0];
					return { images: idx.images.length, emb: n1, phr: n2, ok: idx.images.length === n1 && n1 === n2 };
				})
			`);
			if (!binCheck.ok) {
				throw new Error(
					`embedding bins out of sync with index: ${JSON.stringify(binCheck)}`,
				);
			}
			console.log(
				`[e2e] embedding bins in sync with index (${binCheck.images})`,
			);
		}
	}

	// Tile right-click context menu: clear any search, dispatch a native
	// contextmenu on a grid tile, expect the custom menu to mount with both
	// actions, then dismiss with Escape. The reveal action itself is never
	// clicked here — that would open a Finder window.
	{
		const menu = await win.webContents.executeJavaScript(`
			(async () => {
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (input) {
					const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
					setter.call(input, '');
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
				const t0 = Date.now();
				let img = null;
				while (Date.now() - t0 < 10000) {
					await new Promise((r) => setTimeout(r, 150));
					img = [...document.querySelectorAll('img[alt]')].find((i) => (i.getAttribute('alt') || '').includes('blue-square'));
					if (img) break;
				}
				if (!img) return { error: 'grid tile not found after clearing search' };
				const tile = img.closest('.group');
				if (!tile) return { error: 'tile wrapper not found' };
				tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 160, button: 2 }));
				const t1 = Date.now();
				while (Date.now() - t1 < 5000) {
					await new Promise((r) => setTimeout(r, 100));
					const el = document.querySelector('[role="menu"]');
					if (el) {
						const text = el.textContent || '';
						const ok = text.includes('Show in Finder') && text.includes('Open');
						window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
						const t2 = Date.now();
						while (Date.now() - t2 < 3000) {
							await new Promise((r) => setTimeout(r, 100));
							if (!document.querySelector('[role="menu"]')) return { ok, dismissed: true };
						}
						return { ok, error: 'menu did not dismiss on Escape' };
					}
				}
				return { error: 'menu did not appear' };
			})()
		`);
		if (menu.error || !menu.ok || !menu.dismissed) {
			throw new Error(
				`tile context menu check failed: ${JSON.stringify(menu)}`,
			);
		}
		console.log("[e2e] tile context menu mounts + dismisses with Escape");
	}

	const photoBytes = await win.webContents.executeJavaScript(
		"fetch('/images/projects/blue-square.jpg').then(r => r.status)",
	);
	if (photoBytes !== 200) throw new Error(`photo fetch status ${photoBytes}`);
	console.log("[e2e] renderer sees imported photos via protocol");

	// Phase-2 scene search: import a clip whose RED scene sits between the
	// file-level 20/50/80% sample frames (2s/5s/8s of a 10s clip) — the
	// 3-frame average is all black, so only the shot-segment pass can find
	// the red moment. Assert the search-result card shows a "Scene @" badge
	// with the red midpoint (0:03) and swaps to the scene poster.
	if (ffmpeg) {
		const cp2 = require("child_process");
		const sceneVideo = path.join(tmp, "scene-clip.mp4");
		const genScene = cp2.spawnSync(
			ffmpeg,
			[
				"-y",
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
				sceneVideo,
			],
			{ encoding: "utf8" },
		);
		if (genScene.status !== 0 || !fs.existsSync(sceneVideo)) {
			console.warn("[e2e] scene-clip generation failed; skipping badge check");
		} else {
			const res2 = await importPaths([sceneVideo]);
			if (res2.added.length !== 1) {
				throw new Error(`scene-clip import failed: ${JSON.stringify(res2)}`);
			}
			// The background enrichment queue analyzes scene-clip AFTER its
			// batch — poll the sidecar until it has the 3 segments (black /
			// red / black) before searching for them.
			const metaFile2 = segmentsMetaFileFor(loadLibrary().modelId);
			const deadline2 = Date.now() + 60000;
			while (Date.now() < deadline2) {
				try {
					const m2 = JSON.parse(fs.readFileSync(metaFile2, "utf8"));
					const v = (m2.videos || []).find(
						(x) => x.filename === "scene-clip.mp4",
					);
					if (v && v.segments && v.segments.length >= 3) break;
				} catch {
					/* not enriched yet */
				}
				await new Promise((r) => setTimeout(r, 500));
			}

			// Phase 4: background enrichment must stream live progress to the
			// tray (at least one event during scene-clip's analysis).
			if (getEnrichEventsObserved() === 0) {
				throw new Error(
					"no enrich-progress events were broadcast during enrichment",
				);
			}
			console.log(
				`[e2e] enrichment progress broadcast OK (${getEnrichEventsObserved()} event(s))`,
			);

			// Phase 4: the duration-aware budget (30 s target, 8..128 band)
			// is what gives a 90-minute film end-to-end coverage.
			const vUtilsE2E = require("../../indexer/video-utils.js");
			const budgetChecks = [
				[10, 8], // shortest clip → floor
				[600, 20], // 10 min → one point per 30 s
				[2700, 90], // 45 min
				[5400, 128], // 90 min → ceiling (was 32, front-biased)
				[10800, 128], // 3 h stays bounded
			];
			for (const [secs, expected] of budgetChecks) {
				const got = vUtilsE2E.segmentBudgetFor(secs);
				if (got !== expected) {
					throw new Error(
						`segmentBudgetFor(${secs}) = ${got}, expected ${expected}`,
					);
				}
			}
			console.log(
				"[e2e] duration-aware segment budget OK (8..128, 30 s target)",
			);

			// Search through the real UI. Batch-3's library-updated already
			// invalidated the renderer's segment cache, so the first video
			// search refetches the sidecar (scene-clip included) and the scene
			// pass attaches the badge in the SAME search.
			// The query is "crimson" (not "a red square"): a red-square PHOTO
			// dominates that query via the filename/phrase boost, so its
			// relative cutoff (0.6×top) sits above ANY semantic-only scene
			// score — the rescue would rightly not fire. "crimson" shares no
			// filename tokens, so the top is a raw cosine (~0.10) and the
			// clip's red segment (~0.09) clears the cutoff (~0.06): the video
			// is rescued purely on scene evidence, exactly the feature.
			const badge = await win.webContents.executeJavaScript(`
				(async () => {
					const input = document.querySelector('input[aria-label="Search memories"]');
					if (!input) return { error: "search box not found" };
					const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
					setter.call(input, "crimson");
					input.dispatchEvent(new Event('input', { bubbles: true }));
					const t0 = Date.now();
					while (Date.now() - t0 < 30000) {
						await new Promise((r) => setTimeout(r, 400));
						const cards = [...document.querySelectorAll('img[alt]')];
						const card = cards.find((i) => i.getAttribute('alt') === 'Memory: scene-clip');
						if (!card) continue;
						const badgeEl = card.closest('.group')?.querySelector('[data-scene-badge]');
						if (badgeEl && /Scene @ 0:0[23]/.test(badgeEl.textContent || '')) {
							return { badge: badgeEl.textContent.trim(), src: card.getAttribute('src') };
						}
					}
					return {
						missing: true,
						alts: [...document.querySelectorAll('img[alt]')]
							.map((i) => i.getAttribute('alt'))
							.slice(0, 20),
					};
				})()
			`);
			if (badge.error || badge.missing) {
				throw new Error(`scene badge not found: ${JSON.stringify(badge)}`);
			}
			if (!badge.src || !badge.src.includes("scene-clip-scene-")) {
				throw new Error(`card did not swap to the scene poster: ${badge.src}`);
			}
			console.log(
				`[e2e] scene badge + scene-poster swap OK (${badge.badge}, poster ${badge.src})`,
			);

			// Scenes mode (Phase 3): the toggle scores EVERY segment across
			// every video. For "crimson" only scene-clip's red shot clears
			// the floor, so the grid shows the exact moment (badge 0:03) —
			// and it must be the ONLY card (green-clip shots are below the
			// floor, photos don't participate). The input still holds
			// "crimson" from the badge check; clicking the toggle re-runs
			// the search in scene mode.
			const sceneHit = await win.webContents.executeJavaScript(`
				(async () => {
					const scenesBtn = document.querySelector('button[aria-label="Scenes search mode"]');
					if (!scenesBtn) return { error: "scenes toggle not found" };
					scenesBtn.click();
					// The toggle click re-runs the debounced search; for a beat
					// the grid still shows the FILE-mode results, which ALSO
					// contain scene-clip + its badge. Photos can never appear in
					// scenes-mode results, so wait for them to vanish before
					// trusting the card set (deterministic, not a timing guess).
					const isPhoto = (alt) =>
						/red-square|purple-square|blue-square/.test(alt || '');
					const t0 = Date.now();
					while (Date.now() - t0 < 30000) {
						await new Promise((r) => setTimeout(r, 400));
						const cards = [...document.querySelectorAll('img[alt]')];
						if (cards.some((i) => isPhoto(i.getAttribute('alt')))) continue;
						const card = cards.find((i) => i.getAttribute('alt') === 'Memory: scene-clip');
						if (!card) continue;
						const badgeEl = card.closest('.group')?.querySelector('[data-scene-badge]');
						if (badgeEl && /Scene @ 0:0[23]/.test(badgeEl.textContent || '')) {
							return {
								badge: badgeEl.textContent.trim(),
								top: cards[0]?.getAttribute('alt') ?? null,
								count: cards.length,
								alts: cards.map((i) => i.getAttribute('alt')).slice(0, 10),
							};
						}
					}
					return {
						missing: true,
						alts: [...document.querySelectorAll('img[alt]')]
							.map((i) => i.getAttribute('alt'))
							.slice(0, 20),
					};
				})()
			`);
			if (sceneHit.error || sceneHit.missing) {
				throw new Error(
					`scenes mode hit not found: ${JSON.stringify(sceneHit)}`,
				);
			}
			// The exact moment must rank FIRST. Other videos may trail (the
			// same relative cutoff the file ranking uses), so no count gate.
			if (sceneHit.top !== "Memory: scene-clip") {
				throw new Error(
					`scenes mode did not rank the shot first: ${JSON.stringify(sceneHit)}`,
				);
			}
			console.log(
				`[e2e] scenes mode ranks the exact moment OK (${sceneHit.badge}, top of ${sceneHit.count})`,
			);

			// Phase 4 tray: let the background queue fully drain so no real
			// progress event races the injected ones below, then verify the
			// pill appears for active analysis and clears on idle.
			const drainDeadline = Date.now() + 120000;
			while (getEnrichQueue().length > 0 && Date.now() < drainDeadline) {
				await new Promise((r) => setTimeout(r, 500));
			}
			win.webContents.send("memories:status", {
				type: "enrich",
				phase: "embed",
				filename: "scene-clip.mp4",
				done: 1,
				total: 3,
				pending: 2,
				active: true,
			});
			const trayShown = await win.webContents.executeJavaScript(`
				(async () => {
					const t0 = Date.now();
					while (Date.now() - t0 < 15000) {
						await new Promise((r) => setTimeout(r, 200));
						const pill = document.querySelector('[data-enrich-tray]');
						if (pill && /Embedding scenes/.test(pill.textContent || '')) {
							return { ok: true, text: pill.textContent.replace(/\\s+/g, ' ').trim() };
						}
					}
					return { ok: false };
				})()
			`);
			if (!trayShown.ok) {
				throw new Error(
					`enrich tray did not appear: ${JSON.stringify(trayShown)}`,
				);
			}
			win.webContents.send("memories:status", {
				type: "enrich",
				phase: "idle",
				pending: 0,
			});
			const trayHidden = await win.webContents.executeJavaScript(`
				(async () => {
					const t0 = Date.now();
					while (Date.now() - t0 < 15000) {
						await new Promise((r) => setTimeout(r, 200));
						if (!document.querySelector('[data-enrich-tray]')) return { ok: true };
					}
					return { ok: false };
				})()
			`);
			if (!trayHidden.ok) {
				throw new Error("enrich tray did not clear on idle");
			}
			console.log(
				`[e2e] enrich tray shows progress and clears on idle OK ("${trayShown.text}")`,
			);
		}
	} else {
		console.warn("[e2e] no ffmpeg, skipping scene badge check");
	}

	console.log("[e2e] OK");
}
module.exports = { runE2E };
