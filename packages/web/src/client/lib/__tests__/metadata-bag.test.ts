import { describe, expect, it } from "bun:test";
import { readMetadataBag } from "../metadata-bag";

describe("readMetadataBag", () => {
	it("accepts JSON strings and parsed objects", () => {
		expect(readMetadataBag('{"a":1}')).toEqual({ a: 1 });
		expect(readMetadataBag({ a: 1 })).toEqual({ a: 1 });
	});

	it("returns undefined for absent, malformed, and non-object bags", () => {
		expect(readMetadataBag(null)).toBeUndefined();
		expect(readMetadataBag("{nope")).toBeUndefined();
		expect(readMetadataBag("[1]")).toBeUndefined();
		expect(readMetadataBag("3")).toBeUndefined();
	});
});
