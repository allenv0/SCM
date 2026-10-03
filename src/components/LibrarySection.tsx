"use client";

import { useCallback, useEffect, useState } from "react";
import {
	IconArrowUpRight,
	IconEyeOff,
	IconFolderOpen,
	IconPhotoPlus,
} from "@tabler/icons-react";
import type { StatusPayload, WatchedFolder } from "@/types";

type NotifyTone = "default" | "success" | "warning" | "error";

interface LibrarySectionProps {
	/** Run the OS file picker import (owned by App's pickPhotos). Resolves
	 *  when the batch finishes so the watched list can refresh. */
	onImport: () => Promise<void>;
	/** Toast after unwatch/reveal outcomes (or a bridge failure). */
	onNotify: (message: string, tone: NotifyTone) => void;
	/** When embedded in the tabbed Settings window the outer pane already
	 *  renders the section title — hide this panel's duplicate header. */
	hideHeader?: boolean;
}

function basename(p: string): string {
	return p.split(/[\\/]/).pop() || p;
}

// The "Library" section inside the Settings sheet: the single home for
// adding photos and managing auto-import. The primary Import button sits on
// top; below it the watched-folders list shows every auto-watched folder
// with per-folder Reveal-in-Finder and Stop-watching actions. Photos already
// imported stay in the library when a folder is unwatched.
export default function LibrarySection({
	onImport,
	onNotify,
	hideHeader = false,
}: LibrarySectionProps) {
	const [folders, setFolders] = useState<WatchedFolder[] | null>(null);
	const [importing, setImporting] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setFolders(await window.memories.getWatchedFolders());
		} catch {
			setFolders([]);
		}
	}, []);

	// Load on mount (the sheet only mounts while open) and stay live: an
	// import started outside Settings (⌘I, menu, drag & drop, tray) while
	// the sheet is open broadcasts "library-updated" — pick that up so the
	// count and rows track reality without reopening the sheet.
	useEffect(() => {
		void refresh();
		return window.memories.onStatus((payload: StatusPayload) => {
			if (payload.type === "library-updated") void refresh();
		});
	}, [refresh]);

	const handleImport = useCallback(async () => {
		if (importing) return;
		setImporting(true);
		try {
			await onImport();
		} finally {
			setImporting(false);
			await refresh();
		}
	}, [importing, onImport, refresh]);

	const stopWatching = async (folder: WatchedFolder) => {
		try {
			const res = await window.memories.removeWatchedFolder(folder.path);
			if (!res.ok) {
				onNotify("That folder isn't being watched anymore", "default");
			} else {
				onNotify(`Stopped watching ${basename(folder.path)}`, "default");
			}
		} catch (err: any) {
			onNotify(`Could not stop watching: ${err?.message ?? err}`, "warning");
		}
		await refresh();
	};

	const revealInFinder = async (folder: WatchedFolder) => {
		try {
			const res = await window.memories.revealWatchedFolder(folder.path);
			if (!res.ok) {
				onNotify("Couldn't reveal that folder", "warning");
			}
		} catch (err: any) {
			onNotify(`Couldn't reveal folder: ${err?.message ?? err}`, "warning");
		}
	};

	const count = folders ? folders.length : 0;

	return (
		<div>
			{/* Section header */}
			{!hideHeader && (
				<div className="flex items-center gap-3 px-1 pb-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-500/30 bg-white/40 dark:border-slate-600/50 dark:bg-black/25">
						<IconPhotoPlus
							size={18}
							className="text-zinc-500 dark:text-zinc-400"
							aria-hidden="true"
						/>
					</div>
					<div className="min-w-0">
						<p className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
							Library
						</p>
						<p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">
							Add photos &amp; manage auto-import folders
						</p>
					</div>
				</div>
			)}

			{/* Inner bezel */}
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
				<button
					type="button"
					onClick={() => void handleImport()}
					disabled={importing}
					aria-label="Import photos"
					title="Import Photos (⌘I)"
					className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(14,165,233,0.4)] transition-all hover:from-sky-400 hover:to-sky-600 active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.25)] disabled:cursor-wait disabled:opacity-70"
				>
					<IconPhotoPlus size={16} aria-hidden="true" className="shrink-0" />
					{importing ? "Importing…" : "Import photos"}
					<kbd className="rounded-md border border-white/30 bg-white/15 px-1.5 py-px font-mono text-xs font-medium text-white">
						⌘I
					</kbd>
				</button>
				<p className="mt-2.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Imported folders are watched — new photos inside import automatically.
					Drag &amp; drop anywhere works too.
				</p>

				<div className="my-3 border-t border-slate-500/20 dark:border-slate-600/30" />

				<div className="flex items-center justify-between gap-2 px-0.5 pb-2">
					<p
						className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
						aria-live="polite"
					>
						Watched folders
					</p>
					{count > 0 && (
						<span className="rounded-full bg-zinc-500/15 px-2 py-0.5 font-mono text-xs tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
							{count}
						</span>
					)}
				</div>

				{folders === null ? (
					<p className="px-3 py-5 text-center text-sm text-zinc-400 dark:text-zinc-500">
						…
					</p>
				) : folders.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
						<IconFolderOpen
							size={24}
							className="text-zinc-400 dark:text-zinc-500"
							aria-hidden="true"
						/>
						<p className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
							No watched folders yet.
							<br />
							Import a folder and it&apos;ll show up here.
						</p>
					</div>
				) : (
					<ul className="flex flex-col gap-1">
						{folders.map((folder) => (
							<li
								key={folder.path}
								className="group/folder flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/70 dark:hover:bg-white/10"
							>
								<IconFolderOpen
									size={18}
									className="shrink-0 text-zinc-500 dark:text-zinc-400"
									aria-hidden="true"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
										{basename(folder.path)}
									</p>
									<p
										className={`truncate font-mono text-xs ${
											folder.exists
												? "text-zinc-500 dark:text-zinc-400"
												: "text-amber-600 dark:text-amber-400"
										}`}
										title={folder.path}
									>
										{folder.exists
											? folder.path
											: `${folder.path} — folder missing`}
									</p>
								</div>
								{folder.exists && (
									<button
										type="button"
										onClick={() => void revealInFinder(folder)}
										title={`Reveal ${basename(folder.path)} in Finder`}
										aria-label={`Reveal ${basename(folder.path)} in Finder`}
										className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-sky-500/10 hover:text-sky-600 dark:text-zinc-400 dark:hover:bg-sky-500/15 dark:hover:text-sky-400"
									>
										<IconArrowUpRight size={15} aria-hidden="true" />
										<span className="hidden sm:inline">Open</span>
									</button>
								)}
								<button
									type="button"
									onClick={() => void stopWatching(folder)}
									title={`Stop watching ${basename(folder.path)}`}
									aria-label={`Stop watching ${basename(folder.path)}`}
									className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-500/15 dark:hover:text-red-400"
								>
									<IconEyeOff size={15} aria-hidden="true" />
									<span className="hidden sm:inline">Stop</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
