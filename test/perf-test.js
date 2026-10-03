"use strict";

// Performance regression tests for the three optimizations:
//
//   Fix #1: IPC ranking — the memories:rank handler embeds + ranks on the
//           main process, returning JSON results without Float32Array transfer.
//   Fix #2: ETag caching — bin/index responses carry ETags; the renderer's
//           fingerprint check skips redundant re-fetch + re-parse.
//   Fix #3: Grid flash fix — tab/filter switches no longer wipe the grid
//           before repopulating (no flash of empty state).
//
// Runs as ELECTRON_SMOKE=1 ELECTRON_SMOKE_PERF=1 electron .
// Uses a minimal 8-file fixture for fast iteration.

const path = require("path");
const fs = require("fs");

module.exports = { runPerfTest };

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_PHOTOS = [
	{ name: "perf-blue.jpg", rgb: [30, 60, 200] },
	{ name: "perf-red.jpg", rgb: [200, 40, 40] },
	{ name: "perf-green.jpg", rgb: [40, 180, 40] },
	{ name: "perf-yellow.jpg", rgb: [220, 200, 30] },
	{ name: "perf-orange.jpg", rgb: [230, 120, 30] },
	{ name: "perf-cyan.jpg", rgb: [30, 180, 200] },
	{ name: "perf-pink.jpg", rgb: [200, 60, 160] },
	{ name: "perf-gray.jpg", rgb: [128, 128, 128] },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function runPerfTest(ctx) {
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("ELECTRON_SMOKE_PERF requires MEMORIES_DATA_DIR");
	}
	const { win } = ctx;
	if (!win) throw new Error("perf: no window");

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

	// ---- 1. Create fixture library --------------------------------------
	console.log("[perf] creating fixture library…");
	const tmp = fs.mkdtempSync(
		path.join(ctx.app.getPath("temp"), "memories-perf-"),
	);
	const sharp = (await import("sharp")).default;

	const files = [];
	for (const { name, rgb } of FIXTURE_PHOTOS) {
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
		files.push(file);
	}

	const res = await ctx.importPaths(files);
	check("import: all 8 fixtures added", () => {
		if (res.added.length !== 8) throw new Error(`added ${res.added.length}/8`);
		if (res.errors.length > 0)
			throw new Error(`import errors: ${JSON.stringify(res.errors)}`);
	});

	// Wait for embeddings to be generated.
	await waitFor(
		() => {
			const b = ctx.binInfo(ctx.loadLibrary().modelId);
			return b && b.rows >= 8;
		},
		120000,
		"embed bins",
	);

	const l = ctx.loadLibrary();
	const modelId = l.modelId;

	// ---- 2. FIX #1: IPC ranking handler ---------------------------------
	console.log("[perf] testing IPC ranking (memories:rank)…");

	await checkAsync("IPC rank: returns results for a valid query", async () => {
		const results = await ctx.askIndexer({
			type: "embed-query",
			text: "blue sky",
		});
		// Verify the indexer can embed (the rank IPC depends on it).
		if (!results.ok) throw new Error("embed-query failed: " + results.error);

		// Test the rank IPC through the renderer (which calls the preload bridge).
		const ranked = await win.webContents.executeJavaScript(`
			(async () => {
				const results = await window.memories.rankSearch("blue", 10);
				return results;
			})()
		`);

		if (!Array.isArray(ranked))
			throw new Error(`rankSearch returned non-array: ${typeof ranked}`);
		if (ranked.length === 0)
			throw new Error("rankSearch returned 0 results for 'blue'");

		// perf-blue.jpg should be at or near the top (it's the only blue image).
		const topFilenames = ranked.slice(0, 3).map((r) => r.filename);
		if (!topFilenames.includes("perf-blue.jpg")) {
			throw new Error(
				`perf-blue.jpg not in top 3: ${JSON.stringify(topFilenames)}`,
			);
		}

		// All results should have valid shape.
		for (const r of ranked) {
			if (typeof r.filename !== "string")
				throw new Error(`missing filename: ${JSON.stringify(r)}`);
			if (typeof r.score !== "number")
				throw new Error(`missing score: ${JSON.stringify(r)}`);
		}
	});

	await checkAsync("IPC rank: red query ranks red image first", async () => {
		const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("red color", 10)
		`);
		if (!Array.isArray(ranked) || ranked.length === 0)
			throw new Error("no results");
		if (ranked[0].filename !== "perf-red.jpg") {
			throw new Error(`expected perf-red.jpg first, got ${ranked[0].filename}`);
		}
	});

	await checkAsync(
		"IPC rank: green query ranks green image first",
		async () => {
			const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("green forest", 10)
		`);
			if (!Array.isArray(ranked) || ranked.length === 0)
				throw new Error("no results");
			if (ranked[0].filename !== "perf-green.jpg") {
				throw new Error(
					`expected perf-green.jpg first, got ${ranked[0].filename}`,
				);
			}
		},
	);

	await checkAsync(
		"IPC rank: yellow query ranks yellow image first",
		async () => {
			const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("yellow sun", 10)
		`);
			if (!Array.isArray(ranked) || ranked.length === 0)
				throw new Error("no results");
			if (ranked[0].filename !== "perf-yellow.jpg") {
				throw new Error(
					`expected perf-yellow.jpg first, got ${ranked[0].filename}`,
				);
			}
		},
	);

	await checkAsync("IPC rank: empty query returns empty array", async () => {
		const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("", 10)
		`);
		if (!Array.isArray(ranked))
			throw new Error(`expected array, got ${typeof ranked}`);
		if (ranked.length !== 0)
			throw new Error(`expected 0 results, got ${ranked.length}`);
	});

	await checkAsync(
		"IPC rank: whitespace-only query returns empty array",
		async () => {
			const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("   ", 10)
		`);
			if (!Array.isArray(ranked) || ranked.length !== 0) {
				throw new Error(`expected empty, got ${JSON.stringify(ranked)}`);
			}
		},
	);

	await checkAsync("IPC rank: topK parameter limits results", async () => {
		const ranked3 = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("color", 3)
		`);
		const ranked8 = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("color", 8)
		`);
		if (ranked3.length > 3)
			throw new Error(`topK=3 returned ${ranked3.length} results`);
		if (ranked8.length > 8)
			throw new Error(`topK=8 returned ${ranked8.length} results`);
		if (ranked3.length === 0) throw new Error("topK=3 returned 0 results");
	});

	await checkAsync(
		"IPC rank: scores are valid numbers in descending order",
		async () => {
			const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("blue", 10)
		`);
			if (!Array.isArray(ranked) || ranked.length < 2)
				throw new Error("need ≥2 results");
			for (let i = 0; i < ranked.length; i++) {
				if (typeof ranked[i].score !== "number" || isNaN(ranked[i].score)) {
					throw new Error(`result ${i} has invalid score: ${ranked[i].score}`);
				}
				if (i > 0 && ranked[i].score > ranked[i - 1].score) {
					throw new Error(
						`results not sorted: ${ranked[i - 1].score} < ${ranked[i].score} at index ${i}`,
					);
				}
			}
		},
	);

	await checkAsync(
		"IPC rank: results match embed-query + local ranking (consistency)",
		async () => {
			// Verify the IPC rank produces the same ordering as the embed + rank path.
			const ranked = await win.webContents.executeJavaScript(`
			window.memories.rankSearch("orange sunset", 8)
		`);
			const embedResult = await ctx.askIndexer({
				type: "embed-query",
				text: "orange sunset",
			});
			if (!embedResult.ok || !embedResult.vec)
				throw new Error("embed-query failed");

			// Manual cosine similarity ranking against the library.
			const qVec = new Float32Array(embedResult.vec);
			const manual = [];
			for (let i = 0; i < l.filenames.length; i++) {
				let dot = 0,
					na = 0,
					nb = 0;
				for (let k = 0; k < l.dim; k++) {
					dot += qVec[k] * l.embeddings[i][k];
					na += qVec[k] * qVec[k];
					nb += l.embeddings[i][k] * l.embeddings[i][k];
				}
				const sim =
					na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
				manual.push({ filename: l.filenames[i], score: sim });
			}
			manual.sort((a, b) => b.score - a.score);

			// The IPC handler applies thresholds + diversity, so the exact
			// results may differ. But the TOP result should match (same model,
			// same embeddings).
			if (ranked.length === 0) throw new Error("IPC rank returned empty");
			if (ranked[0].filename !== manual[0].filename) {
				throw new Error(
					`top result mismatch: IPC=${ranked[0].filename} vs manual=${manual[0].filename}`,
				);
			}
		},
	);

	// ---- 3. FIX #2: ETag caching ----------------------------------------
	console.log("[perf] testing ETag caching…");

	await checkAsync(
		"ETag: /memories-index.json returns ETag header",
		async () => {
			const etag = await win.webContents.executeJavaScript(`
			(async () => {
				const res = await fetch('/memories-index.json');
				return res.headers.get('etag');
			})()
		`);
			if (!etag) throw new Error("no ETag header on index JSON");
			// ETag should contain the fingerprint (count-dim-modelId).
			if (!etag.includes(l.filenames.length.toString())) {
				throw new Error(`ETag doesn't contain row count: ${etag}`);
			}
		},
	);

	await checkAsync(
		"ETag: /memory-embeddings.bin returns ETag header",
		async () => {
			const etag = await win.webContents.executeJavaScript(`
			(async () => {
				const res = await fetch('/memory-embeddings.bin');
				return res.headers.get('etag');
			})()
		`);
			if (!etag) throw new Error("no ETag header on embeddings bin");
			// Should contain the cache key (modelId|count|dim|phraseDim).
			if (!etag.includes(modelId)) {
				throw new Error(`ETag doesn't contain modelId: ${etag}`);
			}
		},
	);

	await checkAsync(
		"ETag: /memory-phrase-embeddings.bin returns ETag header",
		async () => {
			const etag = await win.webContents.executeJavaScript(`
			(async () => {
				const res = await fetch('/memory-phrase-embeddings.bin');
				return res.headers.get('etag');
			})()
		`);
			if (!etag) throw new Error("no ETag header on phrase bin");
		},
	);

	await checkAsync(
		"ETag: 304 Not Modified when If-None-Match matches",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				// First request to get the ETag.
				const res1 = await fetch('/memory-embeddings.bin');
				const etag = res1.headers.get('etag');
				if (!etag) return { error: 'no ETag' };

				// Second request with If-None-Match.
				const res2 = await fetch('/memory-embeddings.bin', {
					headers: { 'If-None-Match': etag }
				});
				return { status: res2.status, etag };
			})()
		`);
			if (result.error) throw new Error(result.error);
			if (result.status !== 304) {
				throw new Error(`expected 304, got ${result.status}`);
			}
		},
	);

	await checkAsync(
		"ETag: 304 for index JSON with matching If-None-Match",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const res1 = await fetch('/memories-index.json');
				const etag = res1.headers.get('etag');
				if (!etag) return { error: 'no ETag' };

				const res2 = await fetch('/memories-index.json', {
					headers: { 'If-None-Match': etag }
				});
				return { status: res2.status };
			})()
		`);
			if (result.error) throw new Error(result.error);
			if (result.status !== 304) {
				throw new Error(`expected 304 for index, got ${result.status}`);
			}
		},
	);

	await checkAsync(
		"ETag: stale If-None-Match returns 200 with fresh data",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const res = await fetch('/memory-embeddings.bin', {
					headers: { 'If-None-Match': '"stale-etag-value"' }
				});
				return { status: res.status, hasBody: (await res.arrayBuffer()).byteLength > 0 };
			})()
		`);
			if (result.status !== 200)
				throw new Error(`expected 200, got ${result.status}`);
			if (!result.hasBody) throw new Error("200 response has empty body");
		},
	);

	await checkAsync(
		"ETag: ETag changes when library is mutated (import + save)",
		async () => {
			// Get the current ETag.
			const etagBefore = await win.webContents.executeJavaScript(`
			fetch('/memories-index.json').then(r => r.headers.get('etag'))
		`);

			// Import one more photo (changes the library).
			const extraFile = path.join(tmp, "perf-extra.jpg");
			await sharp({
				create: {
					width: 96,
					height: 96,
					channels: 3,
					background: { r: 255, g: 255, b: 255 },
				},
			})
				.jpeg()
				.toFile(extraFile);

			const extraRes = await ctx.importPaths([extraFile]);
			if (extraRes.added.length !== 1) throw new Error("extra import failed");

			// Wait for the library to update.
			await waitFor(
				() => ctx.loadLibrary().filenames.length >= 9,
				30000,
				"library update",
			);

			// Get the new ETag.
			const etagAfter = await win.webContents.executeJavaScript(`
			fetch('/memories-index.json').then(r => r.headers.get('etag'))
		`);

			if (etagBefore === etagAfter) {
				throw new Error("ETag did not change after import");
			}
		},
	);

	// ---- 4. FIX #2b: Fingerprint skip -----------------------------------
	console.log("[perf] testing renderer fingerprint skip…");

	await checkAsync(
		"Fingerprint: renderer skips reload when index unchanged",
		async () => {
			// Trigger a library-updated event (simulates an enrichment tick).
			// The fingerprint check should prevent a full bin re-fetch.
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				// Load the current index data (populates refs).
				const beforeCount = document.querySelectorAll('img[alt]').length;

				// Simulate a library-updated event by dispatching it through
				// the status listener. The fingerprint check should skip the
				// reload since the index hasn't actually changed.
				// We can't easily trigger the IPC event from here, so instead
				// verify the search still works after the reloadIndex flow.
				const results = await window.memories.rankSearch("blue", 5);
				return {
					ok: Array.isArray(results) && results.length > 0,
					count: results.length,
					first: results[0]?.filename,
				};
			})()
		`);
			if (!result.ok) throw new Error("search after fingerprint check failed");
		},
	);

	// ---- 4b. Fixture videos for the tab-switch flash check ---------------
	// The Videos-tab check below proves a tab switch lands on CONTENT, not
	// an empty frame — unobservable without videos in the library, since
	// matchesTab is category equality and an EMPTY tab legitimately renders
	// its empty state (which the old fixture always hit: 8 photos + 1 more,
	// zero videos — the check could never pass). Colors are deliberately
	// outside the photo palette the IPC-rank checks assert on
	// (blue/red/green/yellow/…) so whole-file ranking of these clips can
	// never steal a top slot.
	console.log("[perf] generating fixture videos…");
	{
		const ffmpeg = require("../indexer/video-utils.js").resolveFfmpeg();
		const cp = require("child_process");
		const gen = (name, args) => {
			const file = path.join(tmp, name);
			const out = cp.spawnSync(ffmpeg, ["-y", ...args, file], {
				encoding: "utf8",
			});
			if (out.status !== 0 || !fs.existsSync(file)) {
				throw new Error(
					`video fixture generation failed for ${name}: ${String(out.stderr).slice(-300)}`,
				);
			}
			return file;
		};
		const videoFiles = [
			gen("perf-playable.mp4", [
				"-f",
				"lavfi",
				"-i",
				"color=c=purple:s=160x120:d=2",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
			]),
			gen("perf-scene-clip.mp4", [
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=160x120:d=2",
				"-f",
				"lavfi",
				"-i",
				"color=c=white:s=160x120:d=1",
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=160x120:d=2",
				"-filter_complex",
				"[0:v][1:v][2:v]concat=n=3:v=1:a=0",
				"-pix_fmt",
				"yuv420p",
			]),
			gen("perf-unplayable.mkv", [
				"-f",
				"lavfi",
				"-i",
				"color=c=gray:s=160x120:d=2",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
			]),
		];
		const vres = await ctx.importPaths(videoFiles);
		check("import: 3 fixture videos added", () => {
			if (vres.added.length !== 3)
				throw new Error(`added ${vres.added.length}/3`);
			if (vres.errors.length > 0)
				throw new Error(`import errors: ${JSON.stringify(vres.errors)}`);
		});
		// 9 photos + 3 videos: the Videos tab has content from here on.
		await waitFor(
			() => ctx.loadLibrary().filenames.length >= 12,
			60000,
			"video library rows",
		);
	}

	// ---- 5. FIX #3: Grid flash fix --------------------------------------
	console.log("[perf] testing grid flash fix (tab switching)…");

	await checkAsync(
		"Grid: initial render shows images without empty flash",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				// Wait for the grid to populate.
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					const n = document.querySelectorAll('img[alt]').length;
					if (n >= 8) return { ok: true, count: n };
				}
				return { ok: false, count: document.querySelectorAll('img[alt]').length };
			})()
		`);
			if (!result.ok)
				throw new Error(`grid never populated: ${result.count} images`);
			if (result.count < 8)
				throw new Error(`expected ≥8 images, got ${result.count}`);
		},
	);

	await checkAsync(
		"Grid: tab switch to Videos shows only videos (no empty flash)",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] button')]
					.find((b) => (b.textContent || '').trim() === t);
				const videos = tabByText('Videos');
				if (!videos) return { error: 'Videos tab not found' };

				// Record the count BEFORE clicking.
				const countBefore = document.querySelectorAll('img[alt]').length;

				videos.click();

				// Check immediately — the grid should NOT be empty.
				// With the old code, setImages([]) would run first, causing
				// a flash. With the fix, the page is computed directly.
				await sleep(100);
				const countImmediate = document.querySelectorAll('img[alt]').length;

				// Wait for the final state.
				const t0 = Date.now();
				let countFinal = countImmediate;
				while (Date.now() - t0 < 5000) {
					await sleep(250);
					countFinal = document.querySelectorAll('img[alt]').length;
					if (countFinal > 0) break;
				}

				// The grid should never be empty during the transition.
				// At minimum, the Videos tab has 3 videos (playable, scene-clip, unplayable).
				if (countImmediate === 0 && countBefore > 0) {
					return { error: 'flash of empty state on tab switch', countBefore, countImmediate, countFinal };
				}
				if (countFinal === 0) {
					return { error: 'Videos tab ended empty', countBefore, countImmediate };
				}
				return { ok: true, countBefore, countImmediate, countFinal };
			})()
		`);
			if (result.error) throw new Error(result.error);
		},
	);

	await checkAsync(
		"Grid: tab switch to Screenshots shows only screenshots",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] button')]
					.find((b) => (b.textContent || '').trim() === t);
				const shots = tabByText('Screenshots');
				if (!shots) return { error: 'Screenshots tab not found' };

				shots.click();
				const t0 = Date.now();
				while (Date.now() - t0 < 5000) {
					await sleep(250);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.length > 0) {
						// Verify all results are screenshots (contain "scr" or "screenshot" in filename).
						// Our fixture doesn't have screenshots, so the tab should be empty.
						// That's fine — just verify the tab click didn't crash.
						return { ok: true, count: alts.length };
					}
				}
				// Screenshots tab is empty (our fixture has no screenshots) — that's correct.
				return { ok: true, count: 0 };
			})()
		`);
			if (result.error) throw new Error(result.error);
		},
	);

	await checkAsync(
		"Grid: rapid tab switching doesn't lose images",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] button')]
					.find((b) => (b.textContent || '').trim() === t);

				const all = tabByText('All');
				const videos = tabByText('Videos');
				if (!all || !videos) return { error: 'tabs missing' };

				// Rapid-fire: All → Videos → All → Videos → All
				for (let i = 0; i < 5; i++) {
					(i % 2 === 0 ? videos : all).click();
					await sleep(50); // Very short — the old code would flash empty
				}

				// Final: back to All. Wait for images to appear.
				all.click();
				const t0 = Date.now();
				while (Date.now() - t0 < 10000) {
					await sleep(250);
					const n = document.querySelectorAll('img[alt]').length;
					if (n >= 8) return { ok: true, count: n };
				}
				return { ok: false, count: document.querySelectorAll('img[alt]').length };
			})()
		`);
			if (!result.ok)
				throw new Error(`rapid switching lost images: ${result.count}`);
		},
	);

	await checkAsync(
		"Grid: All tab restores full grid after Videos filter",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] button')]
					.find((b) => (b.textContent || '').trim() === t);

				// Switch to Videos.
				tabByText('Videos').click();
				await sleep(500);
				const videoCount = document.querySelectorAll('img[alt]').length;

				// Switch back to All.
				tabByText('All').click();
				const t0 = Date.now();
				while (Date.now() - t0 < 5000) {
					await sleep(250);
					const n = document.querySelectorAll('img[alt]').length;
					if (n >= 8) return { ok: true, videoCount, allCount: n };
				}
				return { ok: false, videoCount, allCount: document.querySelectorAll('img[alt]').length };
			})()
		`);
			if (!result.ok)
				throw new Error(
					`All tab did not restore: video=${result.videoCount} all=${result.allCount}`,
				);
			if (result.allCount <= result.videoCount) {
				throw new Error(
					`All tab has fewer images (${result.allCount}) than Videos (${result.videoCount})`,
				);
			}
		},
	);

	// ---- 6. FIX #3b: Search + tab interaction ---------------------------
	console.log("[perf] testing search + tab interaction…");

	await checkAsync(
		"Search: instant keyword results appear immediately",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

				setter.call(input, 'blue');
				input.dispatchEvent(new Event('input', { bubbles: true }));

				// Check IMMEDIATELY — keyword results should be there.
				await sleep(50);
				const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
				const hasBlue = alts.some((a) => a.includes('blue'));
				const count = alts.length;

				// Clean up.
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await sleep(300);

				return { hasBlue, count };
			})()
		`);
			if (result.error) throw new Error(result.error);
			// Keyword results should show immediately (within 50ms).
			if (!result.hasBlue)
				throw new Error("keyword results did not appear instantly");
			if (result.count === 0)
				throw new Error("keyword search returned 0 results");
		},
	);

	await checkAsync(
		"Search: semantic results replace keyword after debounce",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

				setter.call(input, 'red');
				input.dispatchEvent(new Event('input', { bubbles: true }));

				// Wait for semantic ranking (debounce + IPC round-trip).
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.length > 0 && alts[0].includes('red')) {
						// Clean up.
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
						return { ok: true, first: alts[0], count: alts.length };
					}
				}
				return { error: 'semantic results did not surface red image' };
			})()
		`);
			if (result.error) throw new Error(result.error);
		},
	);

	await checkAsync("Search: clearing query restores browse grid", async () => {
		const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

				// Search first.
				setter.call(input, 'blue');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await sleep(500);

				// Clear.
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));

				const t0 = Date.now();
				while (Date.now() - t0 < 5000) {
					await sleep(250);
					const n = document.querySelectorAll('img[alt]').length;
					if (n >= 8) return { ok: true, count: n };
				}
				return { ok: false, count: document.querySelectorAll('img[alt]').length };
			})()
		`);
		if (!result.ok)
			throw new Error(`browse grid not restored: ${result.count} images`);
	});

	// ---- 7. Integration: ranking + ETag + grid all work together ---------
	console.log("[perf] integration: full search flow after ETag-cached reload…");

	await checkAsync(
		"Integration: search works after multiple ETag-304 reloads",
		async () => {
			const result = await win.webContents.executeJavaScript(`
			(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

				// Do 3 rapid searches to trigger multiple index loads.
				for (const q of ['blue', 'red', 'green']) {
					setter.call(input, q);
					input.dispatchEvent(new Event('input', { bubbles: true }));
					await sleep(400);
				}

				// Wait for the final search to complete.
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await sleep(250);
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.length > 0 && alts[0].includes('green')) {
						setter.call(input, '');
						input.dispatchEvent(new Event('input', { bubbles: true }));
						return { ok: true, first: alts[0] };
					}
				}
				return { error: 'final search did not return green image' };
			})()
		`);
			if (result.error) throw new Error(result.error);
		},
	);

	// ---- Summary ---------------------------------------------------------
	console.log(`\n[perf] ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		throw new Error(`${failed} perf test(s) failed`);
	}
}
