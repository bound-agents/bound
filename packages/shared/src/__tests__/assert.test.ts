import { describe, expect, it } from "bun:test";
import { assert, assertNever } from "../assert";

describe("assertNever", () => {
	it("throws with the default message echoing the unexpected value", () => {
		// Cast through unknown: the whole point is the runtime guard for an
		// unhandled discriminated-union variant that TS believed impossible.
		expect(() => assertNever("surprise" as unknown as never)).toThrow(
			'Unexpected value: "surprise"',
		);
	});

	it("throws with a caller-supplied message when given one", () => {
		expect(() => assertNever(42 as unknown as never, "Unhandled relay kind")).toThrow(
			"Unhandled relay kind",
		);
	});

	it("serializes object values into the default message", () => {
		expect(() => assertNever({ kind: "weird" } as unknown as never)).toThrow(
			'Unexpected value: {"kind":"weird"}',
		);
	});
});

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
