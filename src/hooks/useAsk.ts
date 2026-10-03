import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AskEvidenceRow,
	AskResult,
	AskStats,
	LlmModelInfo,
} from "@/types";
import type { RankedMemory } from "@/lib/memoryRank";

export type { AskEvidenceRow, AskResult, AskStats, LlmModelInfo };

/** Live process readout while a question is in flight: retrieval numbers
 *  (from the evidence event), cold-start notice, and a throttled (~4Hz)
 *  live generation label. Sealed into result.stats on resolve — this is
 *  transitional only. */
export interface AskProgress {
	readonly stats: AskStats | null;
	readonly spawning: boolean;
	readonly modelLabel: string | null;
	readonly liveLabel: string | null;
}

/**
 * Ask mode state (MDs/Ask-Mode-Plan.md): one question in flight at a time,
 * the evidence-gated result, and the evidence → RankedMemory conversion the
 * grid renders. The LLMs toggle's visibility follows the LLM config (off by
 * default — the app is unchanged until Settings → LLMs Chat enables it).
 *
 * Sequence-guarded like the grid's search effect: a stale reply (the user
 * edited the query mid-request) can never clobber the newest state.
 * Streaming: each ask() mints a reqId echoed back on the ask-evidence /
 * ask-token events; `streamed` accumulates token deltas and `liveEvidence`
 * populates chips + grid before the invoke resolves.
 */
export function useAsk() {
	const [enabled, setEnabled] = useState(false);
	/** The active chat model behind the LLMs tab (label + size for the
	 *  model badge; refreshed on every llm status event, so a finished
	 *  download flips the badge live). */
	const [llmModel, setLlmModel] = useState<LlmModelInfo | null>(null);
	const [asking, setAsking] = useState(false);
	const [result, setResult] = useState<AskResult | null>(null);
	const [streamed, setStreamed] = useState<string | null>(null);
	const [liveEvidence, setLiveEvidence] = useState<AskEvidenceRow[] | null>(
		null,
	);
	const [progress, setProgress] = useState<AskProgress | null>(null);
	const askSeqRef = useRef(0);
	const reqRef = useRef(0);
	// Live-label throttle + stream counters (event context only — never
	// read during render, so the render-purity lint stays quiet).
	const streamCharsRef = useRef(0);
	const streamT0Ref = useRef<number | null>(null);
	const liveLabelAtRef = useRef(0);

	const refreshStatus = useCallback(async () => {
		try {
			const status = await window.memories.getLlmStatus();
			setEnabled(status.enabled === true);
			const active =
				status.models?.find((m) => m.id === status.chatModel) ?? null;
			setLlmModel(active);
		} catch {
			/* bridge optional — LLMs stay hidden */
		}
	}, []);

	// Config flips from Settings arrive as "llm" status events (set-config
	// broadcasts "idle · config-changed"; downloads land as "ready") — the
	// flag re-reads so the LLMs toggle appears without a restart. The
	// initial read mirrors useWhisperModel's cancelled-guard shape; the
	// event callback delegates to refreshStatus instead of calling
	// setState inline.
	useEffect(() => {
		let cancelled = false;
		void window.memories
			?.getLlmStatus?.()
			.then((s) => {
				if (cancelled) return;
				setEnabled(s?.enabled === true);
				setLlmModel(s?.models?.find((m) => m.id === s?.chatModel) ?? null);
			})
			.catch(() => {
				/* bridge optional — LLMs stay hidden */
			});
		const off = window.memories?.onStatus?.((payload) => {
			if (payload.type === "llm") {
				void refreshStatus();
			}
		});
		// Streaming LLMs events, matched by reqId so an abandoned flight's
		// late deltas can never append to the newest question.
		const offEvidence = window.memories?.onAskEvidence?.((payload) => {
			if (payload.reqId !== reqRef.current) return;
			setLiveEvidence(payload.evidence ?? []);
			streamCharsRef.current = 0;
			streamT0Ref.current = null;
			liveLabelAtRef.current = 0;
			setProgress({
				stats: payload.stats ?? null,
				spawning: false,
				modelLabel: null,
				liveLabel: null,
			});
		});
		const offToken = window.memories?.onAskToken?.((payload) => {
			if (payload.reqId !== reqRef.current || !payload.delta) return;
			setStreamed((prev) => (prev ?? "") + payload.delta);
			streamCharsRef.current += payload.delta.length;
			if (streamT0Ref.current === null) {
				streamT0Ref.current = Date.now();
			}
			// Throttled live label (~4Hz): per-token setStates would jitter
			// the tok/s number every frame.
			const now = Date.now();
			if (now - liveLabelAtRef.current >= 250) {
				liveLabelAtRef.current = now;
				const t0 = streamT0Ref.current;
				const secs = Math.max(0.1, (now - (t0 ?? now)) / 1000);
				const toks = Math.max(1, Math.round(streamCharsRef.current / 4));
				const label =
					t0 === null
						? "Answering…"
						: `Answering… ~${toks} tokens · ~${Math.round(toks / secs)} tok/s`;
				setProgress((prev) => (prev ? { ...prev, liveLabel: label } : prev));
			}
		});
		const offPhase = window.memories?.onAskPhase?.((payload) => {
			if (payload.reqId !== reqRef.current) return;
			if (payload.phase !== "spawning") return;
			setProgress((prev) =>
				prev
					? {
							...prev,
							spawning: true,
							modelLabel: payload.modelLabel ?? prev.modelLabel,
						}
					: {
							stats: null,
							spawning: true,
							modelLabel: payload.modelLabel ?? null,
							liveLabel: null,
						},
			);
		});
		return () => {
			cancelled = true;
			off?.();
			offEvidence?.();
			offToken?.();
			offPhase?.();
		};
	}, [refreshStatus]);

	const ask = useCallback(
		async (query: string, filenames: string[]): Promise<AskResult | null> => {
			const trimmed = query.trim();
			if (!trimmed) return null;
			// A new question stops the previous flight first (frees the
			// sidecar queue instead of serializing behind a stale answer).
			const prev = reqRef.current;
			const reqId = prev + 1;
			reqRef.current = reqId;
			if (prev) {
				try {
					window.memories?.stopAsk?.(prev);
				} catch {
					/* bridge optional */
				}
			}
			const seq = ++askSeqRef.current;
			setAsking(true);
			setResult(null);
			setStreamed("");
			setLiveEvidence(null);
			setProgress(null);
			try {
				const res = await window.memories.askScm({
					query: trimmed,
					filenames,
					reqId,
				});
				if (reqId !== reqRef.current || seq !== askSeqRef.current) return null;
				setResult(res);
				setStreamed(null);
				setProgress(null);
				return res;
			} catch {
				if (reqId !== reqRef.current || seq !== askSeqRef.current) return null;
				const failed: AskResult = {
					ok: false,
					reason: "error",
					error: "LLMs failed — try again",
					evidence: [],
				};
				setResult(failed);
				setProgress(null);
				return failed;
			} finally {
				if (reqId === reqRef.current && seq === askSeqRef.current)
					setAsking(false);
			}
		},
		[],
	);

	const stop = useCallback(() => {
		const id = reqRef.current;
		if (!id) return;
		try {
			window.memories?.stopAsk?.(id);
		} catch {
			/* bridge optional — the flight resolves on its own */
		}
	}, []);

	const clear = useCallback(() => {
		const id = reqRef.current;
		if (id) {
			try {
				window.memories?.stopAsk?.(id);
			} catch {
				/* bridge optional */
			}
		}
		reqRef.current = 0;
		askSeqRef.current++;
		setResult(null);
		setStreamed(null);
		setLiveEvidence(null);
		setProgress(null);
		setAsking(false);
	}, []);

	return {
		enabled,
		llmModel,
		asking,
		result,
		streamed,
		liveEvidence,
		progress,
		ask,
		stop,
		clear,
		refreshStatus,
	};
}

// Evidence rows → the RankedMemory shapes the existing grid already renders:
// dialogue moments carry bestScene (badge, poster swap, seek-on-open all
// work unchanged), OCR/keyword hits reuse the same dominant labels as their
// tabs. Order IS the citation order — [1] is displayImages[0].
export function askEvidenceRows(
	evidence: AskEvidenceRow[] | undefined | null,
): RankedMemory[] {
	return (evidence ?? []).map((row): RankedMemory => {
		if (row.kind === "dialogue") {
			return {
				filename: row.filename,
				score: row.score,
				bestScene: {
					t: row.t ?? 0,
					dur: row.dur ?? 0,
					poster: row.poster ?? 0,
					score: row.score,
					why: "text",
					snippet: row.snippet ?? null,
					tier: row.tier,
					tierLabel: row.tierLabel,
				},
			};
		}
		if (row.kind === "ocr") {
			return { filename: row.filename, score: row.score, dominant: "ocr" };
		}
		return { filename: row.filename, score: row.score, dominant: "filename" };
	});
}
