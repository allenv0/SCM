"use strict";

// Grid-virtualization smoke (C-04): a 50k-row synthetic library must browse
// with a bounded live-tile count, reachable ends, and a stable scroll span.
// The fixture (scripts/perf-grid-fixture.js, run pre-boot by smoke:grid)
// fabricates rows + valid bins, so this suite measures the RENDERER only —
// no imports, no embeds, no search.
//
// Contract (holds with pagination AND after its deletion, which is the
// point — the suite pins behavior across the refactor):
//   1. the fabricated rows survive boot (no prune/heal wipe),
//   2. the mounted DOM stays a viewport window (< MAX_LIVE_TILES),
//   3. the oldest row is reachable by scrolling (not cut off),
//   4. the scroll span is stable (windowing, not append-growth),
//   5. scrolling home restores the newest row.
//
// Runs as MEMORIES_DATA_DIR=$TMP ELECTRON_SMOKE=1 ELECTRON_SMOKE_GRID=1
// electron . (see package.json smoke:grid).

const path = require("path");
const fs = require("fs");

module.exports = { runPerfGridTest };

// Roadmap C-04: a 50k library must browse with < ~150 live tiles.
const MAX_LIVE_TILES = 150;

async function runPerfGridTest(ctx) {
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("ELECTRON_SMOKE_GRID requires MEMORIES_DATA_DIR");
	}
	const { win } = ctx;
	if (!win) throw new Error("grid perf: no window");

	let passed = 0;
	let failed = 0;
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
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// ---- 1. Fixture survived boot --------------------------------------
	const lib = ctx.loadLibrary();
	const total = lib.filenames.length;
	const oldest = total > 0 ? lib.filenames[total - 1].split(".")[0] : "(none)";
	const newest = total > 0 ? lib.filenames[0].split(".")[0] : "(none)";
	console.log(
		`[grid] library rows: ${total} (newest=${newest} oldest=${oldest})`,
	);
	await checkAsync(
		"fixture rows survive boot (no prune/heal wipe)",
		async () => {
			const expected = Number(process.env.GRID_PERF_N || 50000);
			if (total < expected) {
				throw new Error(`only ${total}/${expected} rows after boot`);
			}
		},
	);

	const tiles = () =>
		win.webContents.executeJavaScript(
			`[...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '')`,
		);
	const scrollH = () =>
		win.webContents.executeJavaScript(`document.body.scrollHeight`);
	const viewH = () => win.webContents.executeJavaScript(`window.innerHeight`);

	// Wait for the first tiles (50k refreshLibrary + first thumbs).
	let first = [];
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 180000) {
			await sleep(1000);
			try {
				first = await tiles();
			} catch {
				first = [];
			}
			if (first.length > 0) break;
		}
	}
	await checkAsync("grid mounts tiles for a 50k library", async () => {
		if (first.length === 0) throw new Error("no tiles mounted in 180s");
		console.log(`[grid] initial mounted tiles: ${first.length}`);
	});

	await checkAsync(`live tiles stay under ${MAX_LIVE_TILES}`, async () => {
		if (first.length >= MAX_LIVE_TILES) {
			throw new Error(`unbounded DOM: ${first.length} tiles mounted`);
		}
	});

	let h0 = 0;
	await checkAsync("grid is scrollable (span exceeds viewport)", async () => {
		h0 = await scrollH();
		const vh = await viewH();
		console.log(`[grid] scrollHeight=${h0} viewport=${vh}`);
		if (!(h0 > vh)) throw new Error(`nothing to scroll: ${h0} <= ${vh}`);
	});

	// ---- 2. Oldest row reachable ----------------------------------------
	await checkAsync("oldest row reachable by scrolling", async () => {
		await win.webContents.executeJavaScript(
			`window.scrollTo(0, document.body.scrollHeight)`,
		);
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {
			await sleep(1000);
			const alts = await tiles();
			if (alts.some((a) => a.includes(oldest))) return;
			// Keep pushing to the very bottom (thumbs/layout settle async).
			await win.webContents.executeJavaScript(
				`window.scrollTo(0, document.body.scrollHeight)`,
			);
		}
		const tail = (await tiles()).slice(0, 8).join(" | ");
		throw new Error(`oldest (${oldest}) never mounted; tail: ${tail}`);
	});

	// ---- 3. Windowing holds at the bottom --------------------------------
	await checkAsync(
		`live tiles still under ${MAX_LIVE_TILES} at bottom`,
		async () => {
			const n = (await tiles()).length;
			console.log(`[grid] bottom mounted tiles: ${n}`);
			if (n >= MAX_LIVE_TILES) {
				throw new Error(`unbounded DOM at bottom: ${n} tiles`);
			}
		},
	);

	await checkAsync("scroll span is stable (no append-growth)", async () => {
		const h1 = await scrollH();
		console.log(`[grid] scrollHeight: ${h0} -> ${h1}`);
		if (h1 !== h0) {
			throw new Error(
				`span moved ${h0} -> ${h1} (append-growth, not windowing)`,
			);
		}
	});

	// ---- 4. Scroll home ----------------------------------------------------
	await checkAsync("newest row restored by scrolling home", async () => {
		await win.webContents.executeJavaScript(`window.scrollTo(0, 0)`);
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {
			await sleep(1000);
			const alts = await tiles();
			if (alts.some((a) => a.includes(newest))) return;
		}
		throw new Error(`newest (${newest}) never re-mounted`);
	});

	// ---- Summary ---------------------------------------------------------
	console.log(`\n[grid] ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		throw new Error(`${failed} grid perf test(s) failed`);
	}

	// Keep the monkey out of the shots: clear the fabricated photos dir size
	// from the log tail is enough — files live in the temp data dir.
	const photos = path.join(process.env.MEMORIES_DATA_DIR, "photos");
	try {
		console.log(`[grid] fabricated files: ${fs.readdirSync(photos).length}`);
	} catch {
		/* best-effort tally */
	}
}
