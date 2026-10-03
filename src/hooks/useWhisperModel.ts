import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_WHISPER_MODEL,
	parseWhisperModel,
	type WhisperModelSetting,
} from "@/lib/whisperModel";

/**
 * Owns the speech-model preference (Settings → Video search → Speech model):
 * the whisper engine for background transcription. Mount once (App); the
 * Settings sheet's Video search section drives it via props. Like video
 * quality, the source of truth lives in the main process (settings.json —
 * the transcription queue reads it), so this hook loads over the IPC bridge
 * and writes back through it. Falls back to "tiny.en" when the bridge is
 * unavailable. Switching models invalidates the speech sidecar and
 * re-queues every video (main returns the count for the notify toast).
 */
export function useWhisperModel() {
	const [model, setModelState] = useState<WhisperModelSetting>(
		DEFAULT_WHISPER_MODEL,
	);

	useEffect(() => {
		let cancelled = false;
		void window.memories
			?.getWhisperModel?.()
			.then((m) => {
				if (!cancelled) setModelState(parseWhisperModel(m));
			})
			.catch(() => {
				/* bridge is optional — keep the default */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const update = useCallback(
		async (next: WhisperModelSetting): Promise<number | null> => {
			setModelState(next);
			try {
				const res = await window.memories.setWhisperModel(next);
				if (res?.ok && res.model) {
					setModelState(parseWhisperModel(res.model));
					return res.queued ?? 0;
				}
				return null;
			} catch {
				// Persisting failed; the session still shows the choice, and
				// the next mount re-reads the stored value.
				return null;
			}
		},
		[],
	);

	return {
		whisperModel: model,
		setWhisperModel: update,
	};
}
