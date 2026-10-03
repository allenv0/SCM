"use strict";

// Regression test (ELECTRON_SMOKE=1 + ELECTRON_SMOKE_SCENENOISE=1): a
// "movie-heavy" library is one with enough shots that a gibberish query —
// which embeds near the text centroid and scores hot on almost every frame —
// would clear the scene ranking's cutoff on 30-50% of segments and flood
// Scenes mode with the same films (the bug: "some videos keep appearing at
// the top no matter what I search"). The scene-noise gate
// (SCENE_NOISE_FRACTION in useMemorySearch) must return "no scene matches"
// for such queries while genuine color queries still surface their scenes.
//
// Fixture: 12 two-tone solid-color clips (like a wall of short films) —
// measured with the real SigLIP-2 model: the gibberish query clears the
// cutoff on ~45% of segments (gate fires), "blue"/"red" on ~24% (gate keeps
// them). Without the gate this test fails: the gibberish search fills the
// grid with clip cards instead of showing "No scene matches".

const path = require("path");
const fs = require("fs");
const cp = require("child_process");

module.exports = { runSceneNoiseTest };

// Two-tone clips: each is two solid-color shots concatenated, so every clip
// contributes several distinct segment vectors — the "many shots per film"
// property that made long movies dominate scene search.
const CLIP_COLORS = [
	["red", "coral"],
	["orange", "gold"],
	["yellow", "lime"],
	["green", "teal"],
	["cyan", "skyblue"],
	["blue", "navy"],
	["indigo", "purple"],
	["magenta", "pink"],
	["brown", "tan"],
	["white", "silver"],
	["gray", "dimgray"],
	["black", "maroon"],
];

const GIBBERISH_QUERY = "zzzxq";
// NOTE (CLIP default): this was "zzzxq nonsense", chosen for SigLIP-2
// geometry (gibberish cleared the cutoff on ~45% of segments). Under CLIP,
// "nonsense" is a real word with visual affinity for dark/muted solids, so
// the full string spikes a few clips (23% above cutoff — just under the
// gate) instead of flooding. The bare nonsense token has no referent and
// floods ~85% under CLIP, which is what this gate is for. Measured
// 2026-09-26 on this exact fixture (CLIP ViT-L/14@336, centered cosines).
// Positive control: measured on this exact fixture the query clears the
// scene cutoff on ~5% of segments (well under SCENE_NOISE_FRACTION), so the
// gate keeps its hits — proving the fixture and gate discriminate instead of
// returning nothing for every query.
const GENUINE_QUERY = "red";

async function runSceneNoiseTest(ctx) {
	const { win } = ctx;
	if (!win) throw new Error("scenenoise: no window");
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error(
			"ELECTRON_SMOKE_SCENENOISE requires MEMORIES_DATA_DIR (a temp dir)",
		);
	}

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

	// ---- fixture: movie-heavy clip wall -------------------------------
	console.log("[scenenoise] fixtures…");
	const tmp = fs.mkdtempSync(
		path.join(
			ctx.app?.getPath?.("temp") || require("os").tmpdir(),
			"scm-scenenoise-",
		),
	);
	const ffmpeg = require("../indexer/video-utils.js").resolveFfmpeg();
	const files = [];
	for (const [i, [a, b]] of CLIP_COLORS.entries()) {
		const name = `noise-clip-${String(i).padStart(2, "0")}.mp4`;
		const file = path.join(tmp, name);
		const out = cp.spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				`color=c=${a}:s=160x120:d=2`,
				"-f",
				"lavfi",
				"-i",
				`color=c=${b}:s=160x120:d=2`,
				"-filter_complex",
				"[0:v][1:v]concat=n=2:v=1:a=0",
				"-pix_fmt",
				"yuv420p",
				file,
			],
			{ encoding: "utf8" },
		);
		if (out.status !== 0 || !fs.existsSync(file)) {
			throw new Error(
				`fixture generation failed for ${name}: ${out.stderr.slice(-300)}`,
			);
		}
		files.push(file);
	}

	console.log("[scenenoise] import…");
	const res = await ctx.importPaths(files);
	check("import: all movie-heavy clips added", () => {
		if (res.added.length !== files.length) {
			throw new Error(
				`added ${res.added.length}/${files.length}: ${JSON.stringify(res)}`,
			);
		}
		if (res.errors.length > 0) {
			throw new Error(`import errors: ${JSON.stringify(res.errors)}`);
		}
	});

	// ---- wait for background enrichment --------------------------------
	console.log("[scenenoise] waiting for enrichment…");
	const modelId = ctx.loadLibrary().modelId;
	await waitFor(
		() => ctx.getEnrichQueue() === 0,
		240000,
		"enrichment queue drain",
	);
	await waitFor(
		() => {
			const c = ctx.loadSegments(modelId);
			if (!c.loaded) return false;
			for (const f of files) {
				const name = path.basename(f);
				const segs = c.videos.get(name);
				if (!segs || segs.length === 0) return false;
			}
			return true;
		},
		240000,
		"every clip enriched",
	);
	check("segments: every clip has scene segments", () => {
		const c = ctx.loadSegments(modelId);
		for (const f of files) {
			const name = path.basename(f);
			if (!c.videos.has(name) || c.videos.get(name).length === 0) {
				throw new Error(`${name} has no segments`);
			}
		}
	});

	// ---- drive the real renderer ---------------------------------------
	console.log("[scenenoise] renderer…");
	const out = await win.webContents.executeJavaScript(`
		(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const input = () => document.querySelector('input[aria-label="Search memories"]');
			const setQuery = (q) => {
				const el = input();
				if (!el) return false;
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(el, q);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			};
			const tabByText = (t) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
				.find((b) => (b.textContent || '').trim() === t);
			const alts = () => [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
			const bodyText = () => document.body.textContent || '';

			// Videos tab auto-arms Scenes mode.
			const videos = tabByText('Videos');
			if (!videos) return { error: 'Videos tab missing' };
			videos.click();
			const scenesBtn = document.querySelector('button[aria-label="Scenes search mode"]');
			if (scenesBtn) scenesBtn.click();
			await sleep(800);

			const search = async (q, timeoutMs) => {
				setQuery(q);
				// Wait for the scene search to settle: either scene cards
				// appear or the "No scene matches" empty state renders.
				const t0 = Date.now();
				let last = [];
				let state = '';
				while (Date.now() - t0 < timeoutMs) {
					await sleep(350);
					last = alts();
					state = bodyText();
					if (last.length > 0) return { cards: last };
					if (state.includes('No scene matches for')) return { cards: [], emptyState: true };
				}
				return { cards: last, state: state.slice(0, 120) };
			};

			const gibberish = await search(${JSON.stringify(GIBBERISH_QUERY)}, 30000);
			const genuine = await search(${JSON.stringify(GENUINE_QUERY)}, 30000);

			// clear up: back to All, empty query
			const all = tabByText('All');
			if (all) all.click();
			const clear = document.querySelector('button[aria-label="Clear search"]');
			if (clear) clear.click();
			await sleep(800);
			return { gibberish, genuine, alts: alts().slice(0, 5) };
		})()
	`);
	if (out.error) throw new Error(out.error);

	// Gibberish must surface NO scene cards — the whole regression.
	check("gibberish query → no scene matches on a movie-heavy library", () => {
		if (out.gibberish.error) throw new Error(out.gibberish.error);
		if (out.gibberish.cards.length > 0) {
			throw new Error(
				`gibberish query returned ${out.gibberish.cards.length} scene cards: ${out.gibberish.cards.slice(0, 6).join(" | ")}`,
			);
		}
		if (!out.gibberish.emptyState) {
			throw new Error(
				`gibberish query did not hit the no-scene-match state: ${JSON.stringify(out.gibberish)}`,
			);
		}
	});

	// Positive control: a genuine color query still surfaces scenes — the
	// gate must not have over-cut everything.
	check("genuine query still surfaces scene cards", () => {
		if (out.genuine.error) throw new Error(out.genuine.error);
		if (out.genuine.cards.length === 0) {
			throw new Error(
				`"${GENUINE_QUERY}" returned no scene cards: ${JSON.stringify(out.genuine)}`,
			);
		}
	});

	console.log(`[scenenoise] OK (${passed} passed, ${failed} failed)`);
	if (failed > 0) throw new Error(`${failed} scene-noise check(s) failed`);
}
