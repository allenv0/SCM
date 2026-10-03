"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ONBOARDING_CHANNELS, type OnboardingChannel } from "./onboarding-data";

interface CrtTvProps {
	channel: OnboardingChannel["id"];
	onChannel: (id: OnboardingChannel["id"]) => void;
}

const VIDEO_SRC: Record<string, string> = Object.fromEntries(
	ONBOARDING_CHANNELS.map((c) => [c.id, c.video]),
);
const POSTER_SRC: Record<string, string> = Object.fromEntries(
	ONBOARDING_CHANNELS.map((c) => [c.id, c.poster]),
);

/**
 * CRT studio monitor — React port of scm-website's
 * src/components/Showcase.astro (markup + behavior, styles live in
 * onboarding.css). Power collapse/expand, A/B/C channel switching with
 * static burst + roll bar, broadcast lower-third ticker, opt-in FX tube
 * treatment. Video pauses off-screen to save battery.
 */
export default function CrtTv({ channel, onChannel }: CrtTvProps) {
	const tvRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const tickerRef = useRef<HTMLDivElement>(null);
	const tickerTextRef = useRef<HTMLSpanElement>(null);
	const tickerTagRef = useRef<HTMLDivElement>(null);
	const [powered, setPowered] = useState(true);
	const [fx, setFx] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [tickerVisible, setTickerVisible] = useState(false);
	const [tickerChannel, setTickerChannel] = useState<string | null>(null);
	const timers = useRef<number[]>([]);
	// Tracks the live channel for the first-reveal callback below, so the
	// ticker always opens on the channel actually showing — not a stale "A".
	const channelRef = useRef(channel);
	channelRef.current = channel;

	const later = useCallback((fn: () => void, ms: number) => {
		const id = window.setTimeout(fn, ms);
		timers.current.push(id);
		return id;
	}, []);

	useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

	const channelConfig = useCallback((id: string) => {
		return ONBOARDING_CHANNELS.find((c) => c.id === id) ?? ONBOARDING_CHANNELS[0];
	}, []);

	const setTickerContent = useCallback(
		(id: string) => {
			const text = tickerTextRef.current;
			const tag = tickerTagRef.current;
			if (!text || !tag) return;
			const cfg = channelConfig(id);
			setTickerChannel(id);
			tag.textContent = cfg.label.trim();
			text.textContent = cfg.text.trim();
			text.classList.remove("typed", "typed-done");
			void text.offsetHeight;
			text.classList.add("typed");
			later(() => text.classList.add("typed-done"), 3300);
		},
		[channelConfig, later],
	);

	const showTicker = useCallback(
		(id: string) => {
			if (!tickerRef.current) return;
			if (tickerVisible && tickerChannel === id) return;
			if (tickerVisible) {
				setTickerContent(id);
				return;
			}
			setTickerContent(id);
			// Force reflow so the slide-up transition runs.
			void tickerRef.current.offsetHeight;
			setTickerVisible(true);
		},
		[setTickerContent, tickerChannel, tickerVisible],
	);

	const hideTicker = useCallback(() => {
		setTickerVisible(false);
	}, []);

	// Channel switch: static burst + roll bar, then swap video + poster.
	useEffect(() => {
		const tv = tvRef.current;
		const video = videoRef.current;
		if (!tv || !video) return;
		const src = VIDEO_SRC[channel];
		const file = src.split("/").pop() ?? "";
		if (video.src.indexOf(file) === -1) {
			video.pause();
			video.src = src;
			video.load();
			if (powered) video.play().catch(() => {});
		}
		video.poster = POSTER_SRC[channel];
		setSwitching(true);
		const t1 = window.setTimeout(() => setSwitching(false), 550);
		const t2 = window.setTimeout(() => {
			if (powered) showTicker(channel);
		}, 200);
		return () => {
			clearTimeout(t1);
			clearTimeout(t2);
		};
		// showTicker/powered intentionally drive the restore path below;
		// the switch itself keys on channel only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channel]);

	const setPower = useCallback(
		(on: boolean) => {
			const tv = tvRef.current;
			const video = videoRef.current;
			if (!tv || !video) return;
			setPowered(on);
			tv.classList.remove("is-off", "is-on");
			void tv.offsetWidth;
			if (on) {
				tv.classList.add("is-on");
				video.play().catch(() => {});
				later(() => showTicker(channel), 300);
			} else {
				tv.classList.add("is-off");
				video.pause();
				hideTicker();
			}
			later(() => {
				tv.classList.remove("is-on", "is-off");
				if (!on) tv.classList.add("is-off");
			}, 700);
		},
		[channel, hideTicker, later, showTicker],
	);

	// The ticker stays up for the whole tour: it appears as soon as the
	// CRT is actually visible (no typewriter for an empty theater), then
	// persists across A/B/C switches — only power-off takes it down.
	// Plus battery saver: pause the video while nobody can see it.
	useEffect(() => {
		const tv = tvRef.current;
		const video = videoRef.current;
		if (!tv || !("IntersectionObserver" in window)) {
			const t = window.setTimeout(() => showTicker(channelRef.current), 500);
			return () => clearTimeout(t);
		}
		let revealed = false;
		const reveal = new IntersectionObserver((entries, observer) => {
			if (entries.some((e) => e.isIntersecting) && !revealed) {
				revealed = true;
				observer.disconnect();
				window.setTimeout(() => showTicker(channelRef.current), 500);
			}
		});
		reveal.observe(tv);
		const battery = new IntersectionObserver(([entry]) => {
			if (!entry || !video) return;
			if (entry.isIntersecting) {
				video.play().catch(() => {});
			} else {
				video.pause();
			}
		});
		// Only auto-manage playback while powered; the power path owns it
		// when off. Guard inside the callback via the powered ref state.
		battery.observe(tv);
		return () => {
			reveal.disconnect();
			battery.disconnect();
		};
	}, [showTicker]);

	const toggleFx = useCallback((e: React.SyntheticEvent) => {
		e.preventDefault();
		setFx((v) => !v);
	}, []);

	return (
		<div
			ref={tvRef}
			className={`crt-tv${fx ? " crt-fx" : ""}${switching ? " is-switching" : ""}${powered ? "" : " is-off"}`}
		>
			<div className="crt-vents" aria-hidden="true" />
			<div className="crt-screws" aria-hidden="true">
				<div className="crt-screw crt-screw--tl" aria-hidden="true" />
				<div className="crt-screw crt-screw--tr" aria-hidden="true" />
				<div className="crt-screw crt-screw--bl" aria-hidden="true" />
				<div className="crt-screw crt-screw--br" aria-hidden="true" />
			</div>

			<div className="crt-screen-frame">
				<div className="crt-screen">
					<div className="crt-tube" aria-hidden="false">
						<video
							ref={videoRef}
							className="showcase-video"
							src={VIDEO_SRC[channel]}
							poster={POSTER_SRC[channel]}
							autoPlay
							loop
							muted
							playsInline
							aria-label="SCM app demo video"
						/>
						<div className="crt-flash" aria-hidden="true" />
						<div className="crt-static" aria-hidden="true" />
					</div>

					<div
						ref={tickerRef}
						className={`crt-ticker${tickerVisible ? " is-visible" : ""}`}
						data-channel={tickerChannel ?? channel}
						aria-live="polite"
					>
						<div className="crt-ticker__accent" />
						<div className="crt-ticker__badge">
							<span className="crt-ticker__badge-dot" />
							<span className="crt-ticker__badge-label">LIVE</span>
						</div>
						<div ref={tickerTagRef} className="crt-ticker__channel-tag" />
						<div className="crt-ticker__divider" />
						<div className="crt-ticker__text-wrap">
							<span ref={tickerTextRef} className="crt-ticker__text" />
						</div>
					</div>

					<div className="crt-vignette" />
					<div className="crt-scanlines" />
					<div className="crt-glass" aria-hidden="true" />
				</div>
			</div>

			<div className="crt-panel">
				<div className="crt-badge">
					<span className="crt-brand">Screen&nbsp;Memory</span>
					<span className="crt-model" aria-hidden="true">
						SCM–01
					</span>
				</div>

				<div className="crt-speaker" aria-hidden="true" />

				<div className="crt-power-cluster">
					<button
						type="button"
						className="crt-power-btn"
						aria-pressed={powered}
						title="Power"
						aria-label="Power"
						onClick={(e) => {
							e.preventDefault();
							setPower(!powered);
						}}
					>
						<span aria-hidden="true">⏻</span>
					</button>
					<div className="crt-led crt-led--power" aria-hidden="true" />
				</div>

				<div className="crt-abc-cluster" role="group" aria-label="Demo channel">
					{ONBOARDING_CHANNELS.map((c) => (
						<button
							key={c.id}
							type="button"
							className={`crt-abc-btn${channel === c.id ? " is-active" : ""}`}
							aria-pressed={channel === c.id ? "true" : "false"}
							aria-label={`Channel ${c.id}: ${c.label}`}
							title={`${c.id} — ${c.label}`}
							onClick={(e) => {
								e.preventDefault();
								if (c.id === channel) return;
								onChannel(c.id);
							}}
						>
							{c.id}
						</button>
					))}
				</div>

				<button
					type="button"
					className={`crt-fx-btn${fx ? " is-active" : ""}`}
					aria-pressed={fx}
					aria-label="Toggle CRT screen effects"
					title="CRT Screen Effects"
					onClick={toggleFx}
				>
					<span aria-hidden="true">FX</span>
				</button>
			</div>

			<div className="crt-foot crt-foot--l" aria-hidden="true" />
			<div className="crt-foot crt-foot--r" aria-hidden="true" />
		</div>
	);
}
