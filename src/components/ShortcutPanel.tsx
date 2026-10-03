"use client";

import { useCallback, useEffect, useState } from "react";
import { IconKeyboard, IconX } from "@tabler/icons-react";
import { displayShortcut, eventToAccelerator } from "@/lib/viewShortcuts";

type NotifyTone = "default" | "success" | "warning" | "error";

interface ShortcutPanelProps {
	onNotify: (message: string, tone: NotifyTone) => void;
	hideHeader?: boolean;
}

// Key normalization lives in @/lib/viewShortcuts (eventToAccelerator +
// displayShortcut) — shared with the Keyboard view-shortcut editor so the
// recorder and the grid matcher can never drift apart.
// The "Global Shortcut" section inside the Settings sheet. Records a
// user-chosen keyboard shortcut that brings the SCM window to focus
// even when it's in the background (Electron globalShortcut API).
export default function ShortcutPanel({
	onNotify,
	hideHeader = false,
}: ShortcutPanelProps) {
	const [current, setCurrent] = useState<string | null>(null);
	const [recording, setRecording] = useState(false);
	const [conflictError, setConflictError] = useState<string | null>(null);

	// Load the saved shortcut on mount.
	useEffect(() => {
		void window.memories.getShortcut().then((s) => setCurrent(s));
	}, []);

	// When recording, capture keystrokes in a window-level handler.
	useEffect(() => {
		if (!recording) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Escape cancels recording.
			if (e.key === "Escape") {
				setRecording(false);
				return;
			}

			const accel = eventToAccelerator(e);
			if (!accel) return;

			// Got a valid combo — try to register it.
			setRecording(false);
			setConflictError(null);
			void window.memories.setShortcut(accel).then((res) => {
				if (res.ok) {
					setCurrent(accel);
					setConflictError(null);
					onNotify(`Shortcut set: ${displayShortcut(accel)}`, "success");
				} else {
					// Registration failed — the shortcut is in use.
					setConflictError(res.error ?? "Shortcut is in use");
				}
			});
		};

		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recording, onNotify]);

	const clearShortcut = useCallback(() => {
		void window.memories.setShortcut(null).then((res) => {
			if (res.ok) {
				setCurrent(null);
				onNotify("Shortcut cleared", "default");
			} else {
				onNotify(res.error ?? "Could not clear shortcut", "warning");
			}
		});
	}, [onNotify]);

	return (
		<div>
			{/* Section header */}
			{!hideHeader && (
				<div className="flex items-center gap-3 px-1 pb-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-500/30 bg-white/40 dark:border-slate-600/50 dark:bg-black/25">
						<IconKeyboard
							size={18}
							className="text-zinc-500 dark:text-zinc-400"
							aria-hidden="true"
						/>
					</div>
					<div className="min-w-0">
						<p className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
							Global Shortcut
						</p>
						<p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">
							Bring SCM to focus from anywhere
						</p>
					</div>
				</div>
			)}

			{/* Inner bezel */}
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
				{recording ? (
					<div className="flex flex-col items-center gap-2.5 py-4 text-center">
						<div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed border-sky-400/60 bg-sky-500/10 dark:border-sky-400/40 dark:bg-sky-500/10">
							<IconKeyboard
								size={24}
								className="animate-pulse text-sky-500 dark:text-sky-400"
								aria-hidden="true"
							/>
						</div>
						<p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							Press your shortcut…
						</p>
						<p className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
							Hold a modifier (⌘, Ctrl, or ⌥) and press a key.
							<br />
							Esc to cancel.
						</p>
						<button
							type="button"
							onClick={() => setRecording(false)}
							className="mt-1 rounded-full px-4 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
						>
							Cancel
						</button>
					</div>
				) : (
					<>
						<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							Press a key combination anywhere on your Mac to bring this window
							to the front — even when SCM is in the background.
						</p>

						{current && !conflictError && (
							<div className="mt-3 flex items-center gap-2">
								<kbd className="inline-flex items-center gap-1 rounded-lg border border-slate-500/40 bg-white/60 px-2.5 py-1 font-mono text-[13px] font-medium text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-slate-600/60 dark:bg-white/10 dark:text-zinc-200 dark:shadow-none">
									{displayShortcut(current)}
								</kbd>
								<button
									type="button"
									onClick={clearShortcut}
									className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:text-zinc-500 dark:hover:bg-red-500/15 dark:hover:text-red-400"
									aria-label="Remove shortcut"
									title="Remove shortcut"
								>
									<IconX size={14} aria-hidden="true" />
								</button>
							</div>
						)}

						{conflictError && (
							<div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
								<p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
									{conflictError}
								</p>
							</div>
						)}

						<div className="mt-4 flex items-center justify-end gap-2">
							<button
								type="button"
								onClick={() => {
									setConflictError(null);
									setRecording(true);
								}}
								className="rounded-full bg-gradient-to-b from-sky-500 to-sky-600 px-4 py-1.5 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(14,165,233,0.4)] transition-all hover:from-sky-400 hover:to-sky-600 active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.25)]"
							>
								{current ? "Change shortcut" : "Record shortcut"}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
