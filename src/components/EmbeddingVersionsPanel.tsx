"use client";

import { useCallback, useEffect, useState } from "react";
import { IconHistory, IconX } from "@tabler/icons-react";
import type { EmbeddingVersion, StatusPayload } from "@/types";
import { formatBytes } from "@/lib/format";

type NotifyTone = "default" | "success" | "warning" | "error";

interface EmbeddingVersionsPanelProps {
	/** Toast after save/restore/rename/delete outcomes. */
	onNotify: (message: string, tone: NotifyTone) => void;
	hideHeader?: boolean;
}

function formatDate(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

// Named snapshots of the searchable state across every model
// (Settings → Library). Saving captures the index, all built models'
// bins, scene + transcript sidecars, thresholds, and overrides; restoring
// auto-backs-up the live state first, so nothing is ever lost. Photos
// themselves are referenced, not copied — a restore names rows whose app
// copy is gone instead of failing silently.
export default function EmbeddingVersionsPanel({
	onNotify,
	hideHeader = false,
}: EmbeddingVersionsPanelProps) {
	const [versions, setVersions] = useState<EmbeddingVersion[] | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Inline two-step confirms (session-only): which row is confirming a
	// restore or a delete, and which row is editing its name.
	const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	// Fresh-start danger zone (session-only): expanded confirm, the live
	// row/watch counts it would wipe, and the in-flight flag.
	const [confirmReset, setConfirmReset] = useState(false);
	const [resetInfo, setResetInfo] = useState<{
		rows: number;
		watched: number;
	} | null>(null);
	const [resetting, setResetting] = useState(false);
	const [editing, setEditing] = useState<{ slug: string; name: string } | null>(
		null,
	);

	const refresh = useCallback(async () => {
		try {
			const res = await window.memories.getEmbeddingVersions();
			if (res?.ok) setVersions(res.versions ?? []);
		} catch {
			/* bridge is optional — the panel stays in its loading state */
		}
	}, []);

	// Load on mount and stay live: a restore (here or elsewhere) broadcasts
	// "library-updated" — pick that up so the auto-backup row appears
	// without reopening the sheet.
	useEffect(() => {
		void refresh();
		return window.memories?.onStatus?.((payload: StatusPayload) => {
			if (payload.type === "library-updated") void refresh();
		});
	}, [refresh]);

	const resetConfirms = () => {
		setConfirmRestore(null);
		setConfirmDelete(null);
		setEditing(null);
		setConfirmReset(false);
	};

	const expandResetConfirm = async () => {
		setError(null);
		setConfirmRestore(null);
		setConfirmDelete(null);
		setEditing(null);
		// Live counts so the confirm names exactly what would go.
		let rows = 0;
		let watched = 0;
		try {
			const index = await fetch("/memories-index.json").then((r) => r.json());
			if (Array.isArray(index.images)) rows = index.images.length;
		} catch {
			/* count stays 0 — the confirm still works */
		}
		try {
			const folders = await window.memories.getWatchedFolders();
			if (Array.isArray(folders)) watched = folders.length;
		} catch {
			/* count stays 0 */
		}
		setResetInfo({ rows, watched });
		setConfirmReset(true);
	};

	const handleReset = async () => {
		if (resetting) return;
		// The delete bridge ships with the main process: a window opened
		// before the last app update has no resetLibrary — say so plainly
		// instead of failing with a TypeError.
		if (typeof window.memories.resetLibrary !== "function") {
			setError(
				"This window is from before the fresh-start update — restart SCM and try again.",
			);
			return;
		}
		setResetting(true);
		setError(null);
		try {
			const res = await window.memories.resetLibrary();
			if (res?.ok) {
				setConfirmReset(false);
				setResetInfo(null);
				onNotify(
					`Library deleted — ${res.rows ?? 0} photo${res.rows === 1 ? "" : "s"} removed, fresh start ready`,
					"success",
				);
			} else {
				setError(res?.error ?? "Could not delete the library");
			}
		} catch (err: any) {
			setError(`Could not delete the library: ${err?.message ?? err}`);
		} finally {
			setResetting(false);
			await refresh();
		}
	};

	const handleSave = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await window.memories.createEmbeddingVersion(name.trim());
			if (res?.ok) {
				setName("");
				resetConfirms();
				onNotify(`Version saved — restore it any time from here`, "success");
			} else {
				setError(res?.error ?? "Could not save the version");
			}
		} catch (err: any) {
			setError(`Could not save the version: ${err?.message ?? err}`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const handleRestore = async (slug: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await window.memories.restoreEmbeddingVersion(slug);
			if (res?.ok) {
				resetConfirms();
				if (res.missing && res.missing.length > 0) {
					onNotify(
						`Restored — ${res.missing.length} saved row${res.missing.length === 1 ? " is" : "s are"} missing on disk (listed in the version). A backup of the previous state was kept.`,
						"warning",
					);
				} else {
					onNotify(
						`Restored — a backup of the previous state was kept`,
						"success",
					);
				}
			} else {
				setError(res?.error ?? "Could not restore the version");
			}
		} catch (err: any) {
			setError(`Could not restore the version: ${err?.message ?? err}`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const handleRename = async () => {
		if (!editing || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await window.memories.renameEmbeddingVersion(
				editing.slug,
				editing.name.trim(),
			);
			if (res?.ok) {
				resetConfirms();
			} else {
				setError(res?.error ?? "Could not rename the version");
			}
		} catch (err: any) {
			setError(`Could not rename the version: ${err?.message ?? err}`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const handleDelete = async (slug: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await window.memories.deleteEmbeddingVersion(slug);
			if (res?.ok) {
				resetConfirms();
				onNotify("Version deleted", "default");
			} else {
				setError(res?.error ?? "Could not delete the version");
			}
		} catch (err: any) {
			setError(`Could not delete the version: ${err?.message ?? err}`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	return (
		<div>
			{/* Section header */}
			{!hideHeader && (
				<div className="flex items-center gap-3 px-1 pb-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-500/30 bg-white/40 dark:border-slate-600/50 dark:bg-black/25">
						<IconHistory
							size={18}
							className="text-zinc-500 dark:text-zinc-400"
							aria-hidden="true"
						/>
					</div>
					<div className="min-w-0">
						<p className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
							Embedding versions
						</p>
						<p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">
							Named snapshots of search state, restorable
						</p>
					</div>
				</div>
			)}

			{/* Inner bezel */}
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
				<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Snapshots the index, every built model&apos;s vectors, scene + speech
					sidecars, and thresholds — across all models. Restoring backs up the
					live state first, so nothing is ever lost.
				</p>

				{/* Save row */}
				<div className="mt-3 flex gap-2">
					<input
						type="text"
						value={name}
						maxLength={80}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleSave();
						}}
						placeholder="Name this version…"
						aria-label="Version name"
						className="min-w-0 flex-1 rounded-xl border border-slate-500/30 bg-white/60 px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-100 dark:placeholder:text-zinc-500"
					/>
					<button
						type="button"
						disabled={busy || name.trim().length === 0}
						onClick={() => void handleSave()}
						className="shrink-0 rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(14,165,233,0.4)] transition-all hover:from-sky-400 hover:to-sky-600 disabled:cursor-wait disabled:opacity-60"
					>
						{busy ? "Working…" : "Save"}
					</button>
				</div>

				{error && (
					<div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
						<p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
							{error}
						</p>
					</div>
				)}

				<div className="my-3 border-t border-slate-500/20 dark:border-slate-600/30" />

				{/* Version list */}
				{versions === null ? (
					<p className="px-3 py-5 text-center text-sm text-zinc-400 dark:text-zinc-500">
						…
					</p>
				) : versions.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
						<IconHistory
							size={24}
							className="text-zinc-400 dark:text-zinc-500"
							aria-hidden="true"
						/>
						<p className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
							No versions yet.
							<br />
							Name one above before a big re-analyze or model switch.
						</p>
					</div>
				) : (
					<ul className="flex flex-col gap-1">
						{versions.map((v) => (
							<li
								key={v.slug}
								className="rounded-xl px-3 py-2.5 transition-colors hover:bg-white/70 dark:hover:bg-white/10"
							>
								<div className="flex items-center gap-3">
									<div className="min-w-0 flex-1">
										{editing?.slug === v.slug ? (
											<span className="flex gap-2">
												<input
													type="text"
													value={editing.name}
													maxLength={80}
													autoFocus
													onChange={(e) =>
														setEditing({ slug: v.slug, name: e.target.value })
													}
													onKeyDown={(e) => {
														if (e.key === "Enter") void handleRename();
														if (e.key === "Escape") setEditing(null);
													}}
													aria-label="New version name"
													className="min-w-0 flex-1 rounded-lg border border-slate-500/30 bg-white/70 px-2 py-1 text-sm text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/30 dark:text-zinc-100"
												/>
												<button
													type="button"
													disabled={busy}
													onClick={() => void handleRename()}
													className="shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-sky-600 hover:bg-sky-500/10 disabled:opacity-50 dark:text-sky-400 dark:hover:bg-sky-500/15"
												>
													Save
												</button>
												<button
													type="button"
													onClick={() => setEditing(null)}
													aria-label="Cancel rename"
													className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-500/10 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
												>
													<IconX size={14} aria-hidden="true" />
												</button>
											</span>
										) : (
											<>
												<p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
													{v.name}
												</p>
												<p
													className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400"
													title={`${v.rowCount} rows · models: ${v.modelIds.join(", ") || "none built yet"}`}
												>
													{formatDate(v.createdAt)} · {v.rowCount} rows ·{" "}
													{formatBytes(v.totalBytes)}
													{v.modelIds.length > 0 &&
														` · ${v.modelIds.length} model${v.modelIds.length === 1 ? "" : "s"}`}
												</p>
											</>
										)}
									</div>
									{editing?.slug !== v.slug && (
										<span className="flex shrink-0 items-center gap-1">
											<button
												type="button"
												disabled={busy}
												onClick={() => {
													setConfirmDelete(null);
													setEditing(null);
													setConfirmRestore(
														confirmRestore === v.slug ? null : v.slug,
													);
												}}
												title={`Restore ${v.name}`}
												className="shrink-0 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-zinc-600 transition-colors hover:bg-sky-500/10 hover:text-sky-600 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-sky-500/15 dark:hover:text-sky-400"
											>
												Restore
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => {
													setConfirmRestore(null);
													setConfirmDelete(null);
													setEditing({ slug: v.slug, name: v.name });
												}}
												title={`Rename ${v.name}`}
												className="shrink-0 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
											>
												Rename
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => {
													setConfirmRestore(null);
													setEditing(null);
													setConfirmDelete(
														confirmDelete === v.slug ? null : v.slug,
													);
												}}
												title={`Delete ${v.name}`}
												aria-label={`Delete ${v.name}`}
												className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-500/15 dark:hover:text-red-400"
											>
												<IconX size={14} aria-hidden="true" />
											</button>
										</span>
									)}
								</div>

								{/* Restore confirm */}
								{confirmRestore === v.slug && (
									<div className="mt-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 dark:border-sky-400/30 dark:bg-sky-400/10">
										<p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-200">
											Restore <strong>{v.name}</strong>? The live state is
											backed up first — nothing is lost either way.
										</p>
										<div className="mt-2 flex gap-2">
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleRestore(v.slug)}
												className="rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(14,165,233,0.4)] transition-all hover:from-sky-400 hover:to-sky-600 disabled:cursor-wait disabled:opacity-60"
											>
												{busy ? "Restoring…" : "Restore"}
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => setConfirmRestore(null)}
												className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-1.5 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 disabled:opacity-50 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
											>
												Keep current
											</button>
										</div>
									</div>
								)}

								{/* Delete confirm */}
								{confirmDelete === v.slug && (
									<div className="mt-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 dark:border-red-400/30 dark:bg-red-400/10">
										<p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-200">
											Delete <strong>{v.name}</strong>? Frees{" "}
											{formatBytes(v.totalBytes)}. This can&apos;t be undone.
										</p>
										<div className="mt-2 flex gap-2">
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleDelete(v.slug)}
												className="rounded-xl border border-red-500/40 bg-white/60 px-3.5 py-1.5 text-[13px] font-semibold text-red-700 transition-colors hover:bg-white disabled:opacity-50 dark:border-red-400/40 dark:bg-black/25 dark:text-red-300 dark:hover:bg-black/40"
											>
												{busy ? "Deleting…" : "Delete"}
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => setConfirmDelete(null)}
												className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-1.5 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 disabled:opacity-50 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
											>
												Keep it
											</button>
										</div>
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Fresh-start danger zone: wipe the whole index for a clean
			    slate. Originals, settings, weights, thresholds, and the
			    versions above are kept — everything else goes. */}
			<div className="relative mt-4 rounded-2xl border border-red-500/40 bg-gradient-to-b from-red-500/[0.07] to-red-500/[0.03] p-4 dark:border-red-400/30">
				<p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					Fresh start
				</p>
				{!confirmReset ? (
					<>
						<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							Delete the entire photo index and start clean.
						</p>
						<button
							type="button"
							onClick={() => void expandResetConfirm()}
							className="mt-2.5 rounded-xl border border-red-500/40 bg-white/60 px-3.5 py-2 text-[13px] font-semibold text-red-700 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-400/40 dark:bg-black/25 dark:text-red-300 dark:hover:bg-black/40"
						>
							Delete entire library…
						</button>
					</>
				) : (
					<div className="mt-2">
						<p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
							Delete all {resetInfo?.rows ?? 0} photos and start over?
						</p>
						<ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							<li>Removes every photo, video, and AI index entry</li>
							<li>
								Stops watching {resetInfo?.watched ?? 0} folder
								{resetInfo?.watched === 1 ? "" : "s"} — nothing re-imports on
								its own
							</li>
							<li>Clears manual Screenshots decisions + failure history</li>
							<li>
								Keeps your original files, settings, model weights, thresholds,
								and the versions above
							</li>
						</ul>
						<p className="mt-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							This can&apos;t be undone — save a version above first if you
							might want anything back.
						</p>
						{error && (
							<div className="mt-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
								<p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
									{error}
								</p>
							</div>
						)}
						<div className="mt-2.5 flex gap-2">
							<button
								type="button"
								disabled={resetting}
								onClick={() => void handleReset()}
								className="rounded-xl bg-gradient-to-b from-red-500 to-red-600 px-4 py-2 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(239,68,68,0.4)] transition-all hover:from-red-400 hover:to-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
							>
								{resetting ? "Deleting…" : "Delete entire library"}
							</button>
							<button
								type="button"
								disabled={resetting}
								onClick={() => {
									setConfirmReset(false);
									setResetInfo(null);
								}}
								className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-2 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
							>
								Keep everything
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
