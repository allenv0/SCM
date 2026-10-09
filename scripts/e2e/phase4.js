"use strict";

// Phase-4 driver: long-movie coverage + live-progress contract, end to end.
// Runs inside the app process; prod seams arrive via ctx (C-01).
// Extracted from main.js verbatim (C-01 10/10), except: relative requires
// re-pointed at scripts/e2e/.., getModel required from indexer/models.js
// directly (static dep, as main.js does), and the three live main-process
// counters (enrichQueue, enrichEventsObserved, enrichProgressViolations)
// arrive as getters — they mutate after the driver starts, so a destructured
// snapshot would go stale. enrichPhaseCounts is mutated in place (identity
// stable) and is passed by reference.

const fs = require("fs");
const path = require("path");
const { getModel } = require("../../indexer/models.js");

// ---------------------------------------------------------------------------
// Phase-4 deep test (ELECTRON_SMOKE=1 + ELECTRON_SMOKE_PHASE4=1): the full
// long-movie coverage + live-progress contract, end to end. Requires a temp
// MEMORIES_DATA_DIR. Layers:
//   1. planning math (budget table, even time distribution, interval
//      fallback, clamping) — pure functions from video-utils, re-verified
//      against the app build itself
//   2. real enrichment pipeline: import a 5-shot clip → sidecar/bin
//      integrity (regression-guards the Phase-2 total/dim bugs) → per-phase
//      progress events with no range violations
//   3. launch-backfill round trip: sidecar deleted → backfillEnrichment()
//      repopulates it without any import
//   4. migration backfill: the target model's empty sidecar repopulates
//      after a model switch (skipped when the target weights aren't cached)
//   5. renderer tray state machine (embed / detect / queued / paused /
//      idle) + the enrich-state IPC from the real preload bridge
// ---------------------------------------------------------------------------
async function runPhase4DeepTest(ctx) {
	const {
		app,
		BrowserWindow,
		importPaths,
		loadLibrary,
		loadSegments,
		readVideoQuality,
		writeSettings,
		removeLibraryRow,
		saveLibrary,
		backfillEnrichment,
		reembedToModel,
		migrationSettled,
		suspectedTruncatedVideos,
		segmentsBinFileFor,
		segmentsMetaFileFor,
		POSTERS_DIR,
		PHOTOS_DIR,
		enrichPhaseCounts,
		getEnrichQueue,
		getEnrichEventsObserved,
		getEnrichProgressViolations,
	} = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error(
			"ELECTRON_SMOKE_PHASE4 requires MEMORIES_DATA_DIR (a temp dir)",
		);
	}
	const videoUtils = require("../../indexer/video-utils.js");
	const cp = require("child_process");
	const ffmpeg = videoUtils.resolveFfmpeg();
	const win = BrowserWindow.getAllWindows()[0];
	if (!win) throw new Error("phase4: no window");

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
	// Segment sidecars persist asynchronously (serialized queue with fsync)
	// while enrichment updates the IN-MEMORY cache synchronously. Any check
	// that reads the on-disk BIN FILE must wait for the persist queue to
	// drain first, or it compares current meta against a stale bin (an
	// offset one past the on-disk header — a test-side race, not product
	// corruption: the queue is serial and converges). Drain = the bin
	// header row count has caught up with the in-memory row count.
	const waitForBinDrain = (modelId, label) =>
		waitFor(
			() => {
				const c = loadSegments(modelId);
				if (!c.loaded) return false;
				const bin = fs.readFileSync(segmentsBinFileFor(modelId));
				const h = new Int32Array(bin.buffer, bin.byteOffset, 2);
				return h[0] >= c.rows.length;
			},
			60000,
			`segment bin drain (${label})`,
		);
	const trayShows = (needle) =>
		win.webContents.executeJavaScript(`
			(async () => {
				const t0 = Date.now();
				const seen = [];
				let pillHits = 0;
				while (Date.now() - t0 < 10000) {
					await new Promise((r) => setTimeout(r, 200));
					const pill = document.querySelector('[data-enrich-tray]');
					if (!pill) continue;
					pillHits++;
					// NBSP→space + collapse runs so element boundaries can't
					// break a needle; matched with a real RegExp. NOTE: the
					// regexes must be written with doubled backslashes in the
					// source — a single backslash-s in a template literal is
					// an identity escape that silently becomes /s+/g (replacing
					// the letter 's'!) instead of the whitespace class.
					// (Spelled out: no backslash-letter sequences may appear
					// in this NOTE — this whole block runs page-side inside a
					// template literal, so even comments are escape-processed
					// by the linter's no-useless-escape.)
					const text = (pill.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
					if (!seen.includes(text)) seen.push(text);
					if (new RegExp(${JSON.stringify(needle)}).test(text)) return { ok: true, text, seen };
				}
				return {
					ok: false,
					// Diagnostic: every distinct pill text observed during the
					// poll + how often the pill was found at all — this settles
					// whether the event never rendered or the match failed.
					seen,
					pillHits,
					needle: ${JSON.stringify(needle)},
					// Raw + collapsed codepoints so a stray invisible separator
					// or a display-layer transcription can't hide the truth.
					rawCodes: Array.from(
						document.querySelector('[data-enrich-tray]')?.textContent || '',
					)
						.map((c) => c.charCodeAt(0))
						.slice(0, 60),
				};
			})()
		`);
	const trayGone = () =>
		win.webContents.executeJavaScript(`
			(async () => {
				const t0 = Date.now();
				while (Date.now() - t0 < 15000) {
					await new Promise((r) => setTimeout(r, 200));
					if (!document.querySelector('[data-enrich-tray]')) return { ok: true };
				}
				return { ok: false };
			})()
		`);

	// ---- 1. planning math against the app build -------------------------
	console.log("[phase4] planning math…");
	check("budget table in-app (5400→128, 2700→90, 600→20, 10→8)", () => {
		if (videoUtils.segmentBudgetFor(5400) !== 128)
			throw new Error("5400 → " + videoUtils.segmentBudgetFor(5400));
		if (videoUtils.segmentBudgetFor(2700) !== 90)
			throw new Error("2700 → " + videoUtils.segmentBudgetFor(2700));
		if (videoUtils.segmentBudgetFor(600) !== 20)
			throw new Error("600 → " + videoUtils.segmentBudgetFor(600));
		if (videoUtils.segmentBudgetFor(10) !== 8)
			throw new Error("10 → " + videoUtils.segmentBudgetFor(10));
	});
	check("even distribution reaches the final act (300 shots / 90 min)", () => {
		const shots = Array.from({ length: 300 }, (_, i) => ({
			t: i * 18,
			dur: 1,
		}));
		const out = videoUtils.sampleShotsEvenly(shots, 5400, 128);
		if (out.length !== 128) throw new Error("len " + out.length);
		const last = out[out.length - 1].t;
		if (last < 5250)
			throw new Error(`last shot ${last}s — final act uncovered`);
	});

	// ---- 2. real pipeline: import a 5-shot clip, verify the sidecar -----
	console.log("[phase4] pipeline: import + enrich…");
	const tmp = fs.mkdtempSync(
		path.join(app.getPath("temp"), "memories-phase4-"),
	);
	const clip = path.join(tmp, "phase4-clip.mp4");
	const gen = cp.spawnSync(
		ffmpeg,
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=160x120:d=2",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=160x120:d=1.5",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x120:d=2",
			"-f",
			"lavfi",
			"-i",
			"color=c=green:s=160x120:d=1.5",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=160x120:d=3",
			"-filter_complex",
			"[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0",
			"-pix_fmt",
			"yuv420p",
			clip,
		],
		{ encoding: "utf8" },
	);
	if (gen.status !== 0 || !fs.existsSync(clip))
		throw new Error("phase4 clip generation failed");

	const res = await importPaths([clip]);
	if (res.added.length !== 1)
		throw new Error(`phase4 import failed: ${JSON.stringify(res)}`);
	const duration = await videoUtils.probeDuration(ffmpeg, clip);
	const modelId = loadLibrary().modelId;
	await waitFor(
		() => {
			const c = loadSegments(modelId);
			return c.loaded && (c.videos.get("phase4-clip.mp4") || []).length >= 4;
		},
		120000,
		"clip scene enrichment (≥4 shots)",
	);

	// ---- 2a2. shot-boundary detection on the real 5-shot fixture --------
	// The scene pass is what makes segment plans shot-aligned instead of
	// interval-sampled, and this pins the refactored detectScenes contract
	// ({ boundaries, duration } — watchdog timeouts + the parallel null tap
	// that measures EOF duration) against the real pipeline.
	console.log("[phase4] shot-boundary detection…");
	{
		const scene = await videoUtils.detectScenes(ffmpeg, clip, null, duration);
		check("detectScenes: 5-shot fixture yields ≥4 boundaries", () => {
			if (scene.boundaries.length < 4)
				throw new Error(`got ${scene.boundaries.length}`);
		});
		check("detectScenes: measured duration matches the probe (±1s)", () => {
			if (scene.duration === null || Math.abs(scene.duration - duration) > 1) {
				throw new Error(`measured ${scene.duration}, probe ${duration}`);
			}
		});
	}

	// ---- 2b. multi-chunk enrichment (regression: chunk accumulation) -----
	// A video with more than SEGMENTS_PER_CHUNK segments is enriched in
	// several chunks; the sidecar must accumulate every chunk. pumpEnrichment
	// used to REPLACE the file's segment list with the last chunk's, leaving
	// a long-form video searchable only in its final minutes — short clips
	// fit one chunk, which is why every earlier test missed it. The Ultra
	// preset (1 point / 5 s) turns a 90 s clip into 18 segments → exactly 2
	// chunks (16 + 2), so the guard never needs a real long-form video.
	console.log("[phase4] multi-chunk enrichment…");
	// The budget is resolved per job at pump time — Ultra must be active
	// BEFORE the import so the queued job plans 18 segments.
	const prevQuality = readVideoQuality();
	writeSettings({ videoQuality: "ultra" });
	try {
		check("multi-chunk: 90s clip budgets 18 segments under Ultra", () => {
			const n = videoUtils.segmentBudgetFor(
				90,
				videoUtils.budgetForQuality("ultra"),
			);
			if (n !== 18) throw new Error(`expected 18, got ${n}`);
		});
		const longPath = path.join(tmp, "phase4-long-clip.mp4");
		const genLong = cp.spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=teal:s=160x120:d=90",
				"-pix_fmt",
				"yuv420p",
				longPath,
			],
			{ encoding: "utf8" },
		);
		if (genLong.status !== 0 || !fs.existsSync(longPath)) {
			throw new Error("phase4 long-clip generation failed");
		}
		const resLong = await importPaths([longPath]);
		if (resLong.added.length !== 1) {
			throw new Error(
				`phase4 long-clip import failed: ${JSON.stringify(resLong)}`,
			);
		}
		// A solid color has no shot boundaries → the interval fallback plans
		// exactly 18 segments, enriched as 2 chunks. The buggy replace left
		// only the 2-segment LAST chunk in the sidecar, so this wait times
		// out on unfixed code — the regression signal.
		await waitFor(
			() => {
				const c2 = loadSegments(loadLibrary().modelId);
				return (c2.videos.get("phase4-long-clip.mp4") || []).length >= 18;
			},
			120000,
			"long-clip enrichment (18 segments across 2 chunks)",
		);
		// The wait above observes the in-memory cache; the bin-file checks
		// below must observe the drained queue (see waitForBinDrain).
		await waitForBinDrain(loadLibrary().modelId, "long-clip");
		const longSegs =
			loadSegments(loadLibrary().modelId).videos.get("phase4-long-clip.mp4") ||
			[];
		check(
			"multi-chunk: all 18 segments survive (not just the last chunk)",
			() => {
				if (longSegs.length !== 18) {
					throw new Error(`expected 18 segments, got ${longSegs.length}`);
				}
			},
		);
		check(
			"multi-chunk: coverage spans the whole clip (front chunk present)",
			() => {
				const ts = longSegs.map((s) => s.t).sort((a, b) => a - b);
				if (!(ts[0] < 10 && ts[ts.length - 1] > 80)) {
					throw new Error(
						`t range ${ts[0]}..${ts[ts.length - 1]}s — chunks lost`,
					);
				}
			},
		);
		check("multi-chunk: offsets are unique and land inside the bin", () => {
			const offs = longSegs.map((s) => s.off);
			if (new Set(offs).size !== offs.length) {
				throw new Error(`duplicate offsets: ${offs.join(",")}`);
			}
			const bin2 = fs.readFileSync(segmentsBinFileFor(loadLibrary().modelId));
			const h2 = new Int32Array(bin2.buffer, bin2.byteOffset, 2);
			for (const off of offs) {
				if (!(off >= 0 && off < h2[0])) {
					throw new Error(`off ${off} out of range (${h2[0]})`);
				}
			}
		});
	} finally {
		// Restore the preset the suite started with, and drop the long clip
		// so the backfill and migration round trips stay lean (the row's
		// segment rows are compacted + scene posters swept too).
		writeSettings({ videoQuality: prevQuality });
		removeLibraryRow("phase4-long-clip.mp4");
		await saveLibrary();
	}

	// ---- 2c. long-form at the DEFAULT preset (Balanced) -----------------
	// 2b forced Ultra to squeeze 2 chunks out of a 90 s clip. The real
	// user-facing threshold is the default preset: any video longer than ~8
	// minutes plans > SEGMENTS_PER_CHUNK segments under Balanced and is
	// enriched across several chunks. This guard exercises that exact path
	// at the real duration threshold, no preset gymnastics: a 510 s clip
	// budgets 17 segments → chunks of 16 + 1. On the unfixed replace-based
	// pump the sidecar keeps only the 1-segment LAST chunk, so the 17-segment
	// wait times out — the regression signal at the default preset.
	console.log("[phase4] long-form at Balanced…");
	const prevQuality2 = readVideoQuality();
	writeSettings({ videoQuality: "balanced" });
	try {
		const balPath = path.join(tmp, "phase4-long-balanced.mp4");
		const genBal = cp.spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=indigo:s=160x120:d=510",
				"-r",
				"10",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				balPath,
			],
			{ encoding: "utf8" },
		);
		if (genBal.status !== 0 || !fs.existsSync(balPath)) {
			throw new Error("phase4 long-balanced generation failed");
		}
		// The encoder rounds the 510 s request to ~510.2 s — derive the
		// expected budget from the REAL probed duration so the guard tracks
		// the actual plan (18 at Balanced) instead of a hardcoded count.
		const balProbe = await videoUtils.probeDuration(ffmpeg, balPath);
		const balBudget = videoUtils.segmentBudgetFor(
			balProbe,
			videoUtils.budgetForQuality("balanced"),
		);
		check("long-form: 8.5-min fixture is genuinely long-form (~510s)", () => {
			if (!(balProbe !== null && balProbe > 505 && balProbe < 515)) {
				throw new Error(`probe ${balProbe}`);
			}
		});
		check(
			"long-form: default preset budgets > SEGMENTS_PER_CHUNK (multi-chunk)",
			() => {
				if (!(balBudget > 16)) throw new Error(`budget ${balBudget}`);
			},
		);
		const resBal = await importPaths([balPath]);
		if (resBal.added.length !== 1) {
			throw new Error(
				`phase4 long-balanced import failed: ${JSON.stringify(resBal)}`,
			);
		}
		await waitFor(
			() => {
				const c3 = loadSegments(loadLibrary().modelId);
				return (
					(c3.videos.get("phase4-long-balanced.mp4") || []).length >= balBudget
				);
			},
			120000,
			`long-balanced enrichment (${balBudget} segments across 2 chunks)`,
		);
		// Same in-memory/bin race as the multi-chunk block above: the bin
		// file lags the final chunk's commit on a loaded runner.
		await waitForBinDrain(loadLibrary().modelId, "long-balanced");
		const balSegs =
			loadSegments(loadLibrary().modelId).videos.get(
				"phase4-long-balanced.mp4",
			) || [];
		check(
			"long-form: every planned segment survives across both chunks",
			() => {
				if (balSegs.length !== balBudget) {
					throw new Error(`expected ${balBudget}, got ${balSegs.length}`);
				}
			},
		);
		check("long-form: coverage spans the whole 8.5-min clip", () => {
			const ts = balSegs.map((s) => s.t).sort((a, b) => a - b);
			if (!(ts[0] < 30 && ts[ts.length - 1] > balProbe - 15)) {
				throw new Error(
					`t range ${ts[0]}..${ts[ts.length - 1]}s — chunks lost`,
				);
			}
		});
		check("long-form: offsets are unique and land inside the bin", () => {
			const offs = balSegs.map((s) => s.off);
			if (new Set(offs).size !== offs.length) {
				throw new Error(`duplicate offsets: ${offs.join(",")}`);
			}
			const bin3 = fs.readFileSync(segmentsBinFileFor(loadLibrary().modelId));
			const h3 = new Int32Array(bin3.buffer, bin3.byteOffset, 2);
			for (const off of offs) {
				if (!(off >= 0 && off < h3[0])) {
					throw new Error(`off ${off} out of range (${h3[0]})`);
				}
			}
		});
	} finally {
		writeSettings({ videoQuality: prevQuality2 });
		removeLibraryRow("phase4-long-balanced.mp4");
		await saveLibrary();
	}

	// ---- 2d. no-probeable-duration container (probe-failure fallback) ---
	// A raw .h264 elementary stream has NO container metadata — ffmpeg -i
	// reports Duration: N/A, so probeDuration returns null. Before the
	// fix that permanently recorded "no segments" (the video could never be
	// scene-searched). The scene pass now measures duration from its decode
	// ticks (the parallel null tap), so the film still gets a plan. The
	// fixture has 4 hard color cuts (exercise the shot path); a solid-color
	// file would exercise the interval path — both must plan.
	console.log("[phase4] no-duration container fallback…");
	{
		const rawPath = path.join(tmp, "phase4-raw.h264");
		const genRaw = cp.spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=160x120:d=20",
				"-f",
				"lavfi",
				"-i",
				"color=c=red:s=160x120:d=15",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:s=160x120:d=15",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=160x120:d=10",
				"-filter_complex",
				"[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				rawPath,
			],
			{ encoding: "utf8" },
		);
		if (genRaw.status !== 0 || !fs.existsSync(rawPath)) {
			throw new Error("phase4 raw .h264 generation failed");
		}
		const rawProbe = await videoUtils.probeDuration(ffmpeg, rawPath);
		check("raw .h264 has no probeable duration (fixture is genuine)", () => {
			if (rawProbe !== null) {
				throw new Error(
					`probe returned ${rawProbe} — fixture not undetectable`,
				);
			}
		});
		const rawPlan = await videoUtils.buildSegmentPlan(ffmpeg, rawPath);
		check(
			"no-duration container still gets a plan (measured by the scene pass)",
			() => {
				if (!Array.isArray(rawPlan) || rawPlan.length < 3) {
					throw new Error(`plan has ${rawPlan.length} segments`);
				}
			},
		);
		check("plan spans the full measured film (not just the head)", () => {
			const ts = rawPlan.map((s) => s.t);
			if (!(ts[0] > 5 && ts[ts.length - 1] > 45)) {
				throw new Error(`t range ${ts[0]}..${ts[ts.length - 1]}s`);
			}
		});
		check("estimated duration ≈ the real 60s film", () => {
			const last = rawPlan[rawPlan.length - 1];
			const est = last.t + last.dur / 2;
			if (!(est > 55)) throw new Error(`estimated ${est}s`);
		});
	}

	// ---- 2e. suspected-truncated repair scan ----------------------------
	// The renderer's Settings → Video search warning is driven by the same
	// pure detector unit-tested in test/pump-enrichment.test.js; this pins
	// the main-process wrapper against the real sidecar: an injected
	// pre-fix-shaped entry (last-chunk tail of a 128-segment plan) is
	// flagged, and legitimately-covered entries are not. The cache is
	// restored afterwards — nothing is persisted.
	console.log("[phase4] suspected-truncated scan…");
	{
		const c4 = loadSegments(loadLibrary().modelId);
		const fake = Array.from({ length: 16 }, (_, i) => ({
			t: 3360 + i * 30,
			dur: 30,
			off: 0,
			n: 1,
		}));
		// The wrapper skips flagged rows whose app copy is gone from disk
		// (the ghost filter in suspectedTruncatedVideos) — a virtual-only
		// fixture is filtered out before the detector's verdict is ever
		// observable, so the fake needs a live file in PHOTOS_DIR to be a
		// repair candidate. The file is removed again below to pin the
		// other half of the contract: no file → no banner entry.
		const fakeFile = path.join(PHOTOS_DIR, "phase4-truncated-fake.mp4");
		c4.videos.set("phase4-truncated-fake.mp4", fake);
		fs.writeFileSync(fakeFile, "");
		try {
			const det = suspectedTruncatedVideos();
			check("scan flags the injected last-chunk-only entry", () => {
				const hit = (det.videos || []).find(
					(v) => v.filename === "phase4-truncated-fake.mp4",
				);
				if (!hit) throw new Error(`not flagged: ${JSON.stringify(det.videos)}`);
				if (!(hit.planned > 16) || hit.actual !== 16) {
					throw new Error(`planned ${hit.planned} actual ${hit.actual}`);
				}
			});
			check("scan does not flag the full 5-shot clip or short clips", () => {
				const hits = (det.videos || []).filter((v) =>
					v.filename.startsWith("phase4-"),
				);
				if (hits.length !== 1) {
					throw new Error(
						`expected only the fake, got ${JSON.stringify(hits)}`,
					);
				}
			});
			fs.rmSync(fakeFile, { force: true });
			const ghost = suspectedTruncatedVideos();
			check("scan skips the injected entry once its file is gone", () => {
				const hit = (ghost.videos || []).find(
					(v) => v.filename === "phase4-truncated-fake.mp4",
				);
				if (hit) {
					throw new Error(`ghost still flagged: ${JSON.stringify(hit)}`);
				}
			});
		} finally {
			c4.videos.delete("phase4-truncated-fake.mp4");
			fs.rmSync(fakeFile, { force: true });
		}
	}

	// ---- OCR: a text-bearing photo (poster-style) imports and its visible
	// text lands in the index, searchable by keyword even though CLIP cannot
	// read the letters. The fixture is rendered via SVG (sharp rasterizes it
	// to PNG) so the test never depends on a real poster file.
	console.log("[phase4] OCR pipeline…");
	// The fixture is an SVG rasterized to PNG by sharp (sharp has no text
	// API) — a poster-style tile whose visible text CLIP cannot read.
	const textSvg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">` +
			`<rect width="800" height="400" fill="#181428"/>` +
			`<text x="60" y="140" font-family="Arial" font-size="56" fill="white" font-weight="bold">PHASE4 OCR POSTER</text>` +
			`<text x="60" y="240" font-family="Arial" font-size="40" fill="#cbd5e1">DIRECTED BY A. TEST</text>` +
			`<text x="60" y="320" font-family="Arial" font-size="32" fill="#94a3b8">NOW STREAMING</text>` +
			`</svg>`,
	);
	const posterFile = path.join(tmp, "phase4-poster.png");
	await (await import("sharp")).default(textSvg).png().toFile(posterFile);
	const ocrRes = await importPaths([posterFile]);
	if (ocrRes.added.length !== 1)
		throw new Error(`phase4 poster import failed: ${JSON.stringify(ocrRes)}`);
	// The OCR queue drains in the background; poll until the poster's slot is
	// filled ("" = OCR'd but no text — the SVG render must have text).
	await waitFor(
		() => {
			const l = loadLibrary();
			const idx = l.filenames.indexOf("phase4-poster.png");
			return idx !== -1 && l.ocr && typeof l.ocr[idx] === "string";
		},
		120000,
		"poster OCR text extraction",
	);
	const ocrIdx = loadLibrary().filenames.indexOf("phase4-poster.png");
	const ocrText = loadLibrary().ocr[ocrIdx] || "";
	// The `check` helper is synchronous, so OCR's async assertions (renderer
	// fetch + DOM search) run through the same passed/failed counters with an
	// explicit await wrapper instead.
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
	check(
		"OCR: poster visible text extracted (contains 'PHASE4' + 'TEST')",
		() => {
			const upper = ocrText.toUpperCase();
			// Tesseract isn't pixel-perfect; require the distinctive tokens, not
			// exact layout. 'PHASE4' exercises digits, 'TEST' a proper noun — the
			// two classes of text CLIP embeddings can't read.
			if (!upper.includes("PHASE4") && !upper.includes("PHASE 4")) {
				throw new Error(`no 'PHASE4' in OCR text: ${JSON.stringify(ocrText)}`);
			}
			if (!upper.includes("TEST")) {
				throw new Error(`no 'TEST' in OCR text: ${JSON.stringify(ocrText)}`);
			}
		},
	);
	await checkAsync(
		"OCR: text served to the renderer in /memories-index.json",
		async () => {
			const served = await win.webContents.executeJavaScript(
				`fetch('/memories-index.json').then(r => r.json()).then(j => ({ ocr: j.ocr, n: j.images.length }))`,
			);
			const row = served.ocr && served.ocr[served.n - 1];
			if (!row || !String(row).toUpperCase().includes("TEST")) {
				throw new Error(
					`index ocr row missing: ${JSON.stringify(served.ocr && served.ocr[served.n - 1])}`,
				);
			}
		},
	);
	await checkAsync(
		"OCR: keyword search finds the poster by its visible text",
		async () => {
			const hits = await win.webContents.executeJavaScript(
				`(async () => {
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, 'test');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 8000) {
					await new Promise((r) => setTimeout(r, 200));
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					if (alts.some((a) => a.includes('phase4-poster'))) return { ok: true, alts: alts.slice(0, 20) };
				}
				return { ok: false, alts: [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).slice(0, 20) };
			})()`,
			);
			if (hits.error || !hits.ok) {
				throw new Error(
					`poster not found by 'test' keyword: ${JSON.stringify(hits)}`,
				);
			}
		},
	);
	// The dedicated OCR tab (Files | Scenes | OCR): OCR-only results, no
	// model and no filename matching. The phase-4 library is exactly two
	// files — the poster (OCR text contains "TEST") and the clip (no OCR
	// text, but "clip" IS in its filename) — so a search can prove both
	// sides: "test" must surface the poster and only it, "clip" must find
	// nothing (filename evidence is deliberately ignored in OCR mode).
	await checkAsync(
		"OCR: OCR mode button present in the Files/Scenes toggle",
		async () => {
			const found = await win.webContents.executeJavaScript(
				`(() => {
				const btn = [...document.querySelectorAll('button')].find(
					(b) => (b.getAttribute('aria-label') || '') === 'OCR search mode',
				);
				return btn ? btn.textContent.trim() : null;
			})()`,
			);
			if (found !== "OCR") {
				throw new Error(`OCR mode button missing: ${JSON.stringify(found)}`);
			}
		},
	);
	await checkAsync(
		"OCR: mode finds the poster by visible text and nothing else",
		async () => {
			const res = await win.webContents.executeJavaScript(
				`(async () => {
				const ocrBtn = [...document.querySelectorAll('button')].find(
					(b) => (b.getAttribute('aria-label') || '') === 'OCR search mode',
				);
				if (!ocrBtn) return { error: 'no OCR button' };
				ocrBtn.click();
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, 'test');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 8000) {
					await new Promise((r) => setTimeout(r, 200));
					const alts = [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt') || '');
					const hasPoster = alts.some((a) => a.includes('phase4-poster'));
					const hasClip = alts.some((a) => a.includes('phase4-clip'));
					if (hasPoster) return { ok: true, hasClip, alts: alts.slice(0, 10) };
				}
				return { ok: false, alts: [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).slice(0, 10) };
			})()`,
			);
			if (res.error || !res.ok) {
				throw new Error(
					`OCR mode did not find the poster by visible text: ${JSON.stringify(res)}`,
				);
			}
			if (res.hasClip) {
				throw new Error(
					`OCR mode leaked a filename-only match for 'test': ${JSON.stringify(res)}`,
				);
			}
		},
	);
	await checkAsync(
		"OCR: mode ignores filenames ('clip' matches nothing)",
		async () => {
			const res = await win.webContents.executeJavaScript(
				`(async () => {
				const input = document.querySelector('input[aria-label="Search memories"]');
				if (!input) return { error: 'no search input' };
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, 'clip');
				input.dispatchEvent(new Event('input', { bubbles: true }));
				const t0 = Date.now();
				while (Date.now() - t0 < 8000) {
					await new Promise((r) => setTimeout(r, 200));
					const body = document.body.textContent || '';
					if (body.includes('No images with matching text')) return { ok: true };
				}
				return {
					ok: false,
					alts: [...document.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).slice(0, 10),
				};
			})()`,
			);
			if (res.error || !res.ok) {
				throw new Error(
					`OCR mode matched a filename-only query ('clip'): ${JSON.stringify(res)}`,
				);
			}
		},
	);
	// Leave the app in its default state: back to Files mode + a cleared
	// search box, so later tray assertions see the unfiltered grid.
	await win.webContents.executeJavaScript(
		`(async () => {
			const filesBtn = [...document.querySelectorAll('button')].find(
				(b) => (b.getAttribute('aria-label') || '') === 'File search mode',
			);
			if (filesBtn) filesBtn.click();
			const input = document.querySelector('input[aria-label="Search memories"]');
			if (input) {
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}
		})()`,
	);

	// The meta/bin pair below is read straight from disk: drain first so a
	// still-queued save can't hand us a mixed-era pair (see waitForBinDrain).
	await waitForBinDrain(modelId, "sidecar");
	const c = loadSegments(modelId);
	const clipSegs = c.videos.get("phase4-clip.mp4") || [];
	const meta = JSON.parse(
		fs.readFileSync(segmentsMetaFileFor(modelId), "utf8"),
	);
	const bin = fs.readFileSync(segmentsBinFileFor(modelId));
	const header = new Int32Array(bin.buffer, bin.byteOffset, 2);

	check(
		"sidecar: meta.total === bin header[0] (Phase-2 total bug guard)",
		() => {
			if (header[0] !== meta.total)
				throw new Error(`header ${header[0]} vs total ${meta.total}`);
		},
	);
	check(
		"sidecar: header[1] === meta.dim === library dim (Phase-2 dim bug guard)",
		() => {
			if (header[1] !== meta.dim || meta.dim !== loadLibrary().dim) {
				throw new Error(
					`header ${header[1]} meta ${meta.dim} lib ${loadLibrary().dim}`,
				);
			}
		},
	);
	// Pins encodeBin's exact header layout ([count, dim] Int32s then rows) —
	// keep in sync with saveSegments/encodeBin if the format ever changes.
	check("sidecar: bin byte-length is exactly 8 + total × dim × 4", () => {
		const expect = 8 + meta.total * meta.dim * 4;
		if (bin.length !== expect)
			throw new Error(`bin ${bin.length}B, expected ${expect}B`);
	});
	check("sidecar: every segment offset lands inside the bin", () => {
		for (const v of meta.videos || []) {
			for (const s of v.segments || []) {
				if (!(s.off >= 0 && s.off < meta.total))
					throw new Error(`${v.filename} off ${s.off}`);
			}
		}
	});
	check("sidecar: clip segment midpoints are inside the video duration", () => {
		for (const s of clipSegs) {
			if (!(s.t > 0 && s.t < duration))
				throw new Error(`t ${s.t} vs duration ${duration}`);
		}
	});
	check("scene posters persisted for every clip segment", () => {
		for (const s of clipSegs) {
			const poster = path.join(
				POSTERS_DIR,
				`phase4-clip-scene-${s.poster}.jpg`,
			);
			if (!fs.existsSync(poster)) throw new Error(`missing ${poster}`);
		}
	});
	check("progress: detect AND embed phases both streamed", () => {
		if (enrichPhaseCounts.detect < 1 || enrichPhaseCounts.embed < 1) {
			throw new Error(
				`detect ${enrichPhaseCounts.detect} embed ${enrichPhaseCounts.embed}`,
			);
		}
	});
	check(
		"progress: zero range violations (pct in [0,1], done in 1..total)",
		() => {
			if (getEnrichProgressViolations() !== 0)
				throw new Error(`${getEnrichProgressViolations()} violations`);
		},
	);
	console.log(
		`       ${getEnrichEventsObserved()} progress events (detect ${enrichPhaseCounts.detect}, embed ${enrichPhaseCounts.embed})`,
	);

	// ---- 3. launch-backfill round trip ----------------------------------
	console.log("[phase4] launch backfill round trip…");
	await waitFor(() => getEnrichQueue().length === 0, 120000, "queue drain");
	// Simulate a library whose sidecar was lost (a pre-Phase-4 import, or a
	// deleted cache): remove the model's sidecar files, then run the exact
	// launch-time backfill and expect it to repopulate WITHOUT any import.
	const before = meta.total;
	fs.unlinkSync(segmentsMetaFileFor(modelId));
	fs.unlinkSync(segmentsBinFileFor(modelId));
	backfillEnrichment();
	await waitFor(
		() => {
			const c2 = loadSegments(modelId);
			return (
				c2.loaded && c2.videos.has("phase4-clip.mp4") && c2.rows.length > 0
			);
		},
		120000,
		"backfill re-enrichment",
	);
	const c2 = loadSegments(modelId);
	check("backfill: sidecar repopulated to the same row count", () => {
		if (c2.rows.length !== before) {
			throw new Error(`rows ${c2.rows.length}, expected ${before}`);
		}
	});
	await waitFor(
		() => getEnrichQueue().length === 0,
		120000,
		"post-backfill drain",
	);

	// ---- 4. migration backfill (conditional on cached weights) -----------
	console.log("[phase4] migration backfill…");
	const startModel = loadLibrary().modelId;
	const migrateTarget =
		process.env.ELECTRON_SMOKE_PHASE4_MIGRATE_TO || "siglip-base-patch16-384";
	if (getModel(migrateTarget) && migrateTarget !== startModel) {
		try {
			const out = await reembedToModel(migrateTarget);
			// A delta switch resolves at the flip — wait for the background
			// tail (which also runs the post-migration backfills) before
			// asserting coverage below.
			if (out.delta) {
				await migrationSettled();
			}
			if (!out.delta && out.reembedded !== loadLibrary().filenames.length) {
				throw new Error(`migration reembedded ${out.reembedded}`);
			}
			// The target model's sidecar was empty; the post-migration backfill
			// (Phase-4 review fix) must repopulate it without an import.
			await waitFor(
				() => {
					const tc = loadSegments(migrateTarget);
					return (
						tc.loaded && tc.videos.has("phase4-clip.mp4") && tc.rows.length > 0
					);
				},
				120000,
				"target-model backfill after migration",
			);
			const tc = loadSegments(migrateTarget);
			check("migration backfill: target model's sidecar repopulated", () => {
				if (tc.rows.length === 0) throw new Error("target sidecar empty");
			});
			await waitFor(
				() => getEnrichQueue().length === 0,
				120000,
				"post-migration drain",
			);
		} catch (err) {
			// modelDownloaded() can't see this cache's nested layout, so the
			// guard is "attempt, then skip only on a genuine weights/network
			// failure" — a real regression still fails loudly.
			if (
				/download|fetch|network|cache|weights|onnx/i.test(
					String(err?.message || err),
				)
			) {
				console.log(`  · SKIP migration backfill (${err.message})`);
			} else {
				throw err;
			}
		}
	} else {
		console.log(
			`  · SKIP migration backfill (target ${migrateTarget} not configured or already active)`,
		);
	}

	// ---- 5. renderer tray state machine + enrich-state IPC ---------------
	console.log("[phase4] renderer tray + enrich-state IPC…");
	const idleState = await win.webContents.executeJavaScript(
		"window.memories.getEnrichState()",
	);
	check("enrich-state IPC: idle, pending 0, correct shape after drain", () => {
		if (!idleState || idleState.type !== "enrich")
			throw new Error("bad shape " + JSON.stringify(idleState));
		if (idleState.active !== false)
			throw new Error(`active ${idleState.active}`);
		if (idleState.pending !== 0)
			throw new Error(`pending ${idleState.pending}`);
	});

	// Injected status events (the real queue is drained, so nothing races
	// them) drive every tray state, then idle hides the pill.
	win.webContents.send("memories:status", {
		type: "enrich",
		phase: "embed",
		filename: "phase4-clip.mp4",
		done: 2,
		total: 5,
		pending: 1,
		active: true,
	});
	const embedPill = await trayShows("Embedding scenes");
	check("tray: embed state shows label + filename + done/total", () => {
		if (!embedPill.ok) throw new Error(JSON.stringify(embedPill));
		if (!/phase4-clip\.mp4/.test(embedPill.text))
			throw new Error("no filename: " + embedPill.text);
		if (!/2\/5/.test(embedPill.text))
			throw new Error("no fraction: " + embedPill.text);
	});

	win.webContents.send("memories:status", {
		type: "enrich",
		phase: "detect",
		filename: "phase4-clip.mp4",
		pct: 0.42,
		pending: 1,
		active: true,
	});
	const detectPill = await trayShows("Analyzing scenes");
	check("tray: detect state shows decode %", () => {
		if (!detectPill.ok) throw new Error(JSON.stringify(detectPill));
		if (!/42%/.test(detectPill.text))
			throw new Error("no pct: " + detectPill.text);
	});

	win.webContents.send("memories:status", {
		type: "enrich",
		phase: "queued",
		pending: 3,
	});
	const queuedPill = await trayShows("Scene analysis queued");
	check("tray: queued state shows the waiting count", () => {
		if (!queuedPill.ok) throw new Error(JSON.stringify(queuedPill));
		if (!/3 waiting/.test(queuedPill.text))
			throw new Error("no count: " + queuedPill.text);
	});

	win.webContents.send("memories:status", {
		type: "enrich",
		phase: "paused",
		active: true,
		filename: "phase4-clip.mp4",
		pending: 1,
	});
	const pausedPill = await trayShows("Paused while you search");
	check("tray: paused state shows while a query preempts", () => {
		if (!pausedPill.ok) throw new Error(JSON.stringify(pausedPill));
	});

	win.webContents.send("memories:status", {
		type: "enrich",
		phase: "idle",
		pending: 0,
	});
	const trayGoneCheck = await trayGone();
	check("tray: clears on idle", () => {
		if (!trayGoneCheck.ok) throw new Error("pill still visible after idle");
	});

	if (failed > 0) {
		throw new Error(`${failed} phase4 check(s) failed (${passed} passed)`);
	}
	console.log(`[phase4] OK (${passed} checks)`);
}
module.exports = { runPhase4DeepTest };
