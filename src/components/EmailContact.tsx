"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy, IconSend } from "@tabler/icons-react";

// Shared contact-sheet primitives for every surface that renders addresses
// read off a photo (the Email-tab tile overlay, the lightbox sheet). One
// module so the row layout, copy feedback, and card-event hygiene stay
// identical everywhere: all interactive elements stopPropagation so they
// never trigger the tile's open-lightbox click.
//
// Design language: deliberately minimal — dark glass over photos in both
// themes (photo-legibility wins over theme matching), mono addresses, two
// quiet action buttons. No avatars, no color-coding.

/** Swallow tile-level mouse handling so controls on a card never bubble into
 *  the card's own open-lightbox / context-menu handlers. */
export function stopCardEvent(e: React.SyntheticEvent): void {
	e.stopPropagation();
}

// One-tap copy with a check-flip confirmation. Clipboard failure still flips
// (best-effort in older contexts) — the button never reads as broken.
export function CopyEmailButton({
	email,
	compact = false,
}: {
	email: string;
	compact?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const copy = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(email);
		} catch {
			/* clipboard is best-effort — still flip */
		}
		setCopied(true);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1500);
	};
	const dims = compact ? "h-6 w-6" : "h-7 w-7";
	return (
		<button
			type="button"
			aria-label={copied ? `Copied ${email}` : `Copy ${email}`}
			title={copied ? "Copied" : "Copy email"}
			onClick={(e) => void copy(e)}
			onPointerDown={stopCardEvent}
			className={`flex ${dims} shrink-0 items-center justify-center rounded-lg border backdrop-blur-sm transition-all duration-200 active:scale-95 ${
				copied
					? "border-emerald-300/50 bg-emerald-400/25 text-emerald-100"
					: "border-white/25 bg-white/10 text-white/85 hover:bg-white/25 hover:text-white"
			}`}
		>
			{copied ? (
				<IconCheck
					size={compact ? 12 : 13}
					strokeWidth={2.5}
					aria-hidden="true"
				/>
			) : (
				<IconCopy size={compact ? 12 : 13} strokeWidth={2} aria-hidden="true" />
			)}
		</button>
	);
}

// Compose in the OS mail client. An anchor (not a button) so middle-click /
// long-press keep their native meaning; stopPropagation keeps a tile click
// from opening the lightbox underneath.
export function ComposeEmailButton({
	email,
	compact = false,
}: {
	email: string;
	compact?: boolean;
}) {
	const dims = compact ? "h-6 w-6" : "h-7 w-7";
	return (
		<a
			href={`mailto:${email}`}
			aria-label={`Compose email to ${email}`}
			title={`Compose email to ${email}`}
			onClick={stopCardEvent}
			onPointerDown={stopCardEvent}
			className={`flex ${dims} shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/10 text-white/85 backdrop-blur-sm transition-all duration-200 hover:bg-white/25 hover:text-white active:scale-95`}
		>
			<IconSend size={compact ? 12 : 13} strokeWidth={2} aria-hidden="true" />
		</a>
	);
}

// One address row: truncating mono address + copy + compose. The row itself
// is inert (clicks pass through to the tile); only the two action controls
// capture events. evidenceTitle (the detector's "found as" line) replaces
// the plain address tooltip when provided.
export function EmailRow({
	email,
	compact = false,
	evidenceTitle,
}: {
	email: string;
	compact?: boolean;
	evidenceTitle?: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<span
				title={evidenceTitle ?? email}
				className={`min-w-0 flex-1 truncate font-mono font-medium text-white ${
					compact ? "text-[11px]" : "text-xs"
				}`}
			>
				{email}
			</span>
			<CopyEmailButton email={email} compact={compact} />
			<ComposeEmailButton email={email} compact={compact} />
		</div>
	);
}
