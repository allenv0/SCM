"use strict";

// Minimal Result envelope for indexer pure cores (L1 FP increment).
// Mirrors src/lib/result.ts so main <-> worker share one shape:
//   { ok:true, value } | { ok:false, error:string }
//
// Existing throw/return-null functions are kept for compat; new
// `*Result` variants return this envelope for IO boundaries where
// the caller needs the reason without try/catch.

function ok(value) {
	return { ok: true, value };
}

function err(error) {
	return {
		ok: false,
		error: typeof error === "string" ? error : String(error),
	};
}

function isOk(r) {
	return !!r && r.ok === true;
}

function tryCatch(fn, onError) {
	try {
		return ok(fn());
	} catch (e) {
		const msg =
			typeof onError === "function"
				? onError(e)
				: String((e && e.message) || e);
		return err(msg);
	}
}

module.exports = { ok, err, isOk, tryCatch };
