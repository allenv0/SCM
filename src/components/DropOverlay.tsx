"use client";

import { IconPhotoPlus } from "@tabler/icons-react";

export default function DropOverlay() {
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md"
		>
			<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_24px_50px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_18px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-10px_18px_rgba(0,0,0,0.5)] sm:rounded-[1.6rem] sm:p-3">
				<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.6rem]" />
				<div className="pointer-events-none absolute inset-x-4 top-0.5 h-3 rounded-full bg-white/50 blur-md dark:bg-white/8" />
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-2xl bg-gradient-to-t from-black/15 to-transparent sm:rounded-b-[1.6rem]" />

				<div className="relative flex flex-col items-center gap-4 rounded-xl border border-slate-500/45 bg-[#edf2f8] px-12 py-10 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-2px_4px_rgba(15,23,42,0.15)] dark:border-slate-600/70 dark:bg-[#0a0a0a] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_6px_rgba(0,0,0,0.5)] sm:rounded-2xl sm:p-14">
					<div className="flex h-16 w-16 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)]">
						<IconPhotoPlus
							size={28}
							className="text-zinc-700 dark:text-zinc-300"
						/>
					</div>
					<div>
						<p className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
							Drop photos or folders to index them
						</p>
						<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
							They’ll be AI-indexed locally with CLIP and added to your memories
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
