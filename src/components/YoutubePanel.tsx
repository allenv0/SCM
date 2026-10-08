"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	loadSavedSearches,
	saveSavedSearches,
	updateSavedSearch,
	type SavedTab,
} from "@/lib/savedSearches";
import type { YoutubeStatus } from "@/types";

interface YoutubePanelProps {
	onNotify?: (message: string) => void;
	onOpenInterest?: (prompt: string, mode: SavedTab["mode"]) => void;
}

interface MatchRow {
	interest: SavedTab;
	filename: string;
	score: number;
	t?: number;
	snippet?: string | null;
	why?: string;
}

export default function YoutubePanel({
	onNotify,
	onOpenInterest,
}: YoutubePanelProps) {
	const [status, setStatus] = useState<YoutubeStatus | null>(null);
	const [ytFiles, setYtFiles] = useState<string[]>([]);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [interests, setInterests] = useState<SavedTab[]>(() =>
		loadSavedSearches().filter((t) => t.watch === true),
	);
	const [matches, setMatches] = useState<MatchRow[]>([]);
	const [matching, setMatching] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const s = await window.memories?.getYoutubeStatus?.();
			if (s) setStatus(s);
		} catch {
			/* bridge unavailable in tests */
		}
		try {
			const f = await window.memories?.getYoutubeFiles?.();
			if (f?.ok && Array.isArray(f.files)) setYtFiles(f.files);
		} catch {
			/* ignore */
		}
		try {
			setInterests(loadSavedSearches().filter((t) => t.watch === true));
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		const off = window.memories?.onStatus?.((payload) => {
			if ((payload as { type?: string }).type === "youtube") {
				setStatus(payload as unknown as YoutubeStatus);
				refresh();
			} else if ((payload as { type?: string }).type === "library-updated") {
				refresh();
			}
		});
		return () => {
			try {
				off?.();
			} catch {
				/* ignore */
			}
		};
	}, [refresh]);

	const ytSet = useMemo(() => new Set(ytFiles), [ytFiles]);

	const submitUrl = useCallback(async () => {
		const input = url.trim();
		if (!input || busy) return;
		setBusy(true);
		try {
			if (!status?.binaryReady) {
				await window.memories?.ensureYoutubeBinary?.();
			}
			const res = await window.memories?.downloadYoutube?.({ url: input });
			if (res?.ok) {
				onNotify?.("YouTube download queued — indexing when done");
				setUrl("");
			} else {
				onNotify?.(`YouTube: ${res?.error || "could not queue URL"}`);
			}
			refresh();
		} finally {
			setBusy(false);
		}
	}, [url, busy, status?.binaryReady, onNotify, refresh]);

	const addChannel = useCallback(async () => {
		const input = url.trim();
		if (!input || busy) return;
		setBusy(true);
		try {
			if (!status?.binaryReady) {
				await window.memories?.ensureYoutubeBinary?.();
			}
			const res = await window.memories?.addYoutubeChannel?.({ url: input });
			if (res?.ok) {
				const n = status?.maxPerChannel ?? 20;
				onNotify?.(`Followed — syncing newest ${n} videos`);
				setUrl("");
			} else {
				onNotify?.(`YouTube: ${res?.error || "not a channel or playlist URL"}`);
			}
			refresh();
		} finally {
			setBusy(false);
		}
	}, [
		url,
		busy,
		status?.binaryReady,
		status?.maxPerChannel,
		onNotify,
		refresh,
	]);

	const saveConfig = useCallback(
		async (patch: {
			enabled?: boolean;
			quality?: string;
			maxPerChannel?: number;
			pollHours?: number;
		}) => {
			try {
				await window.memories?.setYoutubeConfig?.(patch);
				refresh();
			} catch {
				/* ignore */
			}
		},
		[refresh],
	);

	const toggleWatch = useCallback((prompt: string, watch: boolean) => {
		try {
			const all = loadSavedSearches();
			saveSavedSearches(updateSavedSearch(all, prompt, { watch }));
			setInterests(loadSavedSearches().filter((t) => t.watch === true));
		} catch {
			/* ignore */
		}
	}, []);

	const checkInterests = useCallback(async () => {
		if (matching || ytFiles.length === 0) return;
		if (interests.length === 0) {
			onNotify?.("Flag a saved search as watched to use interests");
			return;
		}
		setMatching(true);
		const out: MatchRow[] = [];
		try {
			for (const interest of interests.slice(0, 20)) {
				try {
					if (interest.mode === "scenes" && window.memories?.rankScenes) {
						const rows = await window.memories.rankScenes(interest.prompt, 50);
						for (const r of rows || []) {
							if (ytSet.has(r.filename)) {
								out.push({
									interest,
									filename: r.filename,
									score: r.score,
									t: r.t,
									snippet: r.snippet,
									why: r.why,
								});
								if (out.length >= 60) break;
							}
						}
					} else if (
						interest.mode === "dialogue" &&
						window.memories?.rankDialogue
					) {
						const rows = await window.memories.rankDialogue(
							interest.prompt,
							50,
						);
						for (const r of rows || []) {
							if (ytSet.has(r.filename)) {
								out.push({
									interest,
									filename: r.filename,
									score: r.score,
									t: r.t,
									snippet: r.snippet,
									why: r.why,
								});
								if (out.length >= 60) break;
							}
						}
					} else {
						const res = await window.memories?.rankSearch?.(
							interest.prompt,
							50,
						);
						const rows = Array.isArray(res) ? res : res?.results || [];
						for (const r of rows) {
							if (ytSet.has(r.filename)) {
								out.push({ interest, filename: r.filename, score: r.score });
								if (out.length >= 60) break;
							}
						}
					}
				} catch {
					/* one interest failing never blocks the rest */
				}
				if (out.length >= 60) break;
			}
			out.sort((a, b) => b.score - a.score);
			setMatches(out.slice(0, 60));
			onNotify?.(
				out.length === 0
					? "No interest matches in YouTube downloads yet"
					: `${out.length} interest match${out.length === 1 ? "" : "es"} found`,
			);
		} finally {
			setMatching(false);
		}
	}, [matching, ytFiles, interests, ytSet, onNotify]);

	return (
		<div className="mx-auto max-w-[600px]">
			<p className="mb-3 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
				Follow channels to download videos, then watch saved searches to catch
				the moments you care about — matches jump to the timecode.
			</p>

			<section
				aria-label="Get videos"
				className="mb-4 rounded-2xl border border-slate-500/30 p-4 dark:border-slate-600/50"
			>
				<h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
					Get videos
				</h3>
				<p className="mb-3 mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
					Channels and playlists you follow. New items download with yt-dlp
					(fetched on first use) and index like the rest of your library.
				</p>
				<div className="mb-3 flex gap-2">
					<input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submitUrl();
						}}
						placeholder="Paste video, channel, or playlist URL…"
						className="min-w-0 flex-1 rounded-xl border border-slate-500/45 bg-white/80 px-3 py-2 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-violet-500 dark:border-slate-600/70 dark:bg-[#1a212c] dark:text-zinc-100"
					/>
					<button
						onClick={submitUrl}
						disabled={busy || !url.trim()}
						className="rounded-xl bg-violet-600 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
					>
						Download
					</button>
					<button
						onClick={addChannel}
						disabled={busy || !url.trim()}
						className="rounded-xl border border-violet-500/60 px-3 py-2 text-[13px] font-semibold text-violet-700 disabled:opacity-40 dark:text-violet-300"
					>
						+ Channel
					</button>
				</div>

				<div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
					<span>
						{status?.binaryReady
							? "yt-dlp ready"
							: "yt-dlp fetches on first use"}
					</span>
					<span aria-hidden>·</span>
					<span>
						{ytFiles.length} video{ytFiles.length === 1 ? "" : "s"} downloaded
					</span>
					{status?.active && (
						<>
							<span aria-hidden>·</span>
							<span>downloading… ({status.pending} queued)</span>
						</>
					)}
				</div>

				<div className="mb-3 rounded-xl border border-slate-500/30 px-3 py-2 dark:border-slate-600/50">
					<h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						Download settings
					</h4>
					<label className="mb-2 flex cursor-pointer items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-200">
						<input
							type="checkbox"
							checked={status?.enabled !== false}
							onChange={(e) => void saveConfig({ enabled: e.target.checked })}
						/>
						Auto-check subscriptions
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="block text-[12px] text-zinc-500 dark:text-zinc-400">
							Videos per channel
							<input
								type="number"
								min={1}
								max={200}
								value={status?.maxPerChannel ?? 20}
								onChange={(e) => {
									const v = Math.min(
										200,
										Math.max(1, Math.floor(Number(e.target.value) || 1)),
									);
									void saveConfig({ maxPerChannel: v });
								}}
								aria-label="Videos per channel"
								className="mt-1 w-full rounded-lg border border-slate-500/45 bg-white/80 px-2 py-1 text-[13px] text-zinc-800 outline-none dark:border-slate-600/70 dark:bg-[#1a212c] dark:text-zinc-100"
							/>
						</label>
						<label className="block text-[12px] text-zinc-500 dark:text-zinc-400">
							Quality
							<select
								value={status?.quality ?? "720p"}
								onChange={(e) => void saveConfig({ quality: e.target.value })}
								aria-label="Download quality"
								className="mt-1 w-full rounded-lg border border-slate-500/45 bg-white/80 px-2 py-1 text-[13px] text-zinc-800 outline-none dark:border-slate-600/70 dark:bg-[#1a212c] dark:text-zinc-100"
							>
								<option value="480p">480p (smallest)</option>
								<option value="720p">720p (default)</option>
								<option value="1080p">1080p (largest)</option>
							</select>
						</label>
					</div>
					<label className="mt-2 block text-[12px] text-zinc-500 dark:text-zinc-400">
						Check every (hours)
						<input
							type="number"
							min={1}
							max={168}
							value={status?.pollHours ?? 6}
							onChange={(e) => {
								const v = Math.min(
									168,
									Math.max(1, Math.floor(Number(e.target.value) || 6)),
								);
								void saveConfig({ pollHours: v });
							}}
							aria-label="Check interval in hours"
							className="mt-1 w-full rounded-lg border border-slate-500/45 bg-white/80 px-2 py-1 text-[13px] text-zinc-800 outline-none dark:border-slate-600/70 dark:bg-[#1a212c] dark:text-zinc-100"
						/>
					</label>
					<p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
						Each sync grabs at most that many newest videos per channel;
						already-downloaded ones are skipped.
					</p>
				</div>

				<div className="mb-1">
					<h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						Followed channels & playlists ({status?.channels?.length ?? 0})
					</h4>
					{(status?.channels?.length || 0) === 0 ? (
						<p className="text-[12px] text-zinc-500 dark:text-zinc-400">
							Nothing followed yet — paste a channel URL (its /videos page syncs
							most predictably) or a public playlist URL above.
						</p>
					) : (
						<ul className="space-y-1">
							{status?.channels?.map((c) => (
								<li
									key={c.url}
									className="flex items-center gap-2 rounded-lg border border-slate-500/30 px-2 py-1 text-[12px] dark:border-slate-600/50"
								>
									<span
										title={c.kind === "playlist" ? "Playlist" : "Channel"}
										className="shrink-0 rounded-full bg-violet-600/15 px-1.5 py-px text-[10px] font-semibold text-violet-700 dark:text-violet-300"
									>
										{c.kind === "playlist" ? "List" : "Chan"}
									</span>
									<span className="min-w-0 flex-1 truncate">{c.label}</span>
									<button
										onClick={async () => {
											await window.memories?.downloadYoutube?.({ url: c.url });
											refresh();
										}}
										className="text-violet-600 dark:text-violet-300"
									>
										Sync
									</button>
									<button
										onClick={async () => {
											await window.memories?.removeYoutubeChannel?.(c.url);
											refresh();
										}}
										className="text-zinc-400 hover:text-rose-500"
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</section>

			<section
				aria-label="Find clips"
				className="mb-4 rounded-2xl border border-slate-500/30 p-4 dark:border-slate-600/50"
			>
				<h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
					Find clips
				</h3>
				<p className="mb-3 mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
					Watched saved searches auto-match new downloads. Flag any saved tab
					with Watch to add it here.
				</p>
				<div className="mb-1 flex items-center justify-between">
					<h4 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						Watched interests ({interests.length})
					</h4>
					<button
						onClick={checkInterests}
						disabled={
							matching || ytFiles.length === 0 || interests.length === 0
						}
						className="rounded-lg bg-violet-600 px-2 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
					>
						{matching ? "Matching…" : "Check new videos"}
					</button>
				</div>
				{interests.length === 0 ? (
					<p className="text-[12px] text-zinc-500 dark:text-zinc-400">
						No watched interests yet — save a search as a tab, then flag it as
						watched to auto-match YouTube downloads.
					</p>
				) : (
					<ul className="space-y-1">
						{interests.map((t) => (
							<li
								key={t.prompt}
								className="flex items-center gap-2 rounded-lg border border-slate-500/30 px-2 py-1 text-[12px] dark:border-slate-600/50"
							>
								<span className="min-w-0 flex-1 truncate">
									{t.label} <span className="text-zinc-400">[{t.mode}]</span>
								</span>
								<button
									onClick={() => onOpenInterest?.(t.prompt, t.mode)}
									className="text-violet-600 dark:text-violet-300"
								>
									Open
								</button>
								<button
									onClick={() => toggleWatch(t.prompt, false)}
									className="text-zinc-400 hover:text-rose-500"
								>
									Unwatch
								</button>
							</li>
						))}
					</ul>
				)}

				{matches.length > 0 && (
					<div className="mt-3">
						<h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							Latest matches ({matches.length})
						</h4>
						<p className="mb-1 text-[11px] text-zinc-400 dark:text-zinc-500">
							Session results only — reopen anytime via the interest.
						</p>
						<ul className="space-y-1">
							{matches.map((m, i) => (
								<li
									key={`${m.interest.prompt}-${m.filename}-${i}`}
									className="rounded-lg border border-emerald-500/40 px-2 py-1 text-[12px]"
								>
									<div className="flex items-center gap-2">
										<span className="rounded-full bg-emerald-600/15 px-1.5 py-px font-semibold text-emerald-700 dark:text-emerald-300">
											{m.interest.label}
										</span>
										<span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">
											{m.filename}
										</span>
										<span className="text-zinc-400">{m.score.toFixed(3)}</span>
									</div>
									{(m.snippet || m.t !== undefined) && (
										<div className="mt-0.5 truncate text-zinc-500 dark:text-zinc-400">
											{m.t !== undefined && (
												<span>
													@{Math.floor(m.t / 60)}:
													{String(Math.floor(m.t % 60)).padStart(2, "0")} —{" "}
												</span>
											)}
											{m.snippet}
										</div>
									)}
									<button
										onClick={() =>
											onOpenInterest?.(m.interest.prompt, m.interest.mode)
										}
										className="mt-0.5 text-violet-600 dark:text-violet-300"
									>
										Jump to match →
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
			</section>
		</div>
	);
}
