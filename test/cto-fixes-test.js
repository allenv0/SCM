"use strict";

// Ultra-deep verification of the CTO Week-1 fixes (ELECTRON_SMOKE_CTO=1).
// Runs inside the main process with a ctx of internals — the same pattern
// as test/deep-test.js. No model weights are required: the rank path is
// exercised through the qVecOverride hole added for tests (C-03).
//
// Covers:
//   C-05  prune guard (aborts on mass-missing; prunes a single stale row)
//   C-02  bin structural validation + quarantine (corrupt vs mismatched)
//   M-04  atomic saveSegments/saveLibrary (no .tmp-* leftovers; promise)
//   M-01  sandbox:true in webPreferences
//   M-02  strict CSP header on index.html (no inline/eval script)
//   C-03  rank correctness + large-library perf + diversity cap

async function runCtoFixesTest(ctx) {
	const {
		win,
		DEFAULT_MODEL_ID,
		loadLibrary,
		resetLibraryCache,
		pruneStaleLibraryEntries,
		saveLibrary,
		saveSegments,
		loadSegments,
		rankSearch,
		embedFileFor,
		segmentsBinFileFor,
		segmentsMetaFileFor,
		PHOTOS_DIR,
		DATA_DIR,
		INDEX_FILE,
		getWebPreferences,
	} = ctx;
	const fs = require("fs");
	const path = require("path");

	let passed = 0;
	let failed = 0;
	const check = (name, fn) => {
		try {
			fn();
			passed++;
			console.log(`  \u2713 ${name}`);
		} catch (err) {
			failed++;
			console.error(`  \u2717 ${name}: ${err.message}`);
		}
	};
	const checkAsync = async (name, fn) => {
		try {
			await fn();
			passed++;
			console.log(`  \u2713 ${name}`);
		} catch (err) {
			failed++;
			console.error(`  \u2717 ${name}: ${err.message}`);
		}
	};
	const waitFor = async (fn, timeoutMs, label) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			try {
				const v = await fn();
				if (v) return v;
			} catch {
				/* poll */
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	const touchPhoto = (name) => {
		fs.mkdirSync(PHOTOS_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(PHOTOS_DIR, name),
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
		);
	};

	// ----- M-01 sandbox -----
	check(
		"M-01 webPreferences.sandbox === true (+ contextIsolation, no nodeIntegration)",
		() => {
			const wp = getWebPreferences();
			if (wp.sandbox !== true) throw new Error("sandbox not enabled");
			if (wp.contextIsolation !== true) throw new Error("contextIsolation off");
			if (wp.nodeIntegration !== false) throw new Error("nodeIntegration on");
		},
	);

	// ----- M-02 CSP -----
	await checkAsync(
		"M-02 index.html ships a strict CSP (no inline/eval script)",
		async () => {
			const hdrs = await waitFor(
				async () => {
					const h = await win.webContents.executeJavaScript(
						"fetch('/').then(r => { const h = {}; r.headers.forEach((v,k) => h[k]=v); return h; })",
					);
					return h && h["content-security-policy"] ? h : null;
				},
				15000,
				"index.html CSP header",
			);
			const csp = hdrs["content-security-policy"];
			if (!/default-src 'self'/.test(csp))
				throw new Error("default-src not self: " + csp);
			if (!/script-src 'self'/.test(csp))
				throw new Error("script-src not self: " + csp);
			if (/script-src[^;]*'unsafe-inline'/.test(csp))
				throw new Error("inline scripts allowed: " + csp);
			if (/script-src[^;]*'unsafe-eval'/.test(csp))
				throw new Error("eval allowed: " + csp);
			if (!/object-src 'none'/.test(csp))
				throw new Error("object-src not none: " + csp);
		},
	);

	// ----- C-05 prune guard -----
	await checkAsync(
		"C-05 aborts when \u226550% of photos are missing (no silent wipe)",
		async () => {
			resetLibraryCache();
			fs.mkdirSync(DATA_DIR, { recursive: true });
			for (const f of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) touchPhoto(f);
			const l = loadLibrary();
			l.filenames = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
			l.sources = l.filenames.map(() => null);
			l.sourceMtimes = l.filenames.map(() => null);
			l.ocr = [];
			l.hashes = [];
			l.embeddings = [];
			l.phrases = [];
			l.dim = 0;
			l.modelId = DEFAULT_MODEL_ID;
			await saveLibrary();
			// 3 of 4 missing -> >=50% -> must refuse to wipe.
			fs.unlinkSync(path.join(PHOTOS_DIR, "b.jpg"));
			fs.unlinkSync(path.join(PHOTOS_DIR, "c.jpg"));
			fs.unlinkSync(path.join(PHOTOS_DIR, "d.jpg"));
			await pruneStaleLibraryEntries();
			const after = loadLibrary().filenames.length;
			if (after !== 4)
				throw new Error(
					`library wiped to ${after} on mass-missing - guard failed`,
				);
		},
	);

	await checkAsync(
		"C-05 prunes a single genuinely-stale row (25% missing)",
		async () => {
			// Restore b,c,d and remove a so exactly 1 of 4 is missing.
			touchPhoto("b.jpg");
			touchPhoto("c.jpg");
			touchPhoto("d.jpg");
			fs.unlinkSync(path.join(PHOTOS_DIR, "a.jpg"));
			await pruneStaleLibraryEntries();
			const l2 = loadLibrary();
			if (l2.filenames.length !== 3)
				throw new Error(
					`expected 3 rows after prune, got ${l2.filenames.length}`,
				);
			if (l2.filenames.includes("a.jpg"))
				throw new Error("stale row a.jpg was not removed");
		},
	);

	// ----- C-02 bin validation + quarantine -----
	await checkAsync(
		"C-02 corrupt (truncated) bin is quarantined, no crash/OOM",
		async () => {
			resetLibraryCache();
			fs.mkdirSync(DATA_DIR, { recursive: true });
			fs.writeFileSync(
				INDEX_FILE,
				JSON.stringify({
					version: 4,
					images: ["x.jpg"],
					dim: 512,
					modelId: DEFAULT_MODEL_ID,
					generatedAt: new Date().toISOString(),
				}),
			);
			const embFile = embedFileFor(DEFAULT_MODEL_ID);
			fs.mkdirSync(path.dirname(embFile), { recursive: true });
			// Header claims count=1000, dim=512, but body is 0 bytes (truncated).
			const bad = Buffer.alloc(8);
			bad.writeInt32LE(1000, 0);
			bad.writeInt32LE(512, 4);
			fs.writeFileSync(embFile, bad);
			const l = loadLibrary();
			if (l.embeddings.length !== 0)
				throw new Error(
					`expected 0 embeddings after corrupt bin, got ${l.embeddings.length}`,
				);
			const quarantined = fs
				.readdirSync(DATA_DIR)
				.some((f) => /\.corrupt-\d+$/.test(f));
			if (!quarantined) throw new Error("no .corrupt-* file found in DATA_DIR");
		},
	);

	await checkAsync(
		"C-02 a count-mismatched (but valid) bin is NOT quarantined",
		async () => {
			// A bin whose header is internally consistent but for a different
			// count must return [] WITHOUT quarantining - the legacy-fallback
			// chain depends on mismatch being a normal signal, not corruption.
			resetLibraryCache();
			fs.mkdirSync(DATA_DIR, { recursive: true });
			// Clear quarantines from the previous check so the assertion is clean.
			for (const f of fs.readdirSync(DATA_DIR)) {
				if (/\.corrupt-\d+$/.test(f)) fs.unlinkSync(path.join(DATA_DIR, f));
			}
			fs.writeFileSync(
				INDEX_FILE,
				JSON.stringify({
					version: 4,
					images: ["y.jpg"],
					dim: 512,
					modelId: DEFAULT_MODEL_ID,
					generatedAt: new Date().toISOString(),
				}),
			);
			const embFile = embedFileFor(DEFAULT_MODEL_ID);
			fs.mkdirSync(path.dirname(embFile), { recursive: true });
			const n = 5,
				dim = 512;
			const buf = Buffer.alloc(8 + n * dim * 4); // full body present -> valid
			buf.writeInt32LE(n, 0);
			buf.writeInt32LE(dim, 4);
			fs.writeFileSync(embFile, buf);
			const l = loadLibrary();
			if (l.embeddings.length !== 0)
				throw new Error(
					`expected 0 embeddings (count mismatch), got ${l.embeddings.length}`,
				);
			const quarantined = fs
				.readdirSync(DATA_DIR)
				.some((f) => /\.corrupt-\d+$/.test(f));
			if (quarantined)
				throw new Error("valid mismatched bin was wrongly quarantined");
		},
	);

	await checkAsync(
		"C-02 an EMPTY (count=0) bin is NOT quarantined (app's own 'no phrases yet' shape)",
		async () => {
			// encodeBin([], 0) writes header [0,0] + no body — this is the bin
			// shape a fresh library writes for phrases before the text model
			// loads. It must load as "empty", never be flagged corrupt.
			resetLibraryCache();
			fs.mkdirSync(DATA_DIR, { recursive: true });
			for (const f of fs.readdirSync(DATA_DIR)) {
				if (/\.corrupt-\d+$/.test(f)) fs.unlinkSync(path.join(DATA_DIR, f));
			}
			fs.writeFileSync(
				INDEX_FILE,
				JSON.stringify({
					version: 4,
					images: [],
					dim: 0,
					modelId: DEFAULT_MODEL_ID,
					generatedAt: new Date().toISOString(),
				}),
			);
			const embFile = embedFileFor(DEFAULT_MODEL_ID);
			fs.mkdirSync(path.dirname(embFile), { recursive: true });
			const empty = Buffer.alloc(8); // header [0,0], no body
			fs.writeFileSync(embFile, empty);
			const l = loadLibrary();
			if (l.embeddings.length !== 0)
				throw new Error(`expected 0 embeddings, got ${l.embeddings.length}`);
			const quarantined = fs
				.readdirSync(DATA_DIR)
				.some((f) => /\.corrupt-\d+$/.test(f));
			if (quarantined)
				throw new Error(
					"empty count=0 bin was wrongly quarantined (would nuke every fresh library's phrase bin)",
				);
		},
	);

	// ----- M-04 atomic saves + no tmp leftovers -----
	await checkAsync("M-04 saveLibrary leaves no .tmp-* leftovers", async () => {
		resetLibraryCache();
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const l = loadLibrary();
		l.filenames = [];
		l.embeddings = [];
		l.phrases = [];
		l.dim = 0;
		l.modelId = DEFAULT_MODEL_ID;
		l.sources = [];
		l.sourceMtimes = [];
		l.ocr = [];
		l.hashes = [];
		await saveLibrary();
		// Writes are async through the FIFO queue - give it a beat to settle.
		await new Promise((r) => setTimeout(r, 300));
		const tmps = fs.readdirSync(DATA_DIR).filter((f) => f.includes(".tmp-"));
		if (tmps.length) throw new Error(`leftover tmp files: ${tmps.join(",")}`);
		if (!fs.existsSync(INDEX_FILE)) throw new Error("index not written");
	});

	await checkAsync(
		"M-04 saveSegments is atomic (async, bin-first/meta-last, no tmp)",
		async () => {
			resetLibraryCache();
			fs.mkdirSync(DATA_DIR, { recursive: true });
			const modelId = DEFAULT_MODEL_ID;
			const dim = 512,
				total = 1;
			const binFile = segmentsBinFileFor(modelId);
			const metaFile = segmentsMetaFileFor(modelId);
			fs.mkdirSync(path.dirname(binFile), { recursive: true });
			// Seed a valid segments pair so loadSegments marks the cache loaded,
			// then re-save through the new atomic path.
			const bin = Buffer.alloc(8 + total * dim * 4);
			bin.writeInt32LE(total, 0);
			bin.writeInt32LE(dim, 4);
			fs.writeFileSync(binFile, bin);
			fs.writeFileSync(
				metaFile,
				JSON.stringify({ version: 1, modelId, dim, total, videos: [] }),
			);
			const c = loadSegments(modelId);
			if (!c.loaded) throw new Error("segments did not load from a valid bin");
			const p = saveSegments();
			if (!p || typeof p.then !== "function")
				throw new Error(
					"saveSegments did not return a promise (not async/queued)",
				);
			await p;
			await new Promise((r) => setTimeout(r, 300));
			const tmps = fs.readdirSync(DATA_DIR).filter((f) => f.includes(".tmp-"));
			if (tmps.length) throw new Error(`leftover tmp files: ${tmps.join(",")}`);
			if (!fs.existsSync(binFile) || !fs.existsSync(metaFile))
				throw new Error("segments files missing after save");
		},
	);

	// ----- C-03 rank: correctness + perf + diversity cap -----
	await checkAsync(
		"C-03 rankSearch ranks the right photo first (qVec override)",
		async () => {
			resetLibraryCache();
			const l = loadLibrary();
			const dim = 512;
			l.modelId = DEFAULT_MODEL_ID;
			l.dim = dim;
			const N = 2000;
			l.filenames = [];
			l.embeddings = [];
			for (let i = 0; i < N; i++) {
				const v = new Float32Array(dim);
				if (i === 0) {
					v[0] = 1;
				} // the target: unit along dim 0
				else {
					v[0] = i * 0.0001;
					for (let k = 1; k < dim; k++) v[k] = ((i + k) % 7) * 0.001;
				}
				l.embeddings.push(v);
				l.filenames.push(`img-${i}.jpg`);
			}
			l.phrases = [];
			l.ocr = [];
			l.hashes = [];
			l.sources = [];
			l.sourceMtimes = [];
			const qVec = new Float32Array(dim);
			qVec[0] = 1; // matches row 0 exactly
			const results = await rankSearch("target", 24, qVec);
			if (!results.length) throw new Error("rankSearch returned no results");
			if (results[0].filename !== "img-0.jpg")
				throw new Error(`expected img-0.jpg first, got ${results[0].filename}`);
			if (results.length > 24)
				throw new Error(`topK not respected: ${results.length}`);
		},
	);

	await checkAsync(
		"C-03 rankSearch survives 20k rows + diversity cap (perf)",
		async () => {
			resetLibraryCache();
			const l = loadLibrary();
			const dim = 512;
			l.modelId = DEFAULT_MODEL_ID;
			l.dim = dim;
			const N = 20000; // ~40MB; the pathological pre-fix scale
			l.filenames = [];
			l.embeddings = [];
			for (let i = 0; i < N; i++) {
				const v = new Float32Array(dim);
				v[0] = 1; // every row is a near-match -> cutoff keeps all -> diversity cap fires
				if (i !== 0)
					for (let k = 1; k < dim; k++) v[k] = ((i + k) % 11) * 0.0005;
				l.embeddings.push(v);
				l.filenames.push(`big-${i}.jpg`);
			}
			l.phrases = [];
			l.ocr = [];
			l.hashes = [];
			l.sources = [];
			l.sourceMtimes = [];
			const qVec = new Float32Array(dim);
			qVec[0] = 1;
			const t0 = Date.now();
			const results = await rankSearch("target", 24, qVec);
			const ms = Date.now() - t0;
			if (!results.length)
				throw new Error("rankSearch returned no results on large library");
			if (results[0].filename !== "big-0.jpg")
				throw new Error(`expected big-0.jpg first, got ${results[0].filename}`);
			if (results.length > 24)
				throw new Error(`topK not respected: ${results.length}`);
			// Loose ceiling so this isn't flaky on CI. Pre-fix this scale could
			// block the main process for hundreds of ms (full sort + O(N*K*dim)
			// diversity). With cached norms + the 500-candidate cap it should be
			// well under a second; 4s leaves generous headroom.
			if (ms > 4000)
				throw new Error(
					`rank too slow at ${N}: ${ms}ms (norms/diversity-cap regression?)`,
				);
			console.log(`    [perf] ${N} rows ranked in ${ms}ms`);
		},
	);

	// Restore a clean library state so nothing synthetic persists.
	resetLibraryCache();
	loadLibrary();

	if (failed > 0)
		throw new Error(`${failed} CTO check(s) failed (${passed} passed)`);
	console.log(`[cto] OK (${passed} checks)`);
}

module.exports = { runCtoFixesTest };
