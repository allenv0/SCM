"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CrtTv from "./CrtTv";
import { ONBOARDING_CHANNELS, ONBOARDING_HEADLINE } from "./onboarding-data";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import "./onboarding.css";

interface OnboardingProps {
	onDone: () => void;
	onImport: () => void;
}

const ORDER = ONBOARDING_CHANNELS.map((c) => c.id);

/**
 * First-run tour: the website's CRT monitor with its three demo channels
 * (A/B/C) plus their intro copy, in a modal overlay. Stepping through the
 * channels drives the CRT (and vice versa) — one metaphor, both directions.
 */
export default function Onboarding({ onDone, onImport }: OnboardingProps) {
	const [index, setIndex] = useState(0);
	const dialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(dialogRef, true);

	const channel = ONBOARDING_CHANNELS[index];
	const last = index === ORDER.length - 1;

	const next = useCallback(() => {
		if (last) onDone();
		else setIndex((i) => Math.min(i + 1, ORDER.length - 1));
	}, [last, onDone]);

	const back = useCallback(() => {
		setIndex((i) => Math.max(i - 1, 0));
	}, []);

	// Arrow keys flip channels, Esc skips — the CRT is a keyboard citizen.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onDone();
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				setIndex((i) => Math.min(i + 1, ORDER.length - 1));
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				setIndex((i) => Math.max(i - 1, 0));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onDone]);

	return (
		<div className="onb-overlay" data-testid="onboarding-overlay">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="onb-title"
				className="onb-dialog"
				tabIndex={-1}
			>
				<h1 id="onb-title" className="onb-headline">
					<span className="onb-fringe">
						{ONBOARDING_HEADLINE.fringe}
						<br />
					</span>
					<span
						className="onb-highlight"
						data-text={ONBOARDING_HEADLINE.highlight}
					>
						{ONBOARDING_HEADLINE.highlight}
					</span>
				</h1>
				<p className="onb-sub">{ONBOARDING_HEADLINE.sub}</p>

				<div className="onb-showcase">
					<div className="onb-container">
						<CrtTv
							channel={channel.id}
							onChannel={(id) => {
								const at = ORDER.indexOf(id);
								if (at !== -1) setIndex(at);
							}}
						/>
					</div>
				</div>

				<div className="onb-step" aria-live="polite">
					<p className="onb-step__title">{channel.title}</p>
					<p className="onb-step__text">{channel.text}</p>
				</div>

				<div className="onb-dots" role="tablist" aria-label="Tour steps">
					{ONBOARDING_CHANNELS.map((c, i) => (
						<button
							key={c.id}
							type="button"
							role="tab"
							aria-selected={i === index}
							aria-label={`Step ${i + 1}: ${c.label}`}
							className={`onb-dot${i === index ? " is-active" : ""}`}
							style={{ ["--ticker-color" as string]: c.color }}
							onClick={() => setIndex(i)}
						/>
					))}
				</div>

				<div className="onb-nav">
					<button
						type="button"
						className="onb-btn onb-btn--ghost"
						onClick={onDone}
					>
						Skip tour
					</button>
					<div className="onb-nav__main">
						{index > 0 && (
							<button
								type="button"
								className="onb-btn onb-btn--ghost"
								onClick={back}
							>
								◀ Back
							</button>
						)}
						{!last ? (
							<button
								type="button"
								className="onb-btn onb-btn--primary"
								onClick={next}
								data-autofocus
							>
								Next ▶
							</button>
						) : (
							<>
								<button
									type="button"
									className="onb-btn onb-btn--ghost"
									onClick={onImport}
									title="Import Photos (⌘I)"
								>
									Import photos
								</button>
								<button
									type="button"
									className="onb-btn onb-btn--primary"
									onClick={onDone}
									data-autofocus
								>
									Start searching
								</button>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
