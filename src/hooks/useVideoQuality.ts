import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_VIDEO_QUALITY,
	parseVideoQuality,
	type VideoQualitySetting,
} from "@/lib/videoQuality";

/**
 * Owns the video search quality preference (Settings → Video search):
 * the scene-segment density preset for background video analysis.
 * Mount once (App); the Settings sheet's Video search section drives it
 * via props. Unlike theme/grid, the source of truth lives in the main
 * process (settings.json — the enrichment queue reads it), so this hook
 * loads over the IPC bridge and writes back through it. Falls back to
 * "balanced" when the bridge is unavailable.
 */
/** Per-video scene-coverage facts from memories.videosCostEstimate(): the
 *  raw material for the Settings → Video search cost line (see
 *  MDs/Ultra-Pro-Plan.md §4.3 — arithmetic lives in src/lib/videoQuality.ts;
 *  this is just the measured library footprint). */
export interface VideoCostFacts {
	videoCount: number;
	knownSeconds: number;
	unknownCount: number;
	durations: number[];
}

export function useVideoQuality() {
	const [quality, setQualityState] = useState<VideoQualitySetting>(
		DEFAULT_VIDEO_QUALITY,
	);
	// Count of library videos whose scene sidecars look truncated by the
	// pre-fix chunk-accumulation bug (searchable only in their final
	// minutes). 0 when everything is fine; > 0 drives the repair banner in
	// Settings → Video search. Refetched when the Settings sheet opens.
	const [suspectedTruncated, setSuspectedTruncated] = useState(0);
	// Filenames behind that count (from the same scan) — the repair
	// banner's optional delete flow removes exactly these rows (library
	// copy + index + sidecars; the user's originals are untouched).
	const [suspectedTruncatedFiles, setSuspectedTruncatedFiles] = useState<
		string[]
	>([]);
	// Library cost facts for the preset cost line. Null until the first
	// successful read (the line then falls back to a static 90-min example);
	// refreshed when the Settings sheet opens, like the truncation scan.
	const [costFacts, setCostFacts] = useState<VideoCostFacts | null>(null);

	useEffect(() => {
		let cancelled = false;
		void window.memories
			?.getVideoQuality?.()
			.then((q) => {
				if (!cancelled) setQualityState(parseVideoQuality(q));
			})
			.catch(() => {
				/* bridge is optional — keep the default */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const refreshSuspectedTruncated = useCallback(async () => {
		try {
			const res = await window.memories.suspectedTruncatedVideos();
			if (res?.ok && typeof res.count === "number") {
				setSuspectedTruncated(res.count);
				setSuspectedTruncatedFiles(
					Array.isArray(res.videos)
						? res.videos
								.map((v) => v?.filename)
								.filter((f): f is string => typeof f === "string")
						: [],
				);
			}
		} catch {
			/* bridge is optional — keep the last known count */
		}
	}, []);

	const update = useCallback(async (next: VideoQualitySetting) => {
		setQualityState(next);
		try {
			const res = await window.memories.setVideoQuality(next);
			if (res?.ok && res.quality)
				setQualityState(parseVideoQuality(res.quality));
		} catch {
			// Persisting failed; the session still shows the choice, and the
			// next mount re-reads the stored value.
		}
	}, []);

	const reanalyze = useCallback(async (): Promise<number | null> => {
		try {
			const res = await window.memories.reanalyzeVideos();
			return res?.ok ? (res.queued ?? 0) : null;
		} catch {
			return null;
		}
	}, []);

	const refreshCostFacts = useCallback(async () => {
		try {
			const res = await window.memories.videosCostEstimate?.();
			if (
				res?.ok &&
				typeof res.videoCount === "number" &&
				Array.isArray(res.durations)
			) {
				setCostFacts({
					videoCount: res.videoCount,
					knownSeconds: res.knownSeconds ?? 0,
					unknownCount: res.unknownCount ?? 0,
					durations: res.durations,
				});
			}
		} catch {
			/* bridge is optional — keep the last known facts */
		}
	}, []);

	return {
		videoQuality: quality,
		setVideoQuality: update,
		reanalyzeVideos: reanalyze,
		suspectedTruncated,
		suspectedTruncatedFiles,
		refreshSuspectedTruncated,
		costFacts,
		refreshCostFacts,
	};
}
