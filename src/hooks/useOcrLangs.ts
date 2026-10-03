import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_OCR_LANGS,
	parseOcrLangs,
	type OcrLangId,
} from "@/lib/ocrLangs";

/**
 * Owns the OCR text-language preference (Settings → Photo Search → Text
 * languages): which tesseract models back background text extraction.
 * Mount once (App); the Settings sheet drives it via props. Like whisper,
 * the source of truth lives in the main process (settings.json `ocrLangs`),
 * so this hook loads over the IPC bridge and writes back through it. Falls
 * back to all-CJK-on when the bridge is unavailable. Switching re-queues
 * every photo (main returns the count for the notify toast).
 */
export function useOcrLangs() {
	const [langs, setLangsState] = useState<OcrLangId[]>(DEFAULT_OCR_LANGS);

	useEffect(() => {
		let cancelled = false;
		void window.memories
			?.getOcrLangs?.()
			.then((l) => {
				if (!cancelled) setLangsState(parseOcrLangs(l));
			})
			.catch(() => {
				/* bridge is optional — keep the default */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const update = useCallback(
		async (next: OcrLangId[]): Promise<number | null> => {
			setLangsState(parseOcrLangs(next));
			try {
				const res = await window.memories.setOcrLangs(next);
				if (res?.ok && res.langs) {
					setLangsState(parseOcrLangs(res.langs));
					return res.queued ?? 0;
				}
				return null;
			} catch {
				return null;
			}
		},
		[],
	);

	const toggle = useCallback(
		(id: OcrLangId) => {
			const has = langs.includes(id);
			const next = has ? langs.filter((l) => l !== id) : [...langs, id];
			return update(next);
		},
		[langs, update],
	);

	// Manual re-read of every photo under the current language set
	// (Settings → Photo Search button). Main returns the queued count for
	// the notify toast; null on bridge failure.
	const reocr = useCallback(async (): Promise<number | null> => {
		try {
			const res = await window.memories.reocrPhotos();
			if (res?.ok) return res.queued ?? 0;
			return null;
		} catch {
			return null;
		}
	}, []);

	return {
		ocrLangs: langs,
		setOcrLangs: update,
		toggleOcrLang: toggle,
		reocrPhotos: reocr,
	};
}
