import { useCallback, useEffect, useState } from "react";
import { DEFAULT_APP_ICON, parseAppIcon, type AppIconId } from "@/lib/appIcons";

/**
 * Owns the app-icon setting: Dock + window icon picked in
 * Settings → Appearance → App Icon. Source of truth is the main process
 * (settings.json `appIcon`); this hook mirrors it for the renderer.
 */
export function useAppIcon() {
	const [icon, setIcon] = useState<AppIconId>(DEFAULT_APP_ICON);

	useEffect(() => {
		let cancelled = false;
		void window.memories
			.getAppIcon()
			.then((value) => {
				if (!cancelled) setIcon(parseAppIcon(value));
			})
			.catch(() => {
				/* bridge is optional in some contexts */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const update = useCallback(async (next: AppIconId) => {
		const parsed = parseAppIcon(next);
		try {
			const res = await window.memories.setAppIcon(parsed);
			if (!res?.ok) {
				// Keep current selection and surface the error; truth is still the persisted value
				const current = await window.memories
					.getAppIcon()
					.catch(() => DEFAULT_APP_ICON);
				setIcon(parseAppIcon(current));
				return res;
			}
			setIcon(parsed);
			return res;
		} catch (err: any) {
			const current = await window.memories
				.getAppIcon()
				.catch(() => DEFAULT_APP_ICON);
			setIcon(parseAppIcon(current));
			return { ok: false, error: err?.message ?? String(err) } as const;
		}
	}, []);

	return { appIcon: icon, setAppIcon: update };
}
