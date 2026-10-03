import { expect, test } from "bun:test";
import {
	ok,
	err,
	mapResult,
	flatMapResult,
	fromNullable,
	tryCatch,
	unwrapOr,
} from "../src/lib/result";
import {
	initialSearchStatus,
	searchStatusReducer,
} from "../src/lib/searchStatus";

test("Result ok/err round-trip", () => {
	const a = ok(2);
	expect(a.ok).toBe(true);
	expect(mapResult(a, (x) => x * 3)).toEqual({ ok: true, value: 6 });
	const b = err("nope");
	expect(b.ok).toBe(false);
	expect(mapResult(b, (x: number) => x * 3)).toEqual(b);
});

test("Result flatMap chains, error short-circuits", () => {
	const r = flatMapResult(ok("hi"), (s) =>
		s.length > 0 ? ok(s.length) : err("empty"),
	);
	expect(r).toEqual({ ok: true, value: 2 });
	const e = flatMapResult<number, number>(err("boom"), (x) => ok(x + 1));
	expect(e.ok).toBe(false);
});

test("Result fromNullable/tryCatch/unwrapOr are total", () => {
	expect(fromNullable("x", "missing").ok).toBe(true);
	expect(fromNullable(null, "missing")).toEqual({
		ok: false,
		error: "missing",
	});
	expect(tryCatch(() => JSON.parse('{"a":1}'), String).ok).toBe(true);
	expect(
		tryCatch(
			() => JSON.parse("nope"),
			() => "bad json",
		).ok,
	).toBe(false);
	expect(unwrapOr(err("e"), 7)).toBe(7);
	expect(unwrapOr(ok(3), 7)).toBe(3);
});

test("searchStatusReducer: index lifecycle", () => {
	let s = initialSearchStatus;
	s = searchStatusReducer(s, { type: "index/ready" });
	expect(s.isReady).toBe(true);
	expect(s.error).toBeNull();
	s = searchStatusReducer(s, { type: "index/invalidate" });
	expect(s.isReady).toBe(false);
	expect(s.sceneDataReady).toBe(false);
	s = searchStatusReducer(s, { type: "index/error", error: "load failed" });
	expect(s.error).toBe("load failed");
});

test("searchStatusReducer: search start/end never clobbers error", () => {
	let s = { ...initialSearchStatus, error: "kept" };
	s = searchStatusReducer(s, { type: "search/start" });
	expect(s.isSearching).toBe(true);
	expect(s.error).toBe("kept");
	s = searchStatusReducer(s, { type: "search/end" });
	expect(s.isSearching).toBe(false);
	expect(s.error).toBe("kept");
	s = searchStatusReducer(s, { type: "status/model-error" });
	expect(s.error).toContain("keyword search only");
	s = searchStatusReducer(s, { type: "error/clear" });
	expect(s.error).toBeNull();
});

test("searchStatusReducer: scene/ready is idempotent", () => {
	const a = searchStatusReducer(initialSearchStatus, { type: "scene/ready" });
	expect(a.sceneDataReady).toBe(true);
	const b = searchStatusReducer(a, { type: "scene/ready" });
	expect(b).toBe(a); // same ref, no rerender
});
