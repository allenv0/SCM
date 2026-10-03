"use client";

import { useEffect, useRef } from "react";
import {
	IconArrowUpRight,
	IconFolderOpen,
	IconScreenshot,
	IconTrash,
} from "@tabler/icons-react";

interface TileContextMenuProps {
	x: number;
	y: number;
	filename: string;
	/** The tile's current tab bucket — picks the toggle's label and hides it
	 *  for videos (they live in the Videos tab regardless). */
	category: string;
	onOpen: () => void;
	onReveal: () => void;
	onDelete: () => void;
	/** Manual Screenshots override: the caller applies the INVERSE of the
	 *  current category. */
	onToggleScreenshot: () => void;
	onClose: () => void;
}

// Custom right-click menu for a grid tile. Position is set by the parent
// (already clamped to the viewport); this component owns the plastic-shell
// chrome that matches the rest of the app and the tile actions.
export default function TileContextMenu({
	x,
	y,
	filename,
	category,
	onOpen,
	onReveal,
	onDelete,
	onToggleScreenshot,
	onClose,
}: TileContextMenuProps) {
	const handle = (fn: () => void) => () => {
		fn();
		onClose();
	};

	const menuRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	// Silence unused: the ref marks the menu root for tests/AT queries.
	void menuRef;

	// Move focus into the menu on open so keyboard users aren't stranded
	// outside; arrow keys cycle menu items; Escape closes (parent handler).
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			itemRefs.current[0]?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, []);

	const moveItem = (from: number, delta: number) => {
		const items = itemRefs.current.filter(
			(el): el is HTMLButtonElement => el != null,
		);
		if (!items.length) return;
		const next = (from + delta + items.length) % items.length;
		items[next]?.focus();
	};

	const isScreenshot = category === "Screenshots";

	return (
		<div
			ref={menuRef}
			className="animate-scale-in fixed z-[65] w-52"
			style={{ left: x, top: y }}
			role="menu"
			aria-label="Tile actions"
			onContextMenu={(e) => e.preventDefault()}
			onKeyDown={(e) => {
				const items = itemRefs.current.filter(
					(el): el is HTMLButtonElement => el != null,
				);
				const active = document.activeElement;
				const idx = items.findIndex((el) => el === active);
				if (e.key === "ArrowDown") {
					e.preventDefault();
					moveItem(idx < 0 ? 0 : idx, 1);
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					moveItem(idx < 0 ? 0 : idx, -1);
				} else if (e.key === "Home") {
					e.preventDefault();
					items[0]?.focus();
				} else if (e.key === "End") {
					e.preventDefault();
					items[items.length - 1]?.focus();
				}
			}}
		>
			{/* Outer shell */}
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-1.5 shadow-[0_18px_40px_rgba(15,23,42,0.35),inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_18px_40px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.1)]">
				{/* Plastic grain + shell highlight */}
				<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl" />
				<div className="pointer-events-none absolute inset-x-4 top-0.5 h-3 rounded-full bg-white/50 blur-md dark:bg-white/10" />

				{/* Inner bezel */}
				<div className="relative rounded-xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-1 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
					{/* Which memory this menu acts on */}
					<div className="border-b border-slate-500/30 px-3 py-2 dark:border-slate-600/40">
						<p className="truncate text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
							{filename}
						</p>
					</div>

					<div className="p-1">
						<button
							type="button"
							role="menuitem"
							ref={(el) => {
								itemRefs.current[0] = el;
							}}
							data-autofocus
							onClick={handle(onOpen)}
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-700 transition-colors hover:bg-white/70 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
						>
							<IconArrowUpRight
								size={15}
								className="shrink-0 text-zinc-500 dark:text-zinc-400"
								aria-hidden="true"
							/>
							Open
						</button>
						<button
							type="button"
							role="menuitem"
							ref={(el) => {
								itemRefs.current[1] = el;
							}}
							onClick={handle(onReveal)}
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-700 transition-colors hover:bg-white/70 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
						>
							<IconFolderOpen
								size={15}
								className="shrink-0 text-zinc-500 dark:text-zinc-400"
								aria-hidden="true"
							/>
							Show in Finder
						</button>

						{/* Manual Screenshots override — the escape hatch when the
						    automatic classification misses (a renamed screenshot)
						    or over-fires. Hidden for videos: they always live in
						    the Videos tab. */}
						{category !== "Videos" && (
							<button
								type="button"
								role="menuitem"
								ref={(el) => {
									itemRefs.current[2] = el;
								}}
								onClick={handle(onToggleScreenshot)}
								className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-700 transition-colors hover:bg-white/70 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
							>
								<IconScreenshot
									size={15}
									className="shrink-0 text-zinc-500 dark:text-zinc-400"
									aria-hidden="true"
								/>
								{isScreenshot
									? "Remove from Screenshots"
									: "Add to Screenshots"}
							</button>
						)}

						<div className="mx-2 my-1 h-px bg-slate-500/30 dark:bg-slate-600/40" />

						<button
							type="button"
							role="menuitem"
							ref={(el) => {
								itemRefs.current[3] = el;
							}}
							onClick={handle(onDelete)}
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300"
						>
							<IconTrash
								size={15}
								className="text-red-500/80 dark:text-red-400/80"
								aria-hidden="true"
							/>
							Delete
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
