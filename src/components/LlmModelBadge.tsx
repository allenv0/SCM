"use client";

import type { LlmModelInfo } from "@/types";

interface LlmModelBadgeProps {
	/** The active chat model behind the LLMs tab (null = still loading). */
	model: LlmModelInfo | null;
}

// The current-model chip beside the LLMs pill (MDs/Ask-Mode-Plan.md): a
// phosphor-LCD cousin of the answer card — glowing status dot, mono label,
// download size. Display-only (no Settings deep-link is drilled this far);
// the title tooltip carries the full story. The aria-label doubles as the
// E2E hook asserting the badge follows the enabled toggle live.
export default function LlmModelBadge({ model }: LlmModelBadgeProps) {
	if (!model) return null;
	const gb = `${(model.sizeBytes / 1e9).toFixed(1)}GB`;
	const ready = model.downloaded === true;
	return (
		<span
			role="status"
			aria-label={`Current LLMs model: ${model.label}`}
			title={
				`${model.label} · ${gb} · ${(model.ctxTokens / 1024).toFixed(0)}K context` +
				(ready
					? " · runs on this machine — answers never leave it."
					: " · not downloaded yet — Settings → LLMs Chat.")
			}
			className="ml-1 flex cursor-default items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2.5 py-1 font-mono text-[10px] text-zinc-100 shadow-[inset_0_0_12px_rgba(84,255,138,0.05),0_1px_4px_rgba(0,0,0,0.35)]"
		>
			<span
				aria-hidden="true"
				className={`inline-block h-1.5 w-1.5 rounded-full ${
					ready
						? "bg-[var(--ai-ready)] shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.9)]"
						: "bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.9)]"
				}`}
			/>
			{model.label}
			<span className="text-zinc-400">{gb}</span>
		</span>
	);
}
