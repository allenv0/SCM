import { expect, test } from "bun:test";
import { parseCrtEffect } from "../src/lib/crtEffect";

test("parseCrtEffect keeps the CRT on for the stored true value", () => {
	expect(parseCrtEffect("true")).toBe(true);
});

test("parseCrtEffect turns the CRT off only for the literal false value", () => {
	expect(parseCrtEffect("false")).toBe(false);
});

test("parseCrtEffect defaults to on for null, empty, and garbage", () => {
	expect(parseCrtEffect(null)).toBe(true);
	expect(parseCrtEffect("")).toBe(true);
	expect(parseCrtEffect("0")).toBe(true);
	expect(parseCrtEffect("off")).toBe(true);
	expect(parseCrtEffect("FALSE")).toBe(true);
});
