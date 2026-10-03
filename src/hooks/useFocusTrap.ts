"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(", ");

function isVisible(el: HTMLElement): boolean {
	return el.offsetParent !== null || el === document.activeElement;
}

/**
 * Trap Tab focus inside `ref` while `active`, move focus in on open, and
 * restore the previously focused element on close. Makes `aria-modal="true"`
 * true for assistive tech.
 */
export function useFocusTrap(
	ref: RefObject<HTMLElement | null>,
	active: boolean,
): void {
	const previousFocus = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!active) return;
		previousFocus.current = document.activeElement as HTMLElement | null;

		const root = ref.current;
		if (root) {
			const focusable = Array.from(
				root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
			).filter(isVisible);
			const initial =
				root.querySelector<HTMLElement>("[data-autofocus]") ??
				focusable[0] ??
				root;
			initial.focus();
		}

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || !ref.current) return;
			const items = Array.from(
				ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
			).filter(isVisible);
			if (!items.length) {
				e.preventDefault();
				ref.current.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const activeEl = document.activeElement as HTMLElement | null;
			const inside = activeEl != null && ref.current.contains(activeEl);

			if (e.shiftKey) {
				if (!inside || activeEl === first) {
					e.preventDefault();
					last.focus();
				}
			} else if (!inside || activeEl === last) {
				e.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			const prev = previousFocus.current;
			if (prev && document.contains(prev)) prev.focus();
		};
	}, [active, ref]);
}
