import { describe, expect, it } from "bun:test";
import { definedSegments, segmentsAreaPath, segmentsLinePath } from "../chart-segments";

const xy = (p: { x: number; y: number | null }): [number, number] => [p.x, p.y ?? 0];

describe("chart-segments", () => {
	it("splits a series at null values", () => {
		const pts = [
			{ x: 0, y: 1 },
			{ x: 1, y: null },
			{ x: 2, y: 3 },
			{ x: 3, y: 4 },
		];
		const segs = definedSegments(pts, (p) => p.y !== null);
		expect(segs.map((s) => s.map((p) => p.x))).toEqual([[0], [2, 3]]);
		expect(segmentsLinePath(segs, xy)).toBe("M0,1 M2,3 L3,4");
	});

	it("closes each segment's area to the baseline", () => {
		const segs = [
			[
				{ x: 2, y: 3 },
				{ x: 3, y: 4 },
			],
		];
		expect(segmentsAreaPath(segs, xy, 10)).toBe("M2,3 L3,4 L3,10 L2,10 Z");
	});

	it("returns no segments for an all-null series", () => {
		expect(definedSegments([{ x: 0, y: null }], (p) => p.y !== null)).toEqual([]);
	});
});
