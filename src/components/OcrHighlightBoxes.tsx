"use client";

import type { OcrWordBox } from "@/lib/ocrHighlights";

// A hit box in the top sliver of the image has no room above it for the
// word chip — flip the chip below the box instead.
const FLIP_THRESHOLD = 0.08;
// Boxes this far right anchor their chip by its right edge, so a long word
// label grows leftward instead of spilling past the image.
const RIGHT_ANCHOR_THRESHOLD = 0.75;
// Padding (in normalized 0–1 coordinates) added around each OCR word box
// so the amber frame doesn't hug the text edge-to-edge. Keeps visual
// breathing room on both the grid tile and the lightbox.
const BOX_PAD = 0.012;
// Minimum box height after padding — tiny OCR fragments (a lone "i" or
// punctuation) get a readable floor so the frame is always visible.
const MIN_H = 0.024;

interface OcrHighlightBoxesProps {
	// Literal OCR matches for the active query, in normalized image
	// coordinates. Must sit inside a `relative` container that wraps the
	// image exactly (grid tile inner bezel, lightbox image wrapper).
	words?: OcrWordBox[];
}

// Annotation-style overlay for search-result OCR hits: an amber outline over
// the exact word plus a small chip labeling WHICH word matched, so a search
// for "AI" explains itself on both the grid tile and the opened photo.
export default function OcrHighlightBoxes({
	words = [],
}: OcrHighlightBoxesProps) {
	return (
		<>
			{words.map((word, index) => {
				const anchorRight = word.x + word.w > RIGHT_ANCHOR_THRESHOLD;
				const flipBelow = word.y < FLIP_THRESHOLD;
				// Expand the box outward by BOX_PAD and enforce a minimum
				// height so even tiny OCR fragments get a visible frame.
				const x = Math.max(0, word.x - BOX_PAD);
				const y = Math.max(0, word.y - BOX_PAD);
				const w = Math.min(1 - x, word.w + BOX_PAD * 2);
				const h = Math.max(MIN_H, Math.min(1 - y, word.h + BOX_PAD * 2));
				return (
					<span
						key={`${word.text}-${word.x}-${word.y}-${index}`}
						data-search-highlight={word.text}
						aria-hidden="true"
						className="pointer-events-none absolute z-20"
						style={{
							left: `${x * 100}%`,
							top: `${y * 100}%`,
							width: `${w * 100}%`,
							height: `${h * 100}%`,
						}}
					>
						{/* Outer glow + border */}
						<span className="absolute inset-0 rounded-[0.35rem] border-[2.5px] border-amber-300/90 bg-amber-300/15 shadow-[0_0_0_1px_rgba(69,26,3,0.35),0_0_16px_2px_rgba(251,191,36,0.7)]" />
						{/* Word label chip */}
						<span
							className={`absolute ${anchorRight ? "right-0" : "left-0"} ${
								flipBelow ? "top-full mt-1" : "bottom-full mb-1"
							} block max-w-[40vw] truncate whitespace-nowrap rounded-md bg-amber-300/95 px-2 py-[3px] text-[11px] font-semibold leading-none text-amber-950 shadow-[0_2px_8px_rgba(69,26,3,0.5)] backdrop-blur-sm`}
						>
							{word.text}
						</span>
					</span>
				);
			})}
		</>
	);
}
