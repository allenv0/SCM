"use strict";

const assert = require("node:assert/strict");
const { sortPathsByMtime } = require("../indexer/import-order-utils.js");

function statFrom(mtimes) {
	return (filePath) => {
		if (!mtimes.has(filePath)) throw new Error("not found");
		return { mtimeMs: mtimes.get(filePath) };
	};
}

// A watched-folder scan can arrive in any directory order. Importing in this
// order, then reversing for All/File, must show the 30 latest media items
// first—independent of filename order or media type.
{
	const scanned = [
		"/watch/zzz-newest.gif",
		"/watch/aaa-oldest.jpg",
		"/watch/mmm-video.mp4",
		"/watch/missing.webp",
		"/watch/nnn-tie-a.mov",
		"/watch/ooo-tie-b.png",
	];
	const mtimes = new Map([
		["/watch/aaa-oldest.jpg", 10],
		["/watch/mmm-video.mp4", 20],
		["/watch/nnn-tie-a.mov", 30],
		["/watch/ooo-tie-b.png", 30],
		["/watch/zzz-newest.gif", 40],
	]);

	const ordered = sortPathsByMtime(scanned, statFrom(mtimes));
	assert.deepEqual(ordered, [
		"/watch/missing.webp",
		"/watch/aaa-oldest.jpg",
		"/watch/mmm-video.mp4",
		"/watch/nnn-tie-a.mov",
		"/watch/ooo-tie-b.png",
		"/watch/zzz-newest.gif",
	]);
	assert.deepEqual(scanned, [
		"/watch/zzz-newest.gif",
		"/watch/aaa-oldest.jpg",
		"/watch/mmm-video.mp4",
		"/watch/missing.webp",
		"/watch/nnn-tie-a.mov",
		"/watch/ooo-tie-b.png",
	]);
}

{
	const paths = Array.from(
		{ length: 37 },
		(_, i) =>
			`/watch/${String(37 - i).padStart(2, "0")}.${
				i % 3 === 0 ? "jpg" : i % 3 === 1 ? "mp4" : "gif"
			}`,
	);
	const mtimes = new Map(
		paths.map((filePath) => [filePath, Number(filePath.match(/\/(\d+)\./)[1])]),
	);

	const libraryAppendOrder = sortPathsByMtime(paths, statFrom(mtimes));
	const allFileFirstPage = libraryAppendOrder.slice().reverse().slice(0, 30);
	assert.deepEqual(
		allFileFirstPage.map((filePath) => mtimes.get(filePath)),
		Array.from({ length: 30 }, (_, i) => 37 - i),
	);
}

console.log(
	"import-order: watched batches append oldest→newest; All/File starts with the latest 30",
);
