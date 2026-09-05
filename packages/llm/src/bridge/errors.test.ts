import { describe, expect, it } from "bun:test";
import { LLMError } from "../types";
import { mapError } from "./errors";

/** A minimal stand-in for the AI SDK's APICallError shape. */
function apiCallError(opts: {
	message: string;
	statusCode?: number;
	responseBody?: string;
	responseHeaders?: Record<string, string>;
}): Error {
	const err = new Error(opts.message);
	Object.assign(err, {
		statusCode: opts.statusCode,
		responseBody: opts.responseBody,
		responseHeaders: opts.responseHeaders,
	});
	return err;
}

describe("mapError", () => {
	it("passes an existing LLMError through untouched", () => {
		const original = new LLMError("boom", "test", 503);
		expect(mapError(original, "test")).toBe(original);
	});

	it("surfaces the APICallError responseBody detail across the wire", () => {
		// The Codex backend returns 400 with the actual reason in responseBody,
		// while .message is only the bare status text. Without lifting the body,
		// a remote inference failure reaching the requesting host reads just
		// "Bad Request" — the operator has to dig through the executing host's
		// logs. The mapped message must carry the detail.
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"detail":"Store must be set to false"}',
		});
		const mapped = mapError(err, "chatgpt-oauth");
		expect(mapped).toBeInstanceOf(LLMError);
		expect(mapped.statusCode).toBe(400);
		expect(mapped.message).toContain("Store must be set to false");
		expect(mapped.message).toContain("chatgpt-oauth request failed");
	});

	it("lifts a nested {error:{message}} envelope from the responseBody", () => {
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"error":{"message":"Unsupported parameter: temperature"}}',
		});
		expect(mapError(err, "p").message).toContain("Unsupported parameter: temperature");
	});

	it("falls back to the raw responseBody when it is not JSON", () => {
		const err = apiCallError({
			message: "Bad Gateway",
			statusCode: 502,
			responseBody: "upstream connect error or disconnect/reset before headers",
		});
		expect(mapError(err, "p").message).toContain("upstream connect error");
	});

	it("does not duplicate the detail when it already appears in the base message", () => {
		const err = apiCallError({
			message: "Store must be set to false",
			statusCode: 400,
			responseBody: '{"detail":"Store must be set to false"}',
		});
		const msg = mapError(err, "p").message;
		// The phrase should appear exactly once (base message already had it).
		expect(msg.match(/Store must be set to false/g)).toHaveLength(1);
	});

	it("carries the status code and retry-after through untouched", () => {
		const err = apiCallError({
			message: "Too Many Requests",
			statusCode: 429,
			responseHeaders: { "retry-after": "30" },
		});
		const mapped = mapError(err, "p");
		expect(mapped.statusCode).toBe(429);
		expect(mapped.retryAfterMs).toBe(30_000);
	});

	it("unwraps a RetryError's lastError to recover the status and detail", () => {
		const inner = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"detail":"Store must be set to false"}',
		});
		const retryError = new Error("retry budget exhausted");
		Object.assign(retryError, { lastError: inner });
		const mapped = mapError(retryError, "p");
		expect(mapped.statusCode).toBe(400);
		expect(mapped.message).toContain("Store must be set to false");
	});

	it("handles an error with no responseBody without appending noise", () => {
		const err = apiCallError({ message: "Service Unavailable", statusCode: 503 });
		const msg = mapError(err, "p").message;
		expect(msg).toBe("p request failed: Service Unavailable");
	});
});
