"use client";

import { useCallback, useEffect, useState } from "react";
import { IconLayoutNavbar } from "@tabler/icons-react";

type NotifyTone = "default" | "success" | "warning" | "error";

interface MenuBarPanelProps {
	onNotify: (message: string, tone: NotifyTone) => void;
	hideHeader?: boolean;
}

interface TraySettings {
	openAtLogin: boolean;
	startHidden: boolean;
	notifyOnDone: boolean;
}

// True on macOS (the only platform with a Dock to hide). Checked in the
// renderer so the section never renders where it makes no sense.
function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac/i.test(navigator.userAgent || "");
}

// The plastic toggle switch used by every row below.
function Switch({
	checked,
	disabled,
	label,
	onToggle,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={onToggle}
			className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
				checked
					? "border-sky-600/50 bg-gradient-to-b from-sky-500 to-sky-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25),0_1px_3px_rgba(14,165,233,0.4)]"
					: "border-slate-500/40 bg-gradient-to-b from-[#c6cfda] to-[#a7b3c0] shadow-[inset_0_2px_3px_rgba(15,23,42,0.25)] dark:border-slate-600/60 dark:from-[#39424f] dark:to-[#262e39] dark:shadow-[inset_0_2px_3px_rgba(0,0,0,0.5)]"
			}`}
		>
			<span
				className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-all ${
					checked ? "left-[24px]" : "left-[3px]"
				}`}
			/>
		</button>
	);
}

// The "Menu Bar" section inside the Settings sheet. An opt-in toggle for
// menu-bar-only mode: the Dock icon hides, an SCM icon lives in the menu
// bar (left-click toggles the window, right-click opens Open / Import /
// Settings / Quit plus live library + AI status), closing the window hides
// it there instead of quitting, and Quit happens from the menu-bar icon.
// Everything applies live via the main process — no restart needed.
export default function MenuBarPanel({
	onNotify,
	hideHeader = false,
}: MenuBarPanelProps) {
	const [enabled, setEnabled] = useState(false);
	const [tray, setTray] = useState<TraySettings>({
		openAtLogin: false,
		startHidden: false,
		notifyOnDone: true,
	});
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);

	// Load the persisted mode + companion settings on mount.
	useEffect(() => {
		let cancelled = false;
		void Promise.all([
			window.memories.getMenuBarOnly().catch(() => false),
			window.memories.getTraySettings().catch(() => ({
				openAtLogin: false,
				startHidden: false,
				notifyOnDone: true,
			})),
		]).then(([menuBarOnly, traySettings]) => {
			if (cancelled) return;
			setEnabled(menuBarOnly === true);
			setTray(traySettings);
			setLoaded(true);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const toggleMode = useCallback(() => {
		if (saving) return;
		const next = !enabled;
		setSaving(true);
		void window.memories
			.setMenuBarOnly(next)
			.then((res) => {
				if (res.ok) {
					setEnabled(res.enabled ?? next);
					onNotify(
						next
							? "Menu bar only — SCM hid from the Dock. Click the menu-bar icon to toggle the window; quit from its menu."
							: "Dock icon restored",
						"success",
					);
				} else {
					onNotify(res.error ?? "Could not change menu-bar mode", "warning");
				}
			})
			.catch(() => {
				onNotify("Could not change menu-bar mode", "warning");
			})
			.finally(() => {
				setSaving(false);
			});
	}, [enabled, saving, onNotify]);

	const saveTrayPatch = useCallback(
		(patch: Partial<TraySettings>, successMessage: string) => {
			if (saving) return;
			setSaving(true);
			void window.memories
				.setTraySettings(patch)
				.then((res) => {
					if (res.ok && res.settings) {
						setTray(res.settings);
						onNotify(successMessage, "success");
					} else {
						onNotify(res.error ?? "Could not save setting", "warning");
					}
				})
				.catch(() => {
					onNotify("Could not save setting", "warning");
				})
				.finally(() => {
					setSaving(false);
				});
		},
		[saving, onNotify],
	);

	// The Dock is a macOS concept — render nothing elsewhere.
	if (!isMac()) return null;

	const busy = !loaded || saving;

	return (
		<div>
			{/* Section header */}
			{!hideHeader && (
				<div className="flex items-center gap-3 px-1 pb-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-500/30 bg-white/40 dark:border-slate-600/50 dark:bg-black/25">
						<IconLayoutNavbar
							size={18}
							className="text-zinc-500 dark:text-zinc-400"
							aria-hidden="true"
						/>
					</div>
					<div className="min-w-0">
						<p className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
							Menu Bar
						</p>
						<p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">
							Run SCM from the menu bar, hide the Dock icon
						</p>
					</div>
				</div>
			)}

			{/* Inner bezel */}
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
				<div className="flex items-center justify-between gap-4">
					<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
						<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							Menu bar only
						</span>
						Hide SCM from the Dock and keep it in the menu bar. Closing the
						window hides it there instead of quitting.
					</p>
					<Switch
						checked={enabled}
						disabled={busy}
						label="Run from menu bar only"
						onToggle={toggleMode}
					/>
				</div>

				<div className="my-3 border-t border-slate-500/20 dark:border-slate-600/30" />

				<div className="flex flex-col gap-3.5">
					<div className="flex items-center justify-between gap-4">
						<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
							<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
								Open at login
							</span>
							<span className="block text-[13px] text-zinc-500 dark:text-zinc-400">
								Start SCM when you sign in
							</span>
						</p>
						<Switch
							checked={tray.openAtLogin}
							disabled={busy}
							label="Open at login"
							onToggle={() =>
								saveTrayPatch(
									{ openAtLogin: !tray.openAtLogin },
									tray.openAtLogin
										? "SCM won't open at login"
										: "SCM will open at login",
								)
							}
						/>
					</div>

					<div className="flex items-center justify-between gap-4">
						<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
							<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
								Start hidden
							</span>
							<span className="block text-[13px] text-zinc-500 dark:text-zinc-400">
								{enabled
									? "Boot straight to the menu bar, no window"
									: "Needs menu-bar-only mode above"}
							</span>
						</p>
						<Switch
							checked={tray.startHidden}
							disabled={busy || !enabled}
							label="Start hidden"
							onToggle={() =>
								saveTrayPatch(
									{ startHidden: !tray.startHidden },
									tray.startHidden
										? "SCM will show its window at launch"
										: "SCM will start hidden in the menu bar",
								)
							}
						/>
					</div>

					<div className="flex items-center justify-between gap-4">
						<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
							<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
								Notify when finished
							</span>
							<span className="block text-[13px] text-zinc-500 dark:text-zinc-400">
								Ping when background work ends while hidden
							</span>
						</p>
						<Switch
							checked={tray.notifyOnDone}
							disabled={busy}
							label="Notify when background work finishes"
							onToggle={() =>
								saveTrayPatch(
									{ notifyOnDone: !tray.notifyOnDone },
									tray.notifyOnDone
										? "Completion notifications off"
										: "Completion notifications on",
								)
							}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
