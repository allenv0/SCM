#!/usr/bin/env node
"use strict";
// Stage C parity + retrieval harness (plan §5).
// Compares CPU-q8 dump vs native dump for:
//   G1a  min/median normalized image-vector cosine
//   G1b  retrieval parity via main-lib/rank-search.js scoreLibrary()
//
// Usage: node parity.js [--native out/native-vectors-ne.json] [--report out/parity.json]

const fs = require("fs");
const path = require("path");
const { scoreLibrary, cosineSim } = require("../../main-lib/rank-search.js");

const ROOT = path.resolve(__dirname);
const BASELINE = path.join(ROOT, "out", "baseline");

function arg(flag, fallback) {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === flag) return argv[i + 1];
		if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
	}
	return fallback;
}

function normalize(v) {
	const out = Float32Array.from(v);
	let n = 0;
	for (let i = 0; i < out.length; i++) n += out[i] * out[i];
	n = Math.sqrt(n);
	if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
	return out;
}

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(xs, p) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

function topKSet(rows, k) {
	return rows.slice(0, k).map((r) => r.filename);
}

function membershipChange(a, b, k) {
	const A = new Set(topKSet(a, k));
	const B = new Set(topKSet(b, k));
	const onlyA = [...A].filter((x) => !B.has(x));
	const onlyB = [...B].filter((x) => !A.has(x));
	return { onlyCpu: onlyA, onlyNative: onlyB, identical: onlyA.length === 0 && onlyB.length === 0 };
}

function orderChange(a, b, k) {
	const A = topKSet(a, k);
	const B = topKSet(b, k);
	const changes = [];
	for (let i = 0; i < Math.min(k, A.length, B.length); i++) {
		if (A[i] !== B[i]) changes.push({ rank: i + 1, cpu: A[i], native: B[i] });
	}
	return changes;
}

function scoreTieBandPass(cpuScore, nativeScore, band) {
	return Math.abs(cpuScore - nativeScore) <= band;
}

async function main() {
	const nativePath = arg(
		"--native",
		path.join(ROOT, "out", "native-vectors-ne.json"),
	);
	const reportPath = arg("--report", path.join(ROOT, "out", "parity.json"));
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "fixtures", "manifest.json"), "utf8"),
	);
	const index = JSON.parse(
		fs.readFileSync(path.join(BASELINE, "index.json"), "utf8"),
	);
	const queriesDump = JSON.parse(
		fs.readFileSync(path.join(BASELINE, "queries.json"), "utf8"),
	);
	const nativeDump = JSON.parse(fs.readFileSync(nativePath, "utf8"));

	const dim = index.dim;
	const tieBand = manifest.scoreTieBand;

	// ---- G1a vector parity ----
	const nativeById = new Map(nativeDump.vectors.map((v) => [v.id, v]));
	const cosines = [];
	const perImage = [];
	for (const rec of index.images) {
		const cpuFile = path.join(BASELINE, `${rec.id}.json`);
		const cpu = JSON.parse(fs.readFileSync(cpuFile, "utf8"));
		const nat = nativeById.get(rec.id);
		if (!nat) {
			perImage.push({ id: rec.id, missingNative: true });
			continue;
		}
		const a = normalize(cpu.cpuQ8.normalized);
		// Native raw → SCM-normalized (same as embedRawImage post-processing).
		const b = normalize(nat.vec);
		const c = cosineSim(a, b);
		cosines.push(c);
		perImage.push({
			id: rec.id,
			kind: rec.kind,
			cosine: c,
			delta: 1 - c,
			cpuNormChecksum: cpu.cpuQ8.normalizedChecksum,
			nativeChecksum: nat.checksum,
		});
	}
	cosines.sort((x, y) => x - y);
	const minCos = cosines[0] ?? 0;
	const medCos = median(cosines);
	const p05 = pct(cosines, 0.05);

	// Image-to-image NN change (diagnostic only)
	const cpuNorms = new Map();
	const natNorms = new Map();
	for (const rec of index.images) {
		const cpu = JSON.parse(
			fs.readFileSync(path.join(BASELINE, `${rec.id}.json`), "utf8"),
		);
		cpuNorms.set(rec.id, normalize(cpu.cpuQ8.normalized));
		const nat = nativeById.get(rec.id);
		if (nat) natNorms.set(rec.id, normalize(nat.vec));
	}
	let nnChanged = 0;
	const ids = [...cpuNorms.keys()].filter((id) => natNorms.has(id));
	for (const id of ids) {
		let bestCpu = null;
		let bestNat = null;
		let bestCpuSim = -2;
		let bestNatSim = -2;
		for (const other of ids) {
			if (other === id) continue;
			const sc = cosineSim(cpuNorms.get(id), cpuNorms.get(other));
			const sn = cosineSim(natNorms.get(id), natNorms.get(other));
			if (sc > bestCpuSim) {
				bestCpuSim = sc;
				bestCpu = other;
			}
			if (sn > bestNatSim) {
				bestNatSim = sn;
				bestNat = other;
			}
		}
		if (bestCpu !== bestNat) nnChanged++;
	}

	// ---- G1b retrieval parity ----
	// Build library rows from fixture filenames + CPU / native embeddings.
	const filenames = index.images.map((r) => r.id + ".jpg");
	const cpuEmbs = index.images.map((r) => cpuNorms.get(r.id));
	const natEmbs = index.images.map((r) => natNorms.get(r.id) || cpuNorms.get(r.id));
	// Filename phrases / OCR disabled for the fixture corpus: scoreLibrary
	// phrase path is skipped when phrases.length !== filenames.length.
	const phrases = [];
	const ocrWords = [];
	const norms = cpuEmbs.map((v) => {
		let n = 0;
		for (let i = 0; i < v.length; i++) n += v[i] * v[i];
		return Math.sqrt(n);
	});
	const natNormsArr = natEmbs.map((v) => {
		let n = 0;
		for (let i = 0; i < v.length; i++) n += v[i] * v[i];
		return Math.sqrt(n);
	});

	const libCpu = { filenames, embeddings: cpuEmbs, phrases, ocrWords, dim };
	const libNat = {
		filenames,
		embeddings: natEmbs,
		phrases,
		ocrWords,
		dim,
	};

	const thresholds = {}; // defaults from rank-search.js
	const topK = 10;
	const retrieval = [];
	let top5RetainedAll = true;
	let top10IdenticalAll = true;
	let maxScoreDelta = 0;

	for (const q of queriesDump.queries) {
		const qVec = normalize(q.centered || q.normalized);
		const trimmed = q.query;
		const cpuRows = scoreLibrary(libCpu, trimmed, qVec, topK, thresholds, norms);
		const natRows = scoreLibrary(
			libNat,
			trimmed,
			qVec,
			topK,
			thresholds,
			natNormsArr,
		);

		// Map expected positives: manifest uses image ids; filenames are id+".jpg"
		const expected = (q.expectedPositives || []).map((e) => e + ".jpg");
		const cpuTop5 = topKSet(cpuRows, 5);
		const natTop5 = topKSet(natRows, 5);
		const retained = expected.filter((e) => cpuTop5.includes(e));
		const retainedNat = expected.filter((e) => natTop5.includes(e));
		const top5Ok =
			expected.length === 0 ||
			(expected.every((e) => cpuTop5.includes(e) || !cpuRows.some((r) => r.filename === e))
				? true
				: expected.filter((e) => cpuTop5.includes(e)).length >=
					Math.min(expected.length, 5));
		// Gate: every labeled expected positive remains Top-5 on BOTH corpora
		// when it was Top-5 on CPU (retention), and expected positives present
		// in CPU Top-5 stay in native Top-5.
		const cpuExpectedInTop5 = expected.filter((e) => cpuTop5.includes(e));
		const natKeepsCpuExpected = cpuExpectedInTop5.every((e) =>
			natTop5.includes(e),
		);
		if (!natKeepsCpuExpected) top5RetainedAll = false;

		const mem = membershipChange(cpuRows, natRows, topK);
		if (!mem.identical) top10IdenticalAll = false;

		// Score deltas per shared filename
		const cpuScore = new Map(cpuRows.map((r) => [r.filename, r.score]));
		const natScore = new Map(natRows.map((r) => [r.filename, r.score]));
		const deltas = [];
		for (const [fn, cs] of cpuScore) {
			const ns = natScore.get(fn);
			if (ns === undefined) {
				deltas.push({ filename: fn, cpu: cs, native: null, delta: null, inTieBand: false });
				continue;
			}
			const d = Math.abs(cs - ns);
			if (d > maxScoreDelta) maxScoreDelta = d;
			deltas.push({
				filename: fn,
				cpu: cs,
				native: ns,
				delta: cs - ns,
				inTieBand: scoreTieBandPass(cs, ns, tieBand),
			});
		}

		retrieval.push({
			id: q.id,
			query: q.query,
			expectedPositives: q.expectedPositives,
			cpuTop10: topKSet(cpuRows, topK),
			nativeTop10: topKSet(natRows, topK),
			cpuTop5,
			nativeTop5: natTop5,
			top5Retention: {
				expected,
				cpuExpectedInTop5,
				nativeKeeps: natKeepsCpuExpected,
				retainedCpu: retained,
				retainedNative: retainedNat,
			},
			membership: mem,
			orderChanges: orderChange(cpuRows, natRows, topK),
			scoreDeltas: deltas,
			diversityNote: "diversity filter applied inside scoreLibrary when candidates > topK",
		});
	}

	const g1aPass = minCos >= 0.995;
	const g1aKill = minCos < 0.99;
	const g1bPass = top5RetainedAll && top10IdenticalAll;

	const report = {
		schema: "coreml-native-parity/v1",
		createdAt: new Date().toISOString(),
		modelId: index.modelId,
		dim,
		nativePath,
		scoreTieBand: tieBand,
		corpus: {
			images: index.images.length,
			queries: queriesDump.queries.length,
			complete: manifest.complete,
		},
		g1a: {
			minCosine: minCos,
			medianCosine: medCos,
			p05Cosine: p05,
			maxDelta: 1 - minCos,
			passBar: 0.995,
			killBar: 0.99,
			pass: g1aPass,
			kill: g1aKill,
			perImage,
		},
		g1b: {
			top5RetainedAll,
			top10IdenticalAll,
			maxScoreDelta,
			tieBand,
			pass: g1bPass,
			queries: retrieval,
		},
		diagnostics: {
			imageToImageNNChanges: nnChanged,
			imageToImageNNChangeRate: ids.length ? nnChanged / ids.length : null,
			note: "image-to-image NN is diagnostic only (plan §5.3)",
		},
	};

	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
	console.log(`[parity] min cosine  = ${minCos.toFixed(6)}`);
	console.log(`[parity] median      = ${medCos.toFixed(6)}`);
	console.log(`[parity] p05         = ${p05.toFixed(6)}`);
	console.log(`[parity] G1a pass    = ${g1aPass} (kill=${g1aKill})`);
	console.log(`[parity] G1b top5    = ${top5RetainedAll}`);
	console.log(`[parity] G1b top10   = ${top10IdenticalAll}`);
	console.log(`[parity] max scoreΔ  = ${maxScoreDelta.toFixed(6)}`);
	console.log(`[parity] NN changes  = ${nnChanged}/${ids.length}`);
	console.log(`[parity] report → ${reportPath}`);

	// Flag any score deltas outside the predeclared band
	const outside = retrieval.flatMap((r) =>
		r.scoreDeltas.filter((d) => d.native !== null && !d.inTieBand).map((d) => ({
			query: r.query,
			...d,
		})),
	);
	if (outside.length) {
		console.log(`[parity] score deltas outside tie band: ${outside.length}`);
		for (const o of outside.slice(0, 12)) {
			console.log(
				`  ${o.query} / ${o.filename}: cpu=${o.cpu.toFixed(4)} nat=${o.native.toFixed(4)} Δ=${(o.cpu - o.native).toFixed(4)}`,
			);
		}
	}

	if (g1aKill) {
		console.log("[parity] KILL: G1a < 0.99 — stop before sidecar");
		process.exit(20);
	}
	if (!g1aPass) {
		console.log(
			"[parity] G1a in 0.99–0.995 band: one fp32 diagnostic allowed; no full-fp32 ANE pass",
		);
	}
	if (!g1bPass) {
		console.log("[parity] G1b FAIL: retrieval parity not met");
		process.exit(21);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
