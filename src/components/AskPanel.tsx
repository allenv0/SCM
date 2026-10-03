"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconDownload } from "@tabler/icons-react";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";
import type { LlmStatus } from "@/types";

type NotifyTone = "default" | "success" | "warning" | "error";

interface AskPanelProps {
	/** Toast for run outcomes (or a bridge failure). */
	onNotify: (message: string, tone: NotifyTone) => void;
}

function formatSize(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
	return `${Math.round(bytes / 1_000_000)}MB`;
}

// The "LLMs Chat" section (Settings → LLMs Chat, MDs/Ask-Mode-Plan.md):
// enable LLMs, download the llama-server sidecar + one model, watch
// progress. A self-contained panel like MenuBarPanel — the LLM concerns are
// additive and touch none of the shared Settings state. Nothing here runs
// until the user opts in: `enabled` defaults false and no download starts
// by itself.
export default function AskPanel({ onNotify }: AskPanelProps) {
	const [status, setStatus] = useState<LlmStatus | null>(null);
	const [enabled, setEnabled] = useState(false);
	// Per-target download progress ("binary" or a model id) → percent.
	const [progress, setProgress] = useState<Record<string, number>>({});
	// In-flight chat-model switch (model id) — the Use button degrades to
	// "Switching…" while setLlmConfig round-trips so double-clicks can't
	// interleave two writes.
	const [selectingId, setSelectingId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const s = await window.memories.getLlmStatus();
			setStatus(s);
			setEnabled(s.enabled);
		} catch {
			/* bridge optional — the panel renders its static hint */
		}
	}, []);

	// Download progress rides {type:"llm"} status events. onNotify is held
	// in a ref: App passes an inline arrow (fresh identity every render) and
	// the subscription must not tear down/re-arm on each one — a missed
	// ready/error event would leave the panel showing a stale progress row.
	const onNotifyRef = useRef(onNotify);
	useEffect(() => {
		onNotifyRef.current = onNotify;
	}, [onNotify]);

	useEffect(() => {
		void refresh();
		return window.memories?.onStatus?.((payload) => {
			if (payload.type !== "llm") return;
			if (payload.phase === "downloading" && payload.target) {
				setProgress((prev) => ({
					...prev,
					[payload.target as string]: payload.progress ?? 0,
				}));
			} else if (payload.phase === "idle") {
				// Config changes (model switch, enable toggle from another
				// window) and sidecar stops broadcast here — re-read so the
				// active-model radio tracks reality without a restart.
				void refresh();
			} else if (payload.phase === "ready" || payload.phase === "error") {
				if (payload.target) {
					setProgress((prev) => {
						const next = { ...prev };
						delete next[payload.target as string];
						return next;
					});
				}
				if (payload.phase === "error" && payload.detail) {
					onNotifyRef.current(
						`LLMs Chat download failed: ${payload.detail}`,
						"warning",
					);
				}
				void refresh();
			}
		});
	}, [refresh]);

	// Any in-flight download also polls the status every 3s — the event
	// subscription is the fast path, the poll is the self-healing backstop
	// (a missed ready/error event must never leave a row stuck on
	// "Downloading…" with its button gone: that read as a dead control).
	useEffect(() => {
		const downloading = Object.keys(progress).length > 0;
		if (!downloading) return;
		const t = setInterval(() => void refresh(), 3000);
		return () => clearInterval(t);
	}, [progress, refresh]);

	const toggleEnabled = async () => {
		const next = !enabled;
		setEnabled(next);
		try {
			const res = await window.memories.setLlmConfig({ enabled: next });
			if (!res?.ok) {
				setEnabled(!next);
				onNotify(res?.error || "Could not update LLMs", "warning");
				return;
			}
			if (next)
				onNotify("LLMs enabled — find it next to the search modes", "success");
		} catch {
			setEnabled(!next);
			onNotify("Could not update LLMs", "warning");
		}
	};

	const download = async (target: string, label: string) => {
		try {
			const res = await window.memories.downloadLlm(target);
			if (res?.ok) {
				onNotify(`${label} ready`, "success");
			} else if (res?.error) {
				onNotify(`${label} download failed: ${res.error}`, "warning");
			}
			void refresh();
		} catch {
			onNotify(`${label} download failed`, "warning");
		}
	};

	// Select the chat model behind the LLMs tab. Downloaded-only: the
	// button only renders for downloaded rows (see below), so main's
	// not-installed gate stays unreachable from this UI — a hand-driven
	// setLlmConfig with a missing model still resolves honestly there.
	const selectModel = async (id: string, label: string) => {
		if (selectingId != null || status?.chatModel === id) return;
		setSelectingId(id);
		try {
			const res = await window.memories.setLlmConfig({ chatModel: id });
			if (!res?.ok) {
				onNotify(res?.error || `Could not select ${label}`, "warning");
				return;
			}
			onNotify(
				`${label} selected — the LLMs tab answers with it from the next question`,
				"success",
			);
		} catch {
			onNotify(`Could not select ${label}`, "warning");
		} finally {
			setSelectingId(null);
			void refresh();
		}
	};

	const models = status?.models ?? [];
	const allDownloaded =
		status?.server.binaryDownloaded &&
		models.length > 0 &&
		models.every((m) => m.downloaded);

	return (
		<div className="mx-auto max-w-[600px] space-y-5">
			<div>
				<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					LLMs Chat
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Ask questions about your library in plain language — “what did Bill
					Gurley say in 2026?” — answered from the text and speech already
					extracted on this Mac, with clickable citations. Answers run on a
					small local model; nothing is uploaded.
				</p>
			</div>

			{/* Enable switch */}
			<div className="flex w-full items-center gap-3.5 rounded-2xl border border-slate-500/25 bg-white/40 px-4 py-3.5 dark:border-slate-600/40 dark:bg-black/20">
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
						Enable LLMs
					</span>
					<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
						Adds an LLMs search mode next to Files / Scenes / Dialogue / OCR
					</span>
				</span>
				<button
					type="button"
					role="switch"
					aria-checked={enabled}
					aria-label="Enable LLMs"
					onClick={() => void toggleEnabled()}
					className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${
						enabled
							? "border-sky-600/50 bg-gradient-to-b from-sky-500 to-sky-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25),0_1px_3px_rgba(14,165,233,0.4)]"
							: "border-slate-500/40 bg-gradient-to-b from-[#c6cfda] to-[#a7b3c0] shadow-[inset_0_2px_3px_rgba(15,23,42,0.25)] dark:border-slate-600/60 dark:from-[#39424f] dark:to-[#262e39] dark:shadow-[inset_0_2px_3px_rgba(0,0,0,0.5)]"
					}`}
				>
					<span
						className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-all ${
							enabled ? "left-[24px]" : "left-[3px]"
						}`}
					/>
				</button>
			</div>

			{/* Downloads. Deliberately NOT gated on the enable switch — the
			    download is a prerequisite for using LLMs, so it stays available
			    whether or not the toggle is already flipped. */}
			<fieldset className="space-y-2">
				<legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
					Models — download once, pick one for the LLMs tab
				</legend>

				<div
					className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 ${
						status?.server.binaryDownloaded ? SELECTED_ROW : IDLE_ROW
					}`}
				>
					<span
						className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
							status?.server.binaryDownloaded
								? "border-sky-500 bg-sky-500 text-white"
								: "border-zinc-400 text-transparent dark:border-zinc-500"
						}`}
						aria-hidden="true"
					>
						<IconCheck size={12} stroke={3} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							Chat engine (llama.cpp)
						</span>
						<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
							{progress.binary != null
								? `Downloading… ${progress.binary}%`
								: status?.server.binaryDownloaded
									? `Downloaded${status.server.binaryTag ? ` · ${status.server.binaryTag}` : ""}`
									: "The local runtime — ~15MB"}
						</span>
					</span>
					{!status?.server.binaryDownloaded && progress.binary == null && (
						<button
							type="button"
							onClick={() => void download("binary", "Chat engine")}
							className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-500/40 bg-white/60 px-3 py-1 text-xs font-semibold text-zinc-700 transition-colors hover:bg-white dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
						>
							<IconDownload size={13} aria-hidden="true" />
							Download
						</button>
					)}
				</div>

				<div role="radiogroup" aria-label="Chat model" className="space-y-2">
					{models.map((m) => {
						const pct = progress[m.id];
						// The active model is the selected radio; downloaded-but-idle
						// rows keep their download check but not the blue surround.
						const isActive = status?.chatModel === m.id;
						const switching = selectingId === m.id;
						return (
							<div
								key={m.id}
								role="radio"
								aria-checked={isActive}
								aria-label={`${m.label} — ${m.downloaded ? (isActive ? "in use by the LLMs tab" : "downloaded") : "not downloaded"}`}
								className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3 ${
									isActive ? SELECTED_ROW : IDLE_ROW
								}`}
							>
								<span
									className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
										m.downloaded
											? "border-sky-500 bg-sky-500 text-white"
											: "border-zinc-400 text-transparent dark:border-zinc-500"
									}`}
									aria-hidden="true"
								>
									<IconCheck size={12} stroke={3} />
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										{m.label}
										{isActive && (
											<span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
												In use
											</span>
										)}
									</span>
									<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
										{pct != null
											? `Downloading… ${pct}%`
											: m.downloaded
												? isActive
													? "Downloaded — in use by the LLMs tab"
													: "Downloaded — ready to use"
												: `${m.blurb} · ~${formatSize(m.sizeBytes)}`}
									</span>
								</span>
								{!isActive && m.downloaded && pct == null && (
									<button
										type="button"
										disabled={selectingId != null}
										onClick={() => void selectModel(m.id, m.label)}
										className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-500/40 bg-white/60 px-3 py-1 text-xs font-semibold text-zinc-700 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
									>
										{switching ? "Switching…" : "Use"}
									</button>
								)}
								{!m.downloaded && pct == null && (
									<button
										type="button"
										onClick={() => void download(m.id, m.label)}
										className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-500/40 bg-white/60 px-3 py-1 text-xs font-semibold text-zinc-700 transition-colors hover:bg-white dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
									>
										<IconDownload size={13} aria-hidden="true" />
										Download
									</button>
								)}
							</div>
						);
					})}
				</div>
			</fieldset>

			<p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
				{allDownloaded
					? "Everything is downloaded — LLMs run fully offline. The model loads only while you use it and stops a few minutes after."
					: "Downloads land in your SCM data folder and never leave your machine. The model is a large file — on a slow connection it keeps its progress if interrupted, so just press Download again."}
			</p>
		</div>
	);
}
