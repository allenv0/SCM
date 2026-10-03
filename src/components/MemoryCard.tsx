"use client";

import { useState } from "react";
import {
	IconChevronDown,
	IconChevronUp,
	IconEye,
	IconFileText,
	IconMail,
	IconTextScan2,
} from "@tabler/icons-react";
import { CopyEmailButton, EmailRow, stopCardEvent } from "./EmailContact";
import { formatEmailEvidence, type EmailMatch } from "@/lib/emailAddress";
import {
	isVideoFile,
	posterFor,
	scenePosterFor,
	formatTimecode,
	thumbFor,
} from "@/lib/media";
import type { SceneMatch } from "@/lib/memoryRank";
import type { ScoreBreakdown } from "@/lib/memoryRank";
import type { OcrWordBox } from "@/lib/ocrHighlights";
import {
	MATCH_TONES,
	MATCH_TONE_FALLBACK,
	type MatchDominant,
} from "@/lib/matchTone";
import OcrHighlightBoxes from "./OcrHighlightBoxes";
import ScoreBreakdownTooltip from "./ScoreBreakdownTooltip";

// Icon per match label — the badge's quick-glance identifier.
const MATCH_ICONS: Record<string, typeof IconEye> = {
	"Visual match": IconEye,
	"Text on photo": IconTextScan2,
	"Filename match": IconFileText,
	"Exact line": IconTextScan2,
	"Exact words": IconTextScan2,
	"Words spoken": IconTextScan2,
	"Speech match": IconTextScan2,
};

// Render a transcript snippet with the matched word highlighted (exact
// dialogue hits). Strings render as React children, so content is escaped;
// the offsets come from the main-process snippet window.
function SpeechSnippet({
	snippet,
	matchStart,
	matchLen,
}: {
	snippet: string;
	matchStart?: number;
	matchLen?: number;
}) {
	const start = Math.max(0, matchStart ?? 0);
	const len = Math.max(0, matchLen ?? 0);
	if (start >= snippet.length || len === 0) {
		return <span>{snippet}</span>;
	}
	const end = Math.min(snippet.length, start + len);
	return (
		<span>
			{snippet.slice(0, start)}
			<mark className="rounded-sm bg-[var(--ai-ready)]/30 px-0.5 font-medium text-emerald-950 dark:bg-[var(--ai-ready)]/40 dark:font-normal dark:text-inherit">
				{snippet.slice(start, end)}
			</mark>
			{snippet.slice(end)}
		</span>
	);
}

interface MemoryCardProps {
	image: string;
	priority?: boolean;
	onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
	onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
	/** The virtualized grid renders opaque immediately for filenames that
	 *  have loaded at least once this session, so scrolling back past a
	 *  card doesn't replay the load fade (the card remounts on scroll). */
	forceVisible?: boolean;
	/** Called once the image resolved (loaded, or failed permanently) — lets
	 *  the virtualizer remember the card is ready for forceVisible. */
	onLoaded?: (filename: string) => void;
	// Best-matching shot segment from a search (Phase 2 of scene search).
	// When present the card swaps to the scene poster and shows a timecode
	// badge; the search result's video opens at this moment.
	bestScene?: SceneMatch | null;
	// Literal OCR matches for the active query, positioned as normalized
	// image coordinates. Semantic-only matches intentionally carry none.
	highlightedWords?: OcrWordBox[];
	// One-line "why it matched" label shown on each card.
	matchReason?: string;
	// Which signal won — drives the badge tone + tooltip accent.
	dominant?: MatchDominant | null;
	// Score components for the hover tooltip.
	matchBreakdown?: ScoreBreakdown;
	/** Cleaned addresses read off the photo's OCR text (first-seen order,
	 *  capped). Rendered as a glass contact strip only when
	 *  showEmailOverlay is true (the Email tab) — every other tab keeps
	 *  the pure photo tile. */
	emailAddresses?: string[];
	/** Match evidence behind emailAddresses (same order): "found as" tooltips. */
	emailMatches?: EmailMatch[];
	/** True on the Email tab: overlay the extracted address strip. */
	showEmailOverlay?: boolean;
}

// Email-tab contact sheet — the reason this photo is in the tab, made
// scannable without opening the lightbox. Collapsed: a one-line glass pill
// (envelope medallion + mono address + one-tap copy). Multi-address photos grow
// a +N toggle that expands into the full per-address sheet (copy + compose
// per row) — still INSIDE the bezel, so the 4:3 tile geometry the
// virtualizer measures never changes. Dark glass in both themes: it sits
// over photos, not UI chrome, so photo-legibility wins over theme matching.
function EmailOverlay({
	addresses,
	matches = [],
}: {
	addresses: string[];
	matches?: EmailMatch[];
}) {
	const [expanded, setExpanded] = useState(false);
	const primary = addresses[0];
	const extra = addresses.length - 1;
	const evidence = new Map(matches.map((m) => [m.address, m]));
	const evidenceTitle = (email: string): string => {
		const match = evidence.get(email);
		return match ? formatEmailEvidence(match) : email;
	};
	return (
		<>
			{/* Legibility scrim under the sheet */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-black/60 via-black/25 to-transparent" />
			<div className="absolute inset-x-2 bottom-2 z-20">
				{!expanded ? (
					<div
						title={addresses.map(evidenceTitle).join("\n")}
						className="flex items-center gap-2 rounded-xl border border-white/25 bg-gradient-to-b from-slate-900/90 to-slate-900/70 py-1.5 pl-1.5 pr-1.5 shadow-[0_4px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-md transition-colors duration-200 group-hover:border-white/35"
					>
						{/* Envelope medallion — neutral chrome, not an avatar */}
						<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-sky-400 to-sky-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_2px_6px_rgba(14,165,233,0.5)] ring-1 ring-inset ring-white/30">
							<IconMail
								size={14}
								strokeWidth={2.2}
								className="text-white"
								aria-hidden="true"
							/>
						</span>
						{/* Address stack: eyebrow label + mono address */}
						<span className="flex min-w-0 flex-1 flex-col leading-none">
							<span className="text-[8px] font-bold uppercase tracking-[0.14em] text-sky-200/80">
								Email on photo
							</span>
							<span className="mt-0.5 truncate font-mono text-[11px] font-medium text-white">
								{primary}
							</span>
						</span>
						{extra > 0 && (
							<button
								type="button"
								aria-expanded={false}
								aria-label={`Show all ${addresses.length} email addresses`}
								title={addresses.slice(1).join("\n")}
								onClick={(e) => {
									e.stopPropagation();
									setExpanded(true);
								}}
								onPointerDown={stopCardEvent}
								className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/20 bg-white/10 px-1.5 py-1 text-[9px] font-bold tabular-nums text-white/85 transition-colors duration-200 hover:bg-white/25 hover:text-white"
							>
								+{extra}
								<IconChevronUp size={11} strokeWidth={2.5} aria-hidden="true" />
							</button>
						)}
						<CopyEmailButton email={primary} />
					</div>
				) : (
					<div
						role="dialog"
						aria-label={`${addresses.length} email addresses on this photo`}
						onClick={stopCardEvent}
						onPointerDown={stopCardEvent}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setExpanded(false);
							}
						}}
						className="max-h-[calc(100%-0.5rem)] overflow-y-auto rounded-xl border border-white/25 bg-gradient-to-b from-slate-900/95 to-slate-900/80 p-2 shadow-[0_4px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-md"
					>
						<div className="mb-1.5 flex items-center justify-between px-0.5">
							<span className="text-[8px] font-bold uppercase tracking-[0.14em] text-sky-200/80">
								{addresses.length} emails on photo
							</span>
							<button
								type="button"
								aria-expanded={true}
								aria-label="Collapse email list"
								title="Collapse"
								onClick={(e) => {
									e.stopPropagation();
									setExpanded(false);
								}}
								onPointerDown={stopCardEvent}
								className="flex h-5 w-5 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white/85 transition-colors duration-200 hover:bg-white/25 hover:text-white"
							>
								<IconChevronDown
									size={12}
									strokeWidth={2.5}
									aria-hidden="true"
								/>
							</button>
						</div>
						<div className="flex flex-col gap-1">
							{addresses.map((email) => (
								<div
									key={email}
									className="rounded-lg px-1 py-0.5 transition-colors duration-150 hover:bg-white/10"
								>
									<EmailRow
										email={email}
										compact
										evidenceTitle={evidenceTitle(email)}
									/>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</>
	);
}

export default function MemoryCard({
	image,
	priority = false,
	onClick,
	onContextMenu,
	forceVisible = false,
	onLoaded,
	bestScene = null,
	highlightedWords = [],
	matchReason,
	dominant,
	matchBreakdown,
	emailAddresses = [],
	emailMatches = [],
	showEmailOverlay = false,
}: MemoryCardProps) {
	const [isLoaded, setIsLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	// Scene-poster swap falls back to the default poster on a missing file.
	const [useScenePoster, setUseScenePoster] = useState(true);
	const video = isVideoFile(image);
	const tone = matchReason
		? (MATCH_TONES[matchReason] ?? MATCH_TONE_FALLBACK)
		: MATCH_TONE_FALLBACK;
	const BadgeIcon = matchReason ? MATCH_ICONS[matchReason] : undefined;
	const sceneSrc =
		video && bestScene ? scenePosterFor(image, bestScene.poster) : null;
	const src = video
		? sceneSrc && useScenePoster
			? sceneSrc
			: posterFor(image)
		: thumbFor(image);

	// Keyboard activation: parent handlers check e.button / e.ctrlKey, so
	// synthesize a plain left-click (button 0) for Enter/Space.
	const activate = () => {
		if (!onClick) return;
		onClick({
			button: 0,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			shiftKey: false,
		} as React.MouseEvent<HTMLDivElement>);
	};

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onContextMenu={onContextMenu}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					activate();
				} else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
					e.preventDefault();
					const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
					onContextMenu?.({
						preventDefault: () => undefined,
						clientX: rect.left + rect.width / 2,
						clientY: rect.top + rect.height / 2,
						ctrlKey: false,
					} as unknown as React.MouseEvent<HTMLDivElement>);
				}
			}}
			className={`group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-1 shadow-[0_8px_20px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.9)] transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_12px_28px_rgba(15,23,42,0.22),inset_0_1px_0_rgba(255,255,255,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_10px_24px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)] dark:hover:shadow-[0_14px_32px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.1)] sm:rounded-[1.2rem] ${
				isLoaded || forceVisible ? "opacity-100" : "opacity-0"
			} animate-fade-in`}
		>
			{/* The card's media is an exact 4:3 box: the img declares
			    aspect-[4/3] so every tile has the SAME rendered height at a
			    given column width (object-cover crops the content). The
			    virtualized grid depends on this — row height = column width
			    × ¾ + the card shell, no per-item measurement needed. */}
			{/* Plastic grain texture */}
			<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.2rem]" />

			{/* Shell highlight */}
			<div className="dark:bg-white/8 pointer-events-none absolute inset-x-4 top-0.5 h-3 rounded-full bg-white/50 blur-md" />

			{/* Inner bezel */}
			<div className="relative overflow-hidden rounded-xl border border-slate-500/45 bg-[#edf2f8] shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-2px_4px_rgba(15,23,42,0.15)] dark:border-slate-600/70 dark:bg-[#0a0a0a] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_6px_rgba(0,0,0,0.5)] sm:rounded-[1rem]">
				{failed ? (
					<div className="flex aspect-[4/3] w-full items-center justify-center bg-zinc-300/70 p-4 text-center text-xs font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-500">
						Photo missing
					</div>
				) : (
					<img
						src={src}
						alt={`Memory: ${image.split(".")[0]}`}
						width={800}
						height={600}
						loading={priority ? "eager" : "lazy"}
						decoding={priority ? "sync" : "async"}
						className="aspect-[4/3] h-auto w-full object-cover transition-transform duration-300 group-hover:scale-105"
						onLoad={() => {
							setIsLoaded(true);
							onLoaded?.(image);
						}}
						onError={() => {
							if (video && sceneSrc && useScenePoster) {
								// Scene poster missing — degrade to the default poster
								// before declaring the tile broken.
								setUseScenePoster(false);
								setIsLoaded(true);
							} else {
								setFailed(true);
								setIsLoaded(true);
							}
							onLoaded?.(image);
						}}
					/>
				)}

				{/* Query hit boxes sit over the exact OCR words rather than the
			    whole photo. This makes a text search for "AI" immediately
			    explain why a screenshot or poster was returned. */}
				{!video && <OcrHighlightBoxes words={highlightedWords} />}

				{/* "Why it matched" badge — one line explaining the dominant
				    signal, tinted toward that signal's hue. Wraps in a tooltip
				    group so hovering reveals the full score breakdown without
				    any React state. */}
				{matchReason && (
					<div className="group/tooltip pointer-events-none absolute top-3 left-3 z-10">
						<div
							className={`flex items-center gap-1 rounded-full border px-1.5 py-[2px] shadow-[0_1px_3px_rgba(0,0,0,0.4)] backdrop-blur-md ${tone.pill}`}
						>
							{BadgeIcon && (
								<BadgeIcon size={9} strokeWidth={2.5} className={tone.icon} />
							)}
							<span className="text-[8px] font-semibold tracking-[0.02em] text-white/90">
								{matchReason}
							</span>
						</div>
						{matchBreakdown && (
							<ScoreBreakdownTooltip
								breakdown={matchBreakdown}
								dominant={dominant}
							/>
						)}
					</div>
				)}

				{showEmailOverlay && emailAddresses.length > 0 && (
					<EmailOverlay addresses={emailAddresses} matches={emailMatches} />
				)}
			</div>

			{/* Best-scene badge (search results only). Fusion adds a CC dot
		    + snippet tooltip when speech evidence contributed. Exact
		    dialogue hits also render the spoken line under the badge with
		    the matched word highlighted. */}
			{bestScene && (
				<div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1">
					<div
						data-scene-badge
						data-scene-why={bestScene.why ?? "visual"}
						data-scene-tier={bestScene.tier ?? ""}
						title={
							bestScene.tierLabel && bestScene.snippet
								? `${bestScene.tierLabel} — “${bestScene.snippet}”`
								: (bestScene.snippet ?? undefined)
						}
						className="flex items-center gap-1.5 rounded-full border border-[rgba(144,255,169,0.25)] bg-black/60 px-2.5 py-1 shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
					>
						<span className="h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] shadow-[0_0_6px_rgba(var(--ai-ready-rgb),0.9)]" />
						<span className="phosphor-text text-[10px] font-semibold uppercase tracking-wider">
							Scene @ {formatTimecode(bestScene.t)}
							{(bestScene.why === "text" || bestScene.why === "both") && (
								<span className="ml-1 rounded-sm border border-white/20 bg-white/10 px-1 text-[9px]">
									CC
								</span>
							)}
						</span>
					</div>
					{bestScene.snippet && (
						<div
							data-speech-snippet
							className="phosphor-text line-clamp-2 rounded-md bg-black/60 px-2 py-1 text-[10px] leading-snug"
						>
							<SpeechSnippet
								snippet={bestScene.snippet}
								matchStart={bestScene.matchStart}
								matchLen={bestScene.matchLen}
							/>
						</div>
					)}
				</div>
			)}

			{/* Play badge on videos */}
			{video && (
				<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/40 bg-black/45 shadow-[0_4px_12px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width={20}
							height={20}
							viewBox="0 0 24 24"
							fill="currentColor"
							className="ml-0.5 text-white"
						>
							<path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
						</svg>
					</div>
				</div>
			)}

			{/* Subtle overlay on hover */}
			<div className="absolute inset-0 rounded-2xl bg-gradient-to-t from-black/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 dark:from-black/40 sm:rounded-[1.2rem]" />

			{/* Click hint */}
			<div className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 opacity-0 shadow-lg backdrop-blur-sm transition-all duration-300 group-hover:opacity-100 dark:bg-black/80">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width={16}
					height={16}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-zinc-600 dark:text-zinc-300"
				>
					<path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8" />
					<path d="M3 16.2V21m0 0h4.8M3 21l6-6" />
				</svg>
			</div>
		</div>
	);
}
