import { describe, expect, it } from "bun:test";
import { LLMError } from "@bound/llm";
import { getLlmRetryAfterMs, getLlmStatusCode } from "../error-classification";

/**
 * Behavioral coverage for the two shape-probing getters that the property
 * suite's predicate tests do not reach. Both read optional fields off an
 * unknown error value without throwing on non-objects.
 */

describe("getLlmStatusCode", () => {
	it("reads statusCode off an LLMError carrying one", () => {
		expect(getLlmStatusCode(new LLMError("bad gateway", "test-provider", 502))).toBe(502);
	});

	it("reads statusCode off a plain object exposing the field", () => {
		expect(getLlmStatusCode({ statusCode: 418 })).toBe(418);
	});

	it("returns undefined when the field is absent or the value is not an object", () => {
		expect(getLlmStatusCode({})).toBeUndefined();
		expect(getLlmStatusCode(new Error("no status"))).toBeUndefined();
		expect(getLlmStatusCode("string error")).toBeUndefined();
		expect(getLlmStatusCode(null)).toBeUndefined();
		expect(getLlmStatusCode(undefined)).toBeUndefined();
		expect(getLlmStatusCode(429)).toBeUndefined();
	});
});

describe("getLlmRetryAfterMs", () => {
	it("reads retryAfterMs off an error object that carries it", () => {
		const err = Object.assign(new Error("rate limited"), { retryAfterMs: 1500 });
		expect(getLlmRetryAfterMs(err)).toBe(1500);
	});

	it("reads retryAfterMs off a plain object exposing the field", () => {
		expect(getLlmRetryAfterMs({ retryAfterMs: 0 })).toBe(0);
	});

	it("returns undefined when the field is absent or the value is not an object", () => {
		expect(getLlmRetryAfterMs({})).toBeUndefined();
		expect(getLlmRetryAfterMs(new Error("no retry hint"))).toBeUndefined();
		expect(getLlmRetryAfterMs("string error")).toBeUndefined();
		expect(getLlmRetryAfterMs(null)).toBeUndefined();
		expect(getLlmRetryAfterMs(undefined)).toBeUndefined();
	});
});
