"use strict";

// Pure helpers for the transcript sidecar store (main.js pumpTranscription).
// Mirrors indexer/segment-store-utils.js file-for-file so every guarantee
// transfers: chunked commits accumulate (never replace), offsets land inside
// the bin, timeouts bound worst-case chunks, truncation is detectable.
//
// A transcript chunk is one {t0, t1, off, n, text} row — n is always 1 (one
// embedding per ~30 s speech window). text is capped by the worker (~240
// chars) for tooltip snippets; ranking uses the embedding row only.
//
// These functions are free of fs/Electron so the contract is pinned by a
// seconds-fast unit test (test/pump-transcription.test.js) instead of an
// Electron smoke.

const TRANSCRIPT_ROW_PER = 1;

// Each transcribe-video call embeds at most this many chunks
// (transcribe-worker.js); a long film spans multiple calls. Centralized here
// so main.js, the worker, and the unit tests share one value.
const TRANSCRIPTS_PER_CHUNK = 16;

// Never-stall timeouts (mirror ENRICH_* in segment-store-utils.js).
// A 16-chunk transcription slice does 16 wav slices + 16 whisper decodes +
// 16 text embeds: the chunk ceiling covers a worst-case-but-alive chunk; the
// stall interval is the longest silence (no transcribe-progress heartbeat)
// tolerated before the worker is considered wedged and restarted.
//
// Whisper model ladder (English-only `.en` line — the library is English, so
// multilingual capacity is pure cost). Timings are sized per model: base.en
// decodes ~2x slower than tiny.en on M1 CPU, so its ceilings scale up.
// small.en (244M, ~1GB fp32) was removed: it OOM-crashed the transcribe
// worker on 8GB Macs on every file (exit code 5, load-phase) — see
// MDs/archive/Whisper-Memory-Fix-Plan.md. large-v3 was evaluated and rejected (GBs
// of download vs the 3GB budget, ~4GB+ peak RAM on base 8GB M1, weeks of
// background CPU for a 30-film library) — see MDs/archive/Dialogue-Exact-Search-Plan.md §2.
const WHISPER_MODELS = {
	"tiny.en": {
		hfId: "Xenova/whisper-tiny.en",
		paramsM: 39,
		downloadMB: 150,
		speedVsTiny: 1,
	},
	"base.en": {
		hfId: "Xenova/whisper-base.en",
		paramsM: 74,
		downloadMB: 300,
		speedVsTiny: 2,
	},
};
const DEFAULT_WHISPER_MODEL = "tiny.en";
const TRANSCRIBE_CHUNK_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIBE_HEARTBEAT_INTERVAL_MS = 15000;
const TRANSCRIBE_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const TRANSCRIBE_MAX_RETRIES = 3;
// Load-phase crashes (worker dies before its first transcribe-phase tick —
// model download/ONNX load, never a slice decode) are systematic, not
// transient: re-loading the same weights 4× just burns minutes. Bound them
// to a single retry; decode-phase failures keep the full budget.
const TRANSCRIBE_LOAD_MAX_RETRIES = 1;

// Validated whisper-model parse (mirror parseVideoQuality): unknown →
// default, so a hand-edited settings.json can never break the queue.
// Legacy alias: "small.en" was removed (OOM on 8GB) — stored values and
// sidecar stamps carrying it resolve to "base.en" (closest surviving rung),
// so existing small.en users migrate with a single re-transcribe instead of
// silently dropping to tiny.
function parseWhisperModel(raw) {
	if (raw === "small.en") return "base.en";
	return raw && Object.prototype.hasOwnProperty.call(WHISPER_MODELS, raw)
		? raw
		: DEFAULT_WHISPER_MODEL;
}

// Per-model never-stall ceilings: decode time scales with params, so the
// chunk + stall timeouts scale with the model's measured slowdown vs tiny.
// Heartbeat interval is model-independent (progress ticks per slice).
function transcribeTimeoutsFor(model) {
	const m =
		WHISPER_MODELS[parseWhisperModel(model)] ||
		WHISPER_MODELS[DEFAULT_WHISPER_MODEL];
	return {
		chunkTimeoutMs: TRANSCRIBE_CHUNK_TIMEOUT_MS * m.speedVsTiny,
		heartbeatIntervalMs: TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
		stallTimeoutMs: TRANSCRIBE_STALL_TIMEOUT_MS * m.speedVsTiny,
		maxRetries: TRANSCRIBE_MAX_RETRIES,
	};
}

// Human-readable label for a utilityProcess exit: code and/or signal, with
// an OOM hint for SIGKILL (the kernel/OOM-killer signature on 8 GB Macs —
// the prime suspect when a Whisper worker dies during fp32 weight load).
// Pure + unit-tested; main.js uses it so `Transcribe worker exited` is never
// the whole story again.
function transcribeExitLabel(code, signal) {
	if (signal) {
		const hint =
			signal === "SIGKILL"
				? " (likely OOM-killed — check memory pressure + model cache size)"
				: "";
		return `exit signal ${signal}${hint}`;
	}
	if (Number.isInteger(code)) return `exit code ${code}`;
	return "exited (no code/signal reported)";
}

// Compact failure context for pumpTranscription retry/drop lines: model,
// load-vs-decode phase, exit cause, and heartbeat silence. Every field is
// optional — missing pieces render as `unknown` rather than throwing, so
// logging can never fail the pump. Pure + unit-tested.
function transcribeFailureLabel(opts = {}) {
	const model =
		typeof opts.model === "string" && opts.model ? opts.model : "unknown model";
	const phase =
		opts.phase === "load" || opts.phase === "decode"
			? opts.phase
			: "unknown phase";
	const exit =
		opts.code !== undefined || opts.signal
			? transcribeExitLabel(opts.code, opts.signal)
			: null;
	const hb =
		Number.isFinite(opts.heartbeatAgeMs) && opts.heartbeatAgeMs >= 0
			? `heartbeat ${Math.round(opts.heartbeatAgeMs / 1000)}s ago`
			: "no heartbeat yet";
	const parts = [`model ${model}`, `phase ${phase}`];
	if (exit) parts.push(exit);
	parts.push(hb);
	return parts.join(", ");
}

// Load-phase crash test: the worker died before any transcribe-phase tick
// for this job (model download/ONNX load — systematic), as opposed to dying
// mid-decode (possibly a single bad slice — transient). `hadProgress` is
// whether a transcribe-phase tick for THIS job was ever observed;
// `phase` is the last matching tick's phase ("model"/"transcribe"/null).
// Pure + unit-tested; main.js bounds load-phase retries to 1.
function isLoadPhaseCrash(opts = {}) {
	if (opts.hadProgress) return false;
	return opts.phase !== "transcribe";
}

// Speech-window grouping defaults: ~30 s windows with 5 s overlap,
// sentence-safe (never split mid-sentence; carry remainder). Cheap to store
// (2 hr film ≈ 240 chunks max), so no preset-scaled budget like segments.
const TRANSCRIPT_TARGET_SECONDS = 30;
const TRANSCRIPT_OVERLAP_SECONDS = 5;
const TRANSCRIPT_MAX_CHARS = 240;

// A chunk worth indexing: at least 8 chars with 2 real words. Filters
// whisper music-hallucination loops ("thank you thank you…") that pass
// length but carry no searchable content. Pure + unit-tested.
function isRealTranscriptText(text) {
	const clean = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length < 8) return false;
	const words = clean.split(/[^a-zA-Z0-9']+/).filter(Boolean);
	if (words.length < 2) return false;
	// Collapse exact-repeat loops: more than 4 identical adjacent words is
	// a decode loop, not speech.
	let repeats = 0;
	for (let i = 1; i < words.length; i++) {
		if (words[i].toLowerCase() === words[i - 1].toLowerCase()) repeats++;
		else repeats = 0;
		if (repeats >= 4) return false;
	}
	// Collapse short-phrase loops ("thank you thank you …", music-bed
	// hallucinations): ≤2 unique words across ≥6 words is a loop.
	if (words.length >= 6) {
		const uniq = new Set(words.map((w) => w.toLowerCase()));
		if (uniq.size <= 2) return false;
	}
	return true;
}

function cleanTranscriptText(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, TRANSCRIPT_MAX_CHARS);
}

// Group whisper utterances [{t0, t1, text}] into ~30 s search windows.
// Pure + deterministic: sorts by t0, drops non-finite/empty, groups until
// target seconds reached then extends to sentence end, overlaps by 5 s via
// time (not utterance count) so long silences don't glue distant speech.
// Returns [{t0, t1, text}] with text cleaned + capped. Empty input → [].
function buildTranscriptChunks(utterances, opts = {}) {
	const target = Number(opts.targetSeconds) || TRANSCRIPT_TARGET_SECONDS;
	const overlap = Number(opts.overlapSeconds ?? TRANSCRIPT_OVERLAP_SECONDS);
	const list = (Array.isArray(utterances) ? utterances : [])
		.filter(
			(u) =>
				u &&
				Number.isFinite(u.t0) &&
				Number.isFinite(u.t1) &&
				u.t1 > u.t0 &&
				typeof u.text === "string" &&
				u.text.trim().length > 0,
		)
		.map((u) => ({ t0: u.t0, t1: u.t1, text: u.text.trim() }))
		.sort((a, b) => a.t0 - b.t0);
	if (list.length === 0) return [];
	const chunks = [];
	let i = 0;
	while (i < list.length) {
		const start = list[i].t0;
		const windowEnd = start + target;
		let j = i;
		let end = list[i].t1;
		// Extend to sentence end past the target: include utterances whose
		// start falls inside the window, plus one more if the last included
		// text does not end with sentence punctuation.
		while (j < list.length && list[j].t0 < windowEnd) {
			end = Math.max(end, list[j].t1);
			j++;
		}
		if (j < list.length && j > i) {
			const joined = list
				.slice(i, j)
				.map((u) => u.text)
				.join(" ");
			if (!/[.!?]$/.test(joined.trim()) && list[j].t0 - end < 8) {
				end = Math.max(end, list[j].t1);
				j++;
			}
		}
		if (j === i) j = i + 1;
		const text = cleanTranscriptText(
			list
				.slice(i, j)
				.map((u) => u.text)
				.join(" "),
		);
		if (isRealTranscriptText(text)) {
			chunks.push({ t0: start, t1: end, text });
		}
		// Overlap: when the window reached the target length, the next
		// window starts at the first utterance ending after (end - overlap)
		// so boundary speech is searchable from both sides. When speech is
		// sparse (window shorter than target) advance past the window —
		// overlapping a 2-utterance film would only duplicate rows.
		let next = j;
		if (end - start >= target) {
			const overlapFrom = end - overlap;
			for (let k = i + 1; k < j; k++) {
				if (list[k].t1 > overlapFrom) {
					next = k;
					break;
				}
			}
		}
		i = Math.max(next, i + 1);
	}
	// Collapse exact-duplicate adjacent chunks (whisper repeat loops
	// surviving the word filter at chunk scale).
	return chunks.filter((c, idx, arr) => {
		if (idx === 0) return true;
		return c.text.toLowerCase() !== arr[idx - 1].text.toLowerCase();
	});
}

// Turn one reply chunk into sidecar rows stamped with the bin offsets where
// their embedding rows were (or will be) appended, then append them to the
// file's accumulated chunk list. Mirrors mergeChunkSegments exactly:
// ACCUMULATES — replacing the entry with only the current chunk used to
// leave just the last chunk's segments in the visual sidecar.
function mergeChunkTranscripts(existing, chunkChunks, base, rowPer) {
	if (!Array.isArray(existing)) {
		throw new TypeError("existing must be an array");
	}
	if (!Array.isArray(chunkChunks)) {
		throw new TypeError("chunkChunks must be an array");
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new TypeError(
			"base must be a non-negative integer (row count before this chunk)",
		);
	}
	if (!Number.isInteger(rowPer) || rowPer < 1) {
		throw new TypeError("rowPer must be a positive integer");
	}
	const records = chunkChunks.map((c, i) => ({
		t0: c.t0,
		t1: c.t1,
		off: base + i,
		n: rowPer,
		text: cleanTranscriptText(c.text),
	}));
	return [...existing, ...records];
}

// Split one transcribe-video reply chunk into successful rows vs skipped.
// Worker returns parallel arrays (chunks[i] ↔ vecs[i], null = skipped) so
// fromIndex still advances past failures. Mirrors partitionChunkReply.
function partitionTranscriptReply(chunks, vecs) {
	const cs = Array.isArray(chunks) ? chunks : [];
	const vs = Array.isArray(vecs) ? vecs : [];
	const okChunks = [];
	const okVecs = [];
	let skipped = 0;
	for (let i = 0; i < cs.length; i++) {
		const c = cs[i];
		const vec = i < vs.length ? vs[i] : null;
		if (c && c.skipped) {
			skipped++;
			continue;
		}
		if (
			!c ||
			!Number.isFinite(c.t0) ||
			!Number.isFinite(c.t1) ||
			c.t1 <= c.t0
		) {
			skipped++;
			continue;
		}
		if (!Array.isArray(vec) || vec.length === 0) {
			skipped++;
			continue;
		}
		if (!isRealTranscriptText(c.text)) {
			skipped++;
			continue;
		}
		okChunks.push({ t0: c.t0, t1: c.t1, text: cleanTranscriptText(c.text) });
		okVecs.push(vec);
	}
	return { okChunks, okVecs, skipped };
}

// Heuristic detection of truncated transcript sidecars (mirror of
// suspectedTruncated): multi-chunk plan, fewer survived than planned, tail
// cluster. Duration estimated from sidecar alone (last t1), no ffmpeg probe.
function suspectedTruncatedTranscripts(
	videos,
	chunkSize = TRANSCRIPTS_PER_CHUNK,
) {
	const flagged = [];
	if (!(videos instanceof Map)) return flagged;
	for (const [filename, chunks] of videos) {
		if (!Array.isArray(chunks) || chunks.length === 0) continue;
		let first = chunks[0].t0;
		let last = chunks[0].t1;
		for (const c of chunks) {
			if (c.t0 < first) first = c.t0;
			if (c.t1 > last) last = c.t1;
		}
		const duration = last;
		if (!(duration > 0)) continue;
		const planned = Math.ceil(duration / TRANSCRIPT_TARGET_SECONDS);
		if (planned <= chunkSize) continue;
		if (chunks.length >= planned) continue;
		if (last - first < duration * 0.5) {
			flagged.push({ filename, planned, actual: chunks.length, duration });
		}
	}
	return flagged;
}

// Fusion weights / bucketing / caps (mirror main.js rankers).
// Kept here so the fusion contract is unit-testable without Electron.
const FUSION_W_VISUAL = 0.4;
const FUSION_W_TEXT = 0.6;
const FUSION_SLOT_SECONDS = 5;
const FUSION_SCENES_PER_VIDEO = 3;
const FUSION_NOISE_FRACTION = 0.25;
const FUSION_NOISE_MIN_TOTAL = 20;
// The visual-only fraction gate below is statistically meaningless on a
// tiny corpus — with a handful of segments each one is ~10% and any
// two-shot video trips it, so small libraries get "no scene match" for
// genuine queries. Below this many visual rows the gate stands down (the
// ranking cutoff still applies). The text side keeps its strict gate at
// every size: transcript matching discriminates on small corpora and the
// dialogue honesty tests pin gibberish → [] there. Movie-heavy libraries,
// where the visual gate matters, always clear the minimum.
// Ordering-only literal boost for dialogue (mirrors RANK_OCR_WORD_BOOST):
// a query token literally spoken in the chunk lifts that moment to the
// front AFTER the cutoff — it reorders but can never shrink the set.
// 0.5 dominates the fused spread (~0.2) for full matches.
const DIALOGUE_LITERAL_BOOST = 0.5;

// Fraction of query tokens literally present in a transcript chunk (0..1).
// Whole-word match, plus inflection-tolerant prefix match in BOTH directions
// ("love" ↔ "loves"/"loving"/"loved") for tokens of length ≥ 3 — short
// tokens stay exact-only ("ai" must not match "air"). Case-insensitive,
// punctuation-stripped, query deduped. Pure + unit-tested.
function literalFraction(query, text) {
	const qTokens = [
		...new Set(
			String(query || "")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length >= 2),
		),
	];
	if (qTokens.length === 0) return 0;
	const words = new Set(
		String(text || "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 2),
	);
	if (words.size === 0) return 0;
	let hits = 0;
	for (const tok of qTokens) {
		let found = words.has(tok);
		if (!found && tok.length >= 3) {
			for (const w of words) {
				if (w.length >= 3 && (w.startsWith(tok) || tok.startsWith(w))) {
					found = true;
					break;
				}
			}
		}
		if (found) hits++;
	}
	return hits / qTokens.length;
}

// Fuse pre-scored visual + transcript hits into ranked moments.
// Pure + deterministic (no embeddings, no fs, no Electron).
//
// visualHits: [{filename, t, dur, poster, score}] (already ≥ minScore)
// textHits:   [{filename, t, dur, snippet, score}] (already ≥ minScore)
// segVideos:  Map(filename → [{t, poster}]) for text-only poster backfill
//             (null/undefined = skip backfill, poster stays 0).
// visualTotal / textTotal: total rows scored per side (for noise gates).
// Returns [{filename, score, t, dur, poster, why, snippet}] sorted desc,
// capped per-video + topK, cut at max(minScore, top*relativeKeep).
// Gibberish floods (both sides hot everywhere) → [].
function fuseVisualTextMoments({
	visualHits = [],
	textHits = [],
	segVideos = null,
	visualTotal = 0,
	textTotal = 0,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	wVisual = FUSION_W_VISUAL,
	wText = FUSION_W_TEXT,
	slotSeconds = FUSION_SLOT_SECONDS,
	scenesPerVideo = FUSION_SCENES_PER_VIDEO,
	noiseFraction = FUSION_NOISE_FRACTION,
} = {}) {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const slot = Math.max(1, Number(slotSeconds) || FUSION_SLOT_SECONDS);
	const vHits = Array.isArray(visualHits) ? visualHits : [];
	const tHits = Array.isArray(textHits) ? textHits : [];
	if (vHits.length === 0 && tHits.length === 0) return [];
	const slots = new Map();
	const slotKey = (filename, t) => `${filename}::${Math.floor(t / slot)}`;
	for (const h of vHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: Number.isFinite(h.poster) ? h.poster : 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		if (h.score > s.visual) {
			s.visual = h.score;
			s.t = h.t;
			s.poster = Number.isFinite(h.poster) ? h.poster : s.poster;
			if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
		}
	}
	for (const h of tHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		const lit =
			Number.isFinite(h.literal) && h.literal > 0 ? Math.min(1, h.literal) : 0;
		if (h.score > s.text) {
			s.text = h.score;
			s.literal = lit;
			if (!s.snippet && typeof h.snippet === "string" && h.snippet.length > 0)
				s.snippet = h.snippet;
			if (s.visual === 0) {
				s.t = h.t;
				if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
			}
		} else if (lit > s.literal) {
			s.literal = lit;
			if (
				!s.snippet &&
				typeof h.snippet === "string" &&
				h.snippet.length > 0 &&
				s.text > 0
			)
				s.snippet = h.snippet;
		} else if (
			!s.snippet &&
			typeof h.snippet === "string" &&
			h.snippet.length > 0 &&
			s.text > 0
		) {
			// Keep first snippet when a weaker text hit arrives second.
		}
	}
	// Text-only slots need a poster: nearest visual segment poster in the
	// same video (pure view concern; ranking unaffected).
	if (segVideos instanceof Map) {
		for (const s of slots.values()) {
			if (s.poster !== 0 && s.poster !== undefined) continue;
			const segs = segVideos.get(s.filename);
			if (!segs || segs.length === 0) {
				s.poster = 0;
				continue;
			}
			let best = segs[0];
			let bestD = Math.abs(segs[0].t - s.t);
			for (const sg of segs) {
				if (!Number.isFinite(sg.t)) continue;
				const d = Math.abs(sg.t - s.t);
				if (d < bestD) {
					bestD = d;
					best = sg;
				}
			}
			s.poster = Number.isFinite(best.poster) ? best.poster : 0;
		}
	}
	const fused = [...slots.values()].map((s) => ({
		...s,
		score: wVisual * s.visual + wText * s.text,
		why: s.visual > 0 && s.text > 0 ? "both" : s.text > 0 ? "text" : "visual",
	}));
	fused.sort((a, b) => b.score - a.score);
	if (fused.length === 0) return [];
	const cutoff = Math.max(minScore, fused[0].score * relativeKeep);
	// Literal spoken evidence IS discriminative evidence (the query's words
	// were literally uttered in that moment — same philosophy as the OCR
	// word boost and the scene-evidence gate): when any surviving candidate
	// carries it, the fraction gate stands down. Gibberish (zero literals
	// anywhere) still faces the gate and still returns [].
	const hasLiteralEvidence = fused.some(
		(f) => f.score >= cutoff && f.literal > 0,
	);
	const vTotal = Math.max(0, Number(visualTotal) || 0);
	const tTotal = Math.max(0, Number(textTotal) || 0);
	if (!hasLiteralEvidence) {
		if (vTotal > 0 && tTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (
				vAbove / Math.max(1, vTotal) > noiseFraction &&
				tAbove / Math.max(1, tTotal) > noiseFraction
			) {
				return [];
			}
		} else if (vTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			if (
				vTotal >= FUSION_NOISE_MIN_TOTAL &&
				vAbove / Math.max(1, vTotal) > noiseFraction
			)
				return [];
		} else if (tTotal > 0) {
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (tAbove / Math.max(1, tTotal) > noiseFraction) return [];
		}
	}
	const perVideo = new Map();
	const hits = [];
	for (const f of fused) {
		if (f.score < cutoff) break;
		const seen = perVideo.get(f.filename) ?? 0;
		if (seen >= scenesPerVideo) continue;
		perVideo.set(f.filename, seen + 1);
		hits.push({
			filename: f.filename,
			// Ordering-only literal boost, applied AFTER the cutoff (same
			// contract as RANK_OCR_WORD_BOOST): a literally-spoken moment
			// leads the grid but the boost can never shrink the set.
			// Zero for visual-only callers (no literal field) — their
			// scores are byte-identical to before.
			score: f.score + DIALOGUE_LITERAL_BOOST * (f.literal > 0 ? f.literal : 0),
			t: f.t,
			dur: f.dur,
			poster: f.poster,
			why: f.why,
			snippet: f.snippet,
		});
		if (hits.length >= k) break;
	}
	hits.sort((a, b) => b.score - a.score);
	return hits;
}

// Attach the centered query vector to a results array WITHOUT changing its
// shape (M-11 single round-trip). Structured clone preserves own props on
// arrays, so `Array.isArray()` stays true for every existing consumer (perf
// battery, search-matrix diagnostics, older renderers) while new callers
// read `.queryVec`. Non-array input → empty array (never throws).
function attachQueryVec(results, queryVec) {
	const out = Array.isArray(results) ? results : [];
	out.queryVec = queryVec || null;
	return out;
}

// Apply one transcribed+embedded reply chunk to the sidecar store — the exact
// commit path pumpTranscription runs in production, extracted pure so the
// accumulation contract is unit-testable without Electron:
//   videos — Map(filename → [{t0,t1,off,n,text}]) so far
//   rows   — Float32Array[] embedding rows so far
//   okChunks/okVecs — partitioned successes for THIS call only
// Returns { videos: Map(new), rows: new[] }. Offsets are stamped at
// rows.length BEFORE this chunk's rows are pushed (they must land inside
// the bin); the file's list ACCUMULATES (replacing it used to leave only
// the last drain's chunks — the truncation bug class).
function applyTranscriptReply(
	videos,
	rows,
	filename,
	okChunks,
	okVecs,
	rowPer,
) {
	if (!(videos instanceof Map)) throw new TypeError("videos must be a Map");
	if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
	if (!Array.isArray(okChunks) || !Array.isArray(okVecs)) {
		throw new TypeError("okChunks/okVecs must be arrays");
	}
	if (okChunks.length !== okVecs.length)
		throw new TypeError("chunks/vecs length mismatch");
	if (!Number.isInteger(rowPer) || rowPer < 1) {
		throw new TypeError("rowPer must be a positive integer");
	}
	const merged = mergeChunkTranscripts(
		videos.get(filename) || [],
		okChunks,
		rows.length,
		rowPer,
	);
	const nextVideos = new Map(videos);
	nextVideos.set(filename, merged);
	return {
		videos: nextVideos,
		rows: [...rows, ...okVecs.map((v) => new Float32Array(v))],
	};
}

// Repair candidates for the stub-era poisoning (main.js
// repairUntranscribedWithAudio): video entries recorded with ZERO chunks
// before the whisper engine existed. Empty is ambiguous (silent vs never
// attempted), so the caller probes each candidate for an audio stream and
// drops only those WITH audio — silent films keep their legitimate empty.
// Pure: returns [filename] with zero chunks, in map order.
function repairCandidates(videos) {
	if (!(videos instanceof Map)) return [];
	const out = [];
	for (const [filename, chunks] of videos) {
		if (Array.isArray(chunks) && chunks.length === 0) out.push(filename);
	}
	return out;
}

// Compact a transcript store back to 1:1 rows↔records (self-heal for orphan
// rows / gapped offsets from pre-fix writers): rebuilds rows from records
// in (video, chunk) order and restamps off contiguously. Returns
// { videos, rows, dropped } — dropped is the orphan count (0 = already
// clean; caller skips the save then). Pure; never throws on malformed
// input (bad records are dropped like loadTranscripts does).
function compactTranscriptStore(videos, rows) {
	const inVideos = videos instanceof Map ? videos : new Map();
	const inRows = Array.isArray(rows) ? rows : [];
	const outVideos = new Map();
	const outRows = [];
	let off = 0;
	for (const [filename, chunks] of inVideos) {
		if (!Array.isArray(chunks)) {
			outVideos.set(filename, []);
			continue;
		}
		const kept = [];
		for (const c of chunks) {
			const row =
				c && Number.isInteger(c.off) && c.off >= 0 && c.off < inRows.length
					? inRows[c.off]
					: null;
			if (
				!row ||
				!Number.isFinite(c.t0) ||
				!Number.isFinite(c.t1) ||
				c.t1 <= c.t0
			)
				continue;
			kept.push({
				t0: c.t0,
				t1: c.t1,
				off: off++,
				n: 1,
				text: String(c.text || ""),
			});
			outRows.push(row);
		}
		outVideos.set(filename, kept);
	}
	return {
		videos: outVideos,
		rows: outRows,
		dropped: inRows.length - outRows.length,
	};
}

function cosineVec(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Rank dialogue moments from pre-embedded items — the exact scoring
// main.js rankTranscriptMoments runs, extracted pure so the full ranking
// (cosine → literal → fuse → boost → gate → caps) is unit-testable with
// REAL tower vectors and no Electron:
//   qVec  — centered query vector (Float32Array)
//   items — [{filename, t0, t1, text, vec}] (vecs centered, same dim)
//   query — raw query text (for literalFraction)
// Returns fuseVisualTextMoments hits (text-only). Throws TypeError on bad
// shapes (never silent wrong answers).
function rankDialogueMoments({
	qVec,
	items = [],
	segVideos = null,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	query = "",
} = {}) {
	if (!qVec || typeof qVec.length !== "number" || qVec.length === 0) {
		throw new TypeError("qVec must be a non-empty vector");
	}
	if (!Array.isArray(items)) throw new TypeError("items must be an array");
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const textHits = [];
	for (const it of items) {
		if (
			!it ||
			typeof it.filename !== "string" ||
			!(it.vec && it.vec.length === qVec.length)
		)
			continue;
		if (!Number.isFinite(it.t0) || !Number.isFinite(it.t1) || it.t1 <= it.t0)
			continue;
		if (typeof it.text !== "string" || it.text.trim().length === 0) continue;
		const sc = cosineVec(qVec, it.vec);
		if (sc >= minScore) {
			const mid = (it.t0 + it.t1) / 2;
			textHits.push({
				filename: it.filename,
				t: mid,
				dur: Math.max(0.5, it.t1 - it.t0),
				snippet: it.text.slice(0, 80) || null,
				literal: literalFraction(query, it.text),
				score: sc,
			});
		}
	}
	textHits.sort((a, b) => b.score - a.score);
	if (textHits.length > k * 8) textHits.length = k * 8;
	if (textHits.length === 0) return [];
	return fuseVisualTextMoments({
		visualHits: [],
		textHits,
		segVideos,
		visualTotal: 0,
		textTotal: items.length,
		minScore,
		relativeKeep,
		topK: k,
		wVisual: FUSION_W_VISUAL,
		wText: FUSION_W_TEXT,
		slotSeconds: FUSION_SLOT_SECONDS,
		scenesPerVideo: FUSION_SCENES_PER_VIDEO,
		noiseFraction: FUSION_NOISE_FRACTION,
	});
}

// ---------------------------------------------------------------------------
// Exact dialogue search (v3): literal spoken-word retrieval — no vectors, no
// thresholds, no model. The query's normalized+stemmed tokens must actually
// occur in the transcript; tiers rank phrase > proximity > scattered-AND.
// Pure + deterministic; main.js rankTranscriptMoments calls it with utterance
// lines when present (precise seek) else chunk rows (coarse seek).
// ---------------------------------------------------------------------------

// Comparison key for one raw token: NFKD fold → lowercase → stem → trailing-e
// fold (len≥4). The e-fold merges inflection pairs Porter splits
// ("love"/"loving" → "lov") while keeping distinct roots apart
// ("car" vs "carpet" never merge — neither gains/loses a trailing e to meet).
// Returns "" for noise (len<2 after cleaning).
function dialogueKey(raw) {
	const clean = String(raw || "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (clean.length < 2) return "";
	let stem = /^[a-z]+$/.test(clean) ? porterStem(clean) : clean;
	// Porter wart fix: "flies"→"fli" but "flying"/"fly"→"fly", so inflections
	// of the same word land on different keys. Folding a trailing i→y
	// (len≥3) reunites them (fli→fly) and also city/cities, ski/sky.
	if (stem.length >= 3 && stem.endsWith("i")) stem = stem.slice(0, -1) + "y";
	if (stem.length >= 4 && stem.endsWith("e")) return stem.slice(0, -1);
	return stem;
}

// Tokenize text into [{raw, key, start, end}] in order (raw offsets into the
// original string for snippet highlighting). Punctuation/diacritics folded by
// dialogueKey; noise tokens dropped.
function dialogueTokens(text) {
	const src = String(text || "");
	const out = [];
	const re = /[A-Za-z0-9\u00c0-\u024f]+/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		const key = dialogueKey(m[0]);
		if (key)
			out.push({ raw: m[0], key, start: m.index, end: m.index + m[0].length });
	}
	return out;
}

// Compact Porter stemmer (steps 1a–5, deterministic, ASCII a-z only).
// Vendored (~no dep) so index-time and query-time stemming are byte-identical.
function porterStem(w) {
	if (w.length < 3) return w;
	const isCons = (s, i) => {
		const c = s[i];
		if ("aeiou".includes(c)) return false;
		if (c === "y") return i === 0 ? true : !isCons(s, i - 1);
		return true;
	};
	const measure = (s) => {
		let m = 0;
		let i = 0;
		while (i < s.length && isCons(s, i)) i++;
		while (i < s.length) {
			while (i < s.length && !isCons(s, i)) i++;
			if (i >= s.length) break;
			m++;
			while (i < s.length && isCons(s, i)) i++;
		}
		return m;
	};
	const hasVowel = (s) => [...s].some((_, i) => !isCons(s, i));
	const endsDouble = (s) =>
		s.length >= 2 &&
		s[s.length - 1] === s[s.length - 2] &&
		isCons(s, s.length - 1);
	const cvc = (s) =>
		s.length >= 3 &&
		isCons(s, s.length - 3) &&
		!isCons(s, s.length - 2) &&
		isCons(s, s.length - 1) &&
		!"wxy".includes(s[s.length - 1]);
	let s = w;
	// Step 1a
	if (s.endsWith("sses")) s = s.slice(0, -2);
	else if (s.endsWith("ies")) s = s.slice(0, -2);
	else if (s.endsWith("ss")) {
		/* keep */
	} else if (s.endsWith("s")) s = s.slice(0, -1);
	// Step 1b
	let flag1b = false;
	if (s.endsWith("eed")) {
		if (measure(s.slice(0, -3)) > 0) s = s.slice(0, -1);
	} else if (s.endsWith("ed") && hasVowel(s.slice(0, -2))) {
		s = s.slice(0, -2);
		flag1b = true;
	} else if (s.endsWith("ing") && hasVowel(s.slice(0, -3))) {
		s = s.slice(0, -3);
		flag1b = true;
	}
	if (flag1b) {
		if (s.endsWith("at") || s.endsWith("bl") || s.endsWith("iz")) s += "e";
		else if (endsDouble(s) && !"lsz".includes(s[s.length - 1]))
			s = s.slice(0, -1);
		else if (measure(s) === 1 && cvc(s)) s += "e";
	}
	// Step 1c
	if (s.endsWith("y") && hasVowel(s.slice(0, -1))) s = s.slice(0, -1) + "i";
	// Step 2
	const step2 = {
		ational: "ate",
		tional: "tion",
		enci: "ence",
		anci: "ance",
		izer: "ize",
		bli: "ble",
		alli: "al",
		entli: "ent",
		eli: "e",
		ousli: "ous",
		ization: "ize",
		ation: "ate",
		ator: "ate",
		alism: "al",
		iveness: "ive",
		fulness: "ful",
		ousness: "ous",
		aliti: "al",
		iviti: "ive",
		biliti: "ble",
		logi: "log",
	};
	for (const [suf, rep] of Object.entries(step2)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 3
	const step3 = {
		icate: "ic",
		ative: "",
		alize: "al",
		iciti: "ic",
		ical: "ic",
		ful: "",
		ness: "",
	};
	for (const [suf, rep] of Object.entries(step3)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 4
	for (const suf of [
		"al",
		"ance",
		"ence",
		"er",
		"ic",
		"able",
		"ible",
		"ant",
		"ement",
		"ment",
		"ent",
		"ion",
		"ou",
		"ism",
		"ate",
		"iti",
		"ous",
		"ive",
		"ize",
	]) {
		if (!s.endsWith(suf)) continue;
		const base = s.slice(0, -suf.length);
		if (measure(base) <= 1) continue;
		if (suf === "ion" && !"st".includes(base[base.length - 1])) continue;
		s = base;
		break;
	}
	// Step 5a/5b
	if (s.endsWith("e")) {
		const base = s.slice(0, -1);
		const m = measure(base);
		if (m > 1 || (m === 1 && !cvc(base))) s = base;
	}
	if (endsDouble(s) && s.endsWith("l") && measure(s) > 1) s = s.slice(0, -1);
	return s;
}

// Nearest visual-segment poster for a speech moment (pure view concern —
// ranking unaffected). segVideos: Map(filename → [{t, poster}]).
function backfillPoster(segVideos, filename, t) {
	if (
		!(segVideos instanceof Map) ||
		typeof filename !== "string" ||
		!Number.isFinite(t)
	)
		return 0;
	const segs = segVideos.get(filename);
	if (!segs || segs.length === 0) return 0;
	let best = segs[0];
	let bestD = Number.isFinite(segs[0].t) ? Math.abs(segs[0].t - t) : Infinity;
	for (const sg of segs) {
		if (!Number.isFinite(sg.t)) continue;
		const d = Math.abs(sg.t - t);
		if (d < bestD) {
			bestD = d;
			best = sg;
		}
	}
	return Number.isFinite(best.poster) ? best.poster : 0;
}

const EXACT_TIER_LABELS = {
	1: "Exact line",
	2: "Exact words",
	3: "Words spoken",
};

// Exact dialogue search over pre-tokenized docs.
//   query — raw query text (normalized + stemmed here, same keys as docs)
//   docs  — [{filename, t0, t1, text}] (utterance lines preferred; chunks fallback)
//   segVideos — Map for poster backfill (null = poster 0)
//   topK / perVideo — caps (default 24 / 3, perVideo mirrors FUSION_SCENES_PER_VIDEO)
//   preRollSec — seek lands t0 − preRoll (clamped ≥ 0; default 3)
//   proximitySec — bag-of-words window for tier 2 (default 8)
//   snippetRadius — chars around first match (default 60)
// Tiers: 1 = contiguous key-phrase in one doc; 2 = all keys in one doc or a
// ≤proximitySec same-film window; 3 = all keys in one doc wider than the
// window (chunk fallback). 1–2 word queries require full containment (no
// fractional hits). Empty query or zero tiers → []. Throws TypeError when
// docs is not an array (never silent wrong answers).
function exactDialogueSearch({
	query = "",
	docs = [],
	segVideos = null,
	topK = 24,
	perVideo = 3,
	preRollSec = 3,
	proximitySec = 8,
	snippetRadius = 60,
} = {}) {
	if (!Array.isArray(docs)) throw new TypeError("docs must be an array");
	const qKeys = dialogueTokens(query).map((t) => t.key);
	if (qKeys.length === 0) return [];
	const qSet = new Set(qKeys);
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const perVid = Math.max(1, Math.min(24, Number(perVideo) || 3));
	const preRoll = Math.max(0, Number(preRollSec) || 0);
	const windowSec = Math.max(1, Number(proximitySec) || 8);
	const radius = Math.max(8, Number(snippetRadius) || 60);
	// Group valid docs per film, time-sorted, pre-tokenized once.
	const byFilm = new Map();
	for (const d of docs) {
		if (!d || typeof d.filename !== "string") continue;
		if (!Number.isFinite(d.t0) || !Number.isFinite(d.t1) || d.t1 <= d.t0)
			continue;
		if (typeof d.text !== "string" || d.text.trim().length === 0) continue;
		const toks = dialogueTokens(d.text);
		if (toks.length === 0) continue;
		if (!byFilm.has(d.filename)) byFilm.set(d.filename, []);
		byFilm.get(d.filename).push({
			t0: d.t0,
			t1: d.t1,
			text: d.text,
			toks,
			keys: toks.map((t) => t.key),
		});
	}
	for (const list of byFilm.values())
		list.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
	const containsAll = (keySet) => qKeys.every((qk) => keySet.has(qk));
	const hits = [];
	const phraseLen = qKeys.length;
	for (const [filename, list] of byFilm) {
		const keySets = list.map((d) => new Set(d.keys));
		// Tier 1: contiguous key-phrase inside one doc.
		const phraseDocs = new Set();
		for (let i = 0; i < list.length; i++) {
			const keys = list[i].keys;
			let at = -1;
			for (let s = 0; s + phraseLen <= keys.length; s++) {
				let ok = true;
				for (let p = 0; p < phraseLen; p++) {
					if (keys[s + p] !== qKeys[p]) {
						ok = false;
						break;
					}
				}
				if (ok) {
					at = s;
					break;
				}
			}
			if (at < 0) continue;
			phraseDocs.add(`${list[i].t0}:${list[i].t1}`);
			hits.push(
				makeExactHit({
					filename,
					tier: 1,
					docs: [list[i]],
					spanT0: list[i].t0,
					spanT1: list[i].t1,
					occ: phraseLen,
				}),
			);
		}
		// Tier 2/3: sliding minimal windows over consecutive docs. A single
		// doc that already scored tier 1 is subsumed (same evidence, better
		// tier) — only cross-doc windows add anything there.
		for (let i = 0; i < list.length; i++) {
			const union = new Set();
			for (let j = i; j < list.length; j++) {
				if (list[j].t0 - list[i].t0 > windowSec && j > i) break;
				for (const kk of keySets[j]) union.add(kk);
				if (!containsAll(union)) continue;
				if (j === i && phraseDocs.has(`${list[i].t0}:${list[i].t1}`)) break;
				const span = list[j].t1 - list[i].t0;
				const single = j === i;
				const tier = single && span > windowSec ? 3 : 2;
				let occ = 0;
				for (let m = i; m <= j; m++)
					for (const kk of list[m].keys) if (qSet.has(kk)) occ++;
				hits.push(
					makeExactHit({
						filename,
						tier,
						docs: list.slice(i, j + 1),
						spanT0: list[i].t0,
						spanT1: list[j].t1,
						occ,
					}),
				);
				break; // minimal window for this start
			}
		}
	}
	if (hits.length === 0) return [];
	// Deterministic order: tier, occurrences desc, span asc, time asc, name asc.
	hits.sort(
		(a, b) =>
			a.tier - b.tier ||
			b.occ - a.occ ||
			a.spanT1 - a.spanT0 - (b.spanT1 - b.spanT0) ||
			a.spanT0 - b.spanT0 ||
			(a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0),
	);
	// Dedupe identical (film, tier, anchor second) — overlapping windows can
	// re-anchor the same line.
	const seen = new Set();
	const out = [];
	const perVideoCount = new Map();
	for (const h of hits) {
		const anchorSec = Math.floor(h.spanT0);
		const dkey = `${h.filename}::${h.tier}::${anchorSec}`;
		if (seen.has(dkey)) continue;
		seen.add(dkey);
		const n = perVideoCount.get(h.filename) ?? 0;
		if (n >= perVid) continue;
		perVideoCount.set(h.filename, n + 1);
		const anchor = h.docs[0];
		const t = Math.max(0, anchor.t0 - preRoll);
		const dur = Math.max(0.5, h.spanT1 - h.spanT0);
		const snip = snippetAround(anchor.text, anchor.toks, qSet, radius);
		out.push({
			filename: h.filename,
			score:
				4 -
				h.tier +
				Math.min(h.occ, 8) * 0.01 -
				Math.min(h.spanT1 - h.spanT0, 300) * 0.0005,
			t,
			dur,
			poster: backfillPoster(segVideos, h.filename, (h.spanT0 + h.spanT1) / 2),
			why: "text",
			tier: h.tier,
			tierLabel: EXACT_TIER_LABELS[h.tier],
			snippet: snip.text,
			matchStart: snip.start,
			matchLen: snip.len,
		});
		if (out.length >= k) break;
	}
	out.sort((a, b) => b.score - a.score);
	return out;

	function makeExactHit(h) {
		return h;
	}
}

// Snippet around the first query-key occurrence in one doc's text:
// ±radius chars with … ellipsis; matchStart/matchLen locate the hit for UI
// highlight (0/0 when nothing found — never happens for real hits).
function snippetAround(text, toks, qSet, radius) {
	const src = String(text || "");
	let hit = null;
	for (const t of toks) {
		if (qSet.has(t.key)) {
			hit = t;
			break;
		}
	}
	if (!hit) return { text: src.slice(0, radius * 2), start: 0, len: 0 };
	const lo = Math.max(0, hit.start - radius);
	const hi = Math.min(src.length, hit.end + radius);
	let snippet = src.slice(lo, hi);
	if (lo > 0) snippet = "…" + snippet;
	if (hi < src.length) snippet = snippet + "…";
	return {
		text: snippet,
		start: hit.start - lo + (lo > 0 ? 1 : 0),
		len: hit.end - hit.start,
	};
}

// Backfill planner: which library videos need (re)transcription and from
// which slice offset. Pure (main maps filenames to {filename, path, off}):
//   filenames — library videos in order
//   videos    — sidecar Map(filename → chunks[])
//   progress  — sidecar progress map {filename: {done, total}}
// Missing entries → off 0. Entries with progress done<total (crash or
// drop mid-film) → resume at done. Complete entries (chunks present, no
// partial progress) → skipped. Never throws.
function transcribeBackfillList(filenames, videos, progress) {
	const names = Array.isArray(filenames) ? filenames : [];
	const vids = videos instanceof Map ? videos : new Map();
	const prog = progress && typeof progress === "object" ? progress : {};
	const out = [];
	for (const name of names) {
		if (typeof name !== "string" || !name) continue;
		if (!vids.has(name)) {
			out.push({ filename: name, off: 0 });
			continue;
		}
		const p = prog[name];
		if (
			p &&
			Number.isFinite(p.done) &&
			Number.isFinite(p.total) &&
			p.done >= 0 &&
			p.done < p.total
		) {
			out.push({ filename: name, off: Math.floor(p.done) });
		}
	}
	return out;
}

module.exports = {
	TRANSCRIPT_ROW_PER,
	TRANSCRIPTS_PER_CHUNK,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
	TRANSCRIBE_STALL_TIMEOUT_MS,
	TRANSCRIBE_MAX_RETRIES,
	TRANSCRIBE_LOAD_MAX_RETRIES,
	transcribeExitLabel,
	transcribeFailureLabel,
	isLoadPhaseCrash,
	WHISPER_MODELS,
	DEFAULT_WHISPER_MODEL,
	parseWhisperModel,
	transcribeTimeoutsFor,
	TRANSCRIPT_TARGET_SECONDS,
	TRANSCRIPT_OVERLAP_SECONDS,
	TRANSCRIPT_MAX_CHARS,
	FUSION_W_VISUAL,
	FUSION_W_TEXT,
	FUSION_SLOT_SECONDS,
	FUSION_SCENES_PER_VIDEO,
	FUSION_NOISE_FRACTION,
	FUSION_NOISE_MIN_TOTAL,
	DIALOGUE_LITERAL_BOOST,
	isRealTranscriptText,
	cleanTranscriptText,
	buildTranscriptChunks,
	mergeChunkTranscripts,
	partitionTranscriptReply,
	suspectedTruncatedTranscripts,
	fuseVisualTextMoments,
	attachQueryVec,
	applyTranscriptReply,
	repairCandidates,
	literalFraction,
	compactTranscriptStore,
	rankDialogueMoments,
	transcribeBackfillList,
	dialogueKey,
	dialogueTokens,
	porterStem,
	backfillPoster,
	exactDialogueSearch,
	EXACT_TIER_LABELS,
};
