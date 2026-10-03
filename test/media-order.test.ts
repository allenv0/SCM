import { expect, test } from "bun:test";
import { newestMediaFirst } from "../src/lib/mediaOrder";

test("All/File starts with the 30 newest rows, regardless of library order", () => {
	const storedRows = Array.from({ length: 37 }, (_, i) => ({
		id: `row-${i}`,
		// Intentionally make index order and media recency disagree.
		modifiedAt: (i * 17) % 37,
	}));

	const page = newestMediaFirst(storedRows).slice(0, 30);
	expect(page.map((row) => row.modifiedAt)).toEqual(
		Array.from({ length: 30 }, (_, i) => 36 - i),
	);
});

test("missing timestamps sort behind timestamped media", () => {
	const page = newestMediaFirst([
		{ id: "unknown", modifiedAt: null },
		{ id: "old", modifiedAt: 10 },
		{ id: "new", modifiedAt: 20 },
	]);
	expect(page.map((row) => row.id)).toEqual(["new", "old", "unknown"]);
});
