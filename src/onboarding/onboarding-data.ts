// First-run onboarding content — extracted from scm-website/
// (src/components/Hero.astro + src/components/Showcase.astro + src/pages/index.astro).
// The three channels are the website's A/B/C CRT channels verbatim: same
// video, same poster, same ticker label + intro text.

export interface OnboardingChannel {
	id: "A" | "B" | "C";
	/** Ticker badge / channel tag (VT323, uppercase). */
	label: string;
	/** Short title for the step card below the CRT. */
	title: string;
	/** Intro text — the channel's ticker copy. */
	text: string;
	video: string;
	poster: string;
	/** Phosphor accent per channel (matches the website's ticker themes). */
	color: string;
}

export const ONBOARDING_CHANNELS: OnboardingChannel[] = [
	{
		id: "A",
		label: "VISION AI",
		title: "Search inside your photos and videos",
		text: "Finds the exact details inside your photos and videos. A search surfaces the right scenes, not just the right files.",
		video: "/onboarding/scm-demo.mp4",
		poster: "/onboarding/poster-a.webp",
		color: "#b4ffcc",
	},
	{
		id: "B",
		label: "Deep OCR",
		title: "Every word, searchable",
		text: "Makes every word across your photo library instantly searchable",
		video: "/onboarding/scm-demo2.mp4",
		poster: "/onboarding/poster-b.webp",
		color: "#ffd47a",
	},
	{
		id: "C",
		label: "CUSTOM UI",
		title: "Pin your favorite searches",
		text: "A customizable tab bar for pinning and jumping between your favorite searches",
		video: "/onboarding/scm-demo3.mp4",
		poster: "/onboarding/poster-c.webp",
		color: "#7ab8ff",
	},
];

export const ONBOARDING_HEADLINE = {
	fringe: "Deep AI Search for",
	highlight: "Every Photo and Every Frame of Video",
	sub: "100% local on your Mac — no cloud, no uploads.",
} as const;
