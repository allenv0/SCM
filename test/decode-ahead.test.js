"use strict";

// Decode-ahead (plan 0.2) scheduling contract for enrichVideo's segment loop.
// Extracts the pipeline invariants without spawning ffmpeg or loading CLIP:
//   - segment 0's extract starts before the loop
//   - after a successful frame await, N+1's extract starts BEFORE the CLIP
//     phase of N (so seek N+1 overlaps CLIP N)
//   - a failed extract leaves pendingExtract null → next iteration starts
//     its own extract (never awaits a stale promise for the wrong gi)
//   - at most one ahead-of-cursor extract is in flight (2-deep, not unbounded)
//
// Run: node test/decode-ahead.test.js

const assert = require("node:assert/strict");

// Minimal reimplementation of the scheduling shape in enrichVideo
// (indexer/indexer.js) with instrumented beginExtract / clip markers.
function runPipeline(n, { failExtractAt = new Set() } = {}) {
	const events = [];
	let pendingExtract = null;
	let inflightSeeks = 0;
	let maxInflightSeeks = 0;

	const beginExtract = (gi, t) => {
		events.push({ type: "seek:start", gi, t });
		inflightSeeks++;
		maxInflightSeeks = Math.max(maxInflightSeeks, inflightSeeks);
		const shouldFail = failExtractAt.has(gi);
		const promise = new Promise((resolve, reject) => {
			setImmediate(() => {
				inflightSeeks--;
				if (shouldFail) reject(new Error(`extract fail ${gi}`));
				else resolve(`frame-${gi}`);
			});
		});
		promise.catch(() => {});
		return promise;
	};

	// Seed like enrichVideo does.
	pendingExtract = beginExtract(0, 0);

	return (async () => {
		const succeeded = [];
		const skipped = [];
		for (let j = 0; j < n; j++) {
			const gi = j;
			try {
				let extracting = pendingExtract;
				pendingExtract = null;
				if (!extracting) {
					extracting = beginExtract(gi, gi);
				}
				const frame = await extracting;
				events.push({ type: "frame:ready", gi, frame });
				// Decode-ahead: start N+1 before CLIP N.
				if (j + 1 < n) {
					pendingExtract = beginExtract(gi + 1, gi + 1);
				}
				events.push({ type: "clip:start", gi });
				// CLIP work (async tick so overlapping seek can run).
				await new Promise((r) => setImmediate(r));
				events.push({ type: "clip:end", gi });
				succeeded.push(gi);
			} catch (err) {
				events.push({ type: "segment:skip", gi, error: err.message });
				skipped.push(gi);
			}
		}
		if (pendingExtract) {
			try {
				await pendingExtract;
			} catch {
				/* drained */
			}
		}
		return { succeeded, skipped, events, maxInflightSeeks };
	})();
}

async function main() {
	// 1. Happy path: every clip:start for i is preceded by seek:start for i+1.
	{
		const r = await runPipeline(4);
		assert.deepEqual(r.succeeded, [0, 1, 2, 3]);
		assert.deepEqual(r.skipped, []);
		const order = r.events.map((e) => `${e.type}:${e.gi}`);
		for (let i = 0; i < 3; i++) {
			const clip = order.indexOf(`clip:start:${i}`);
			const nextSeek = order.indexOf(`seek:start:${i + 1}`);
			assert.ok(clip >= 0 && nextSeek >= 0, `missing events for ${i}`);
			assert.ok(
				nextSeek < clip,
				`seek ${i + 1} must start before clip ${i} (got seek@${nextSeek} clip@${clip})`,
			);
		}
		// 2-deep: seed seek0 + at most one ahead seek concurrent with a clip.
		// max concurrent seeks is 2 only if seed hasn't finished — bound it.
		assert.ok(
			r.maxInflightSeeks <= 2,
			`expected ≤2 concurrent seeks, got ${r.maxInflightSeeks}`,
		);
	}

	// 2. Mid-chunk extract failure: skip that segment, continue, no stale await.
	{
		const r = await runPipeline(5, { failExtractAt: new Set([2]) });
		assert.deepEqual(r.succeeded, [0, 1, 3, 4]);
		assert.deepEqual(r.skipped, [2]);
		// After skip of 2, segment 3 must still start its own seek (not await 2's).
		const seek3 = r.events.find((e) => e.type === "seek:start" && e.gi === 3);
		const frame3 = r.events.find((e) => e.type === "frame:ready" && e.gi === 3);
		assert.ok(seek3, "segment 3 must extract after neighbor failure");
		assert.ok(frame3, "segment 3 must produce a frame");
	}

	// 3. First extract failure: still processes 1..n-1.
	{
		const r = await runPipeline(3, { failExtractAt: new Set([0]) });
		assert.deepEqual(r.succeeded, [1, 2]);
		assert.deepEqual(r.skipped, [0]);
	}

	console.log("ok - decode-ahead schedule");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
