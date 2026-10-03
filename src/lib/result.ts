/**
 * Minimal Result<T,E> for FP increment (L1).
 *
 * Why not throw / return null:
 * - `throw` splits control flow, invisible to types.
 * - `null` loses the reason.
 * - `{ok:false,error}` is already the cross-process envelope
 *   (ocr-worker / indexer.js), this just types it for pure cores.
 *
 * Keep it tiny on purpose: no fp-ts/Effect dep. Hot paths
 * (Float32Array cosine, ranking loops) stay exception/number based
 * for perf; Result is for parse/validate/IO-boundary helpers.
 */

export type Result<T, E = string> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

export function isOk<T, E>(
	r: Result<T, E>,
): r is { readonly ok: true; readonly value: T } {
	return r.ok;
}

export function isErr<T, E>(
	r: Result<T, E>,
): r is { readonly ok: false; readonly error: E } {
	return !r.ok;
}

/** Total unwrap with fallback — for UI/display paths that must never throw. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
	return r.ok ? r.value : fallback;
}

/** Map the success value, pass errors through. */
export function mapResult<T, U, E>(
	r: Result<T, E>,
	fn: (v: T) => U,
): Result<U, E> {
	return r.ok ? ok(fn(r.value)) : r;
}

/** Chain Result-returning fns (flatMap / andThen). */
export function flatMapResult<T, U, E>(
	r: Result<T, E>,
	fn: (v: T) => Result<U, E>,
): Result<U, E> {
	return r.ok ? fn(r.value) : r;
}

/** Lift nullable into Result with explicit error. */
export function fromNullable<T>(
	value: T | null | undefined,
	error: string,
): Result<NonNullable<T>> {
	return value === null || value === undefined
		? err(error)
		: ok(value as NonNullable<T>);
}

/** Wrap a throwing fn into Result. For parse/validate boundaries only. */
export function tryCatch<T>(
	fn: () => T,
	onError: (e: unknown) => string,
): Result<T> {
	try {
		return ok(fn());
	} catch (e) {
		return err(onError(e));
	}
}
