import { describe, expect, it } from "bun:test";
import { isClientToolCallRequest, isDeferredToolResult, isToolResultWithMetadata } from "../types";

describe("isDeferredToolResult", () => {
	it("accepts an object with deferred === true", () => {
		expect(isDeferredToolResult({ deferred: true })).toBe(true);
		expect(isDeferredToolResult({ deferred: true, description: "bg task" })).toBe(true);
	});

	it("rejects deferred === false, missing key, non-objects, and null", () => {
		expect(isDeferredToolResult({ deferred: false })).toBe(false);
		expect(isDeferredToolResult({})).toBe(false);
		expect(isDeferredToolResult("deferred")).toBe(false);
		expect(isDeferredToolResult(null)).toBe(false);
		expect(isDeferredToolResult(undefined)).toBe(false);
	});
});

describe("isToolResultWithMetadata", () => {
	it("accepts an object carrying both content and metadata", () => {
		expect(isToolResultWithMetadata({ content: "hi", metadata: { aux_thread: "t1" } })).toBe(true);
	});

	it("rejects arrays, partial shapes, non-objects, and null", () => {
		// An array has "content"/"metadata" only if explicitly set; the guard
		// must exclude arrays outright.
		expect(isToolResultWithMetadata(["content", "metadata"])).toBe(false);
		expect(isToolResultWithMetadata({ content: "hi" })).toBe(false);
		expect(isToolResultWithMetadata({ metadata: {} })).toBe(false);
		expect(isToolResultWithMetadata("x")).toBe(false);
		expect(isToolResultWithMetadata(null)).toBe(false);
	});
});

describe("isClientToolCallRequest", () => {
	it("accepts an object with clientToolCall === true", () => {
		expect(
			isClientToolCallRequest({
				clientToolCall: true,
				toolName: "boundless_read",
				callId: "c1",
				arguments: {},
			}),
		).toBe(true);
	});

	it("rejects clientToolCall === false, missing key, non-objects, and null", () => {
		expect(isClientToolCallRequest({ clientToolCall: false })).toBe(false);
		expect(isClientToolCallRequest({})).toBe(false);
		expect(isClientToolCallRequest(42)).toBe(false);
		expect(isClientToolCallRequest(null)).toBe(false);
	});
});
