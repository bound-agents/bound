import { describe, expect, it } from "bun:test";
import { assert } from "../assert";

describe("assert", () => {
	it("does not throw for a truthy condition", () => {
		expect(() => assert(1)).not.toThrow();
		expect(() => assert("non-empty")).not.toThrow();
		expect(() => assert({})).not.toThrow();
	});

	it("throws the default message for a falsy condition", () => {
		expect(() => assert(0)).toThrow("Condition failed: 0");
		expect(() => assert("")).toThrow('Condition failed: ""');
		expect(() => assert(null)).toThrow("Condition failed: null");
	});

	it("throws a caller-supplied message when given one", () => {
		expect(() => assert(false, "must be present")).toThrow("must be present");
	});
});
