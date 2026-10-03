"use client";

// Film-gate progress: a strip of frame cells that light up one by one as
// work advances — the projector language for AI processing (monochrome
// phosphor, no neon). pct null = indeterminate (all cells sit dim, the
// motion comes from the spinning reel beside it).
interface FilmGateProps {
	pct?: number | null;
	cells?: number;
	className?: string;
}

export default function FilmGate({
	pct = null,
	cells = 24,
	className = "",
}: FilmGateProps) {
	const rounded = pct == null ? null : Math.round(pct);
	const on =
		rounded == null
			? null
			: Math.round((Math.min(100, Math.max(0, rounded)) / 100) * cells);
	return (
		<div
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={rounded ?? undefined}
			aria-label="Progress"
			className={`film-gate ${className}`}
		>
			{Array.from({ length: cells }, (_, i) => (
				<span
					key={i}
					className={`film-gate-cell ${
						on == null
							? "film-gate-cell--dim"
							: i < on
								? "film-gate-cell--on"
								: ""
					}`}
				/>
			))}
		</div>
	);
}
