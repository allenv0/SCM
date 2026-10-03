"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "scm-onboarding-seen-v1";

/** Forced preview / suppression for dev and screenshots. */
function forcedState(): boolean | null {
	try {
		const v = new URLSearchParams(window.location.search).get("onboarding");
		if (v === "1" || v === "show") return true;
		if (v === "0" || v === "hide" || v === "done") return false;
	} catch {
		// URL parsing is best-effort; fall through to storage.
	}
	return null;
}

function hasSeenLocal(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function markSeenLocal(): void {
	try {
		localStorage.setItem(STORAGE_KEY, "1");
	} catch {
		// Persisting is best-effort; the session still closes.
	}
}

function clearSeenLocal(): void {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Best-effort; the bridge flag still drives the gate.
	}
}

function bridgeSeen(): Promise<boolean | null> {
	try {
		const get = window.memories?.getOnboardingSeen;
		if (typeof get !== "function") return Promise.resolve(null);
		return get
			.call(window.memories)
			.then((v) => (v === true ? true : false))
			.catch(() => null);
	} catch {
		return Promise.resolve(null);
	}
}

function bridgeMarkSeen(seen: boolean): void {
	try {
		const set = window.memories?.setOnboardingSeen;
		if (typeof set !== "function") return;
		set.call(window.memories, seen)?.catch(() => {
			/* bridge write is best-effort; localStorage still holds */
		});
	} catch {
		// Bridge unavailable (static preview etc.) — localStorage covers it.
	}
}

/**
 * First-run gate for the CRT onboarding overlay. The install-level flag
 * lives in the main process (settings.json `onboardingSeen`) so the tour
 * shows exactly once per install — renderer localStorage is only a fast
 * cache and a fallback for bridge-less contexts. `seen` starts unknown
 * (overlay hidden) so returning users never catch a flash of tour while
 * the bridge resolves.
 */
export function useOnboarding() {
	// null = not resolved yet (overlay stays hidden — no flash for
	// returning users); false = show the tour; true = dismissed.
	const [seen, setSeen] = useState<boolean | null>(null);
	const forced = forcedState();

	useEffect(() => {
		let cancelled = false;
		void bridgeSeen().then((bridge) => {
			if (cancelled) return;
			// Either flag saying "seen" counts — a pre-bridge install that
			// already dismissed via localStorage doesn't get a repeat show.
			setSeen(bridge === true || hasSeenLocal());
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const show = forced === true || (forced !== false && seen === false);

	const dismiss = useCallback(() => {
		setSeen(true);
		markSeenLocal();
		bridgeMarkSeen(true);
	}, []);

	/** Replay helper (Settings → Appearance, dev, screenshots): clear the
	 *  flags so the tour shows again immediately. */
	const reset = useCallback(() => {
		setSeen(false);
		clearSeenLocal();
		bridgeMarkSeen(false);
	}, []);

	return { show, dismiss, reset };
}
