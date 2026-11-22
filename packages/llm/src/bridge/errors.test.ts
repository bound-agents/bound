import { describe, expect, it } from "bun:test";
import { LLMRefusalError } from "../model-declined";
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

describe("mapError — Gemini Interactions API safety blocks (R-RT15)", () => {
	// The Gemini Interactions API surfaces a safety block as an HTTP 400 whose
	// JSON body carries an error `code` naming the block. Unlike a 200-shaped
	// refusal, this arrives on the AI SDK error path, so mapError is the only
	// place the raw 400 body is still visible before router error handling runs.
	// A safety-coded 400 must become an LLMRefusalError (a refusal, not a route
	// failure); any other 400 stays a plain LLMError that PooledBackend backs off.

	it("classifies a safety-coded 400 as an LLMRefusalError, not a route failure", () => {
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"error":{"code":"safety","message":"Blocked by safety filter"}}',
		});
		const mapped = mapError(err, "gemini");
		expect(mapped).toBeInstanceOf(LLMRefusalError);
		const refusal = mapped as LLMRefusalError;
		expect(refusal.statusCode).toBe(400);
		expect(refusal.outcome.kind).toBe("model-declined");
		expect(refusal.outcome.vendor).toBe("google");
		expect(refusal.outcome.category).toBe("safety");
		expect(refusal.outcome.raw_reason).toBe("safety");
		expect(refusal.outcome.substitutable).toBe(true);
	});

	it("classifies each recognized safety code (jailbreak, prohibited_content, blocklist)", () => {
		for (const code of ["jailbreak", "prohibited_content", "blocklist"]) {
			const err = apiCallError({
				message: "Bad Request",
				statusCode: 400,
				responseBody: JSON.stringify({ error: { code, message: "blocked" } }),
			});
			const mapped = mapError(err, "gemini");
			expect(mapped).toBeInstanceOf(LLMRefusalError);
			expect((mapped as LLMRefusalError).outcome.category).toBe(code);
		}
	});

	it("reads a top-level `code` field as well as a nested error.code", () => {
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"code":"prohibited_content","message":"blocked"}',
		});
		const mapped = mapError(err, "gemini");
		expect(mapped).toBeInstanceOf(LLMRefusalError);
		expect((mapped as LLMRefusalError).outcome.category).toBe("prohibited_content");
	});

	it("leaves a 400 WITHOUT a safety code as a plain LLMError route failure", () => {
		// R-RT15: a malformed-request 400 (e.g. invalid argument) is a genuine
		// route failure. It must NOT become an LLMRefusalError, so PooledBackend
		// still backs off the entry and the normal 400 path applies.
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: '{"error":{"code":"invalid_argument","message":"bad field"}}',
		});
		const mapped = mapError(err, "gemini");
		expect(mapped).toBeInstanceOf(LLMError);
		expect(mapped).not.toBeInstanceOf(LLMRefusalError);
		expect(mapped.statusCode).toBe(400);
	});

	it("leaves a 400 with no parseable body as a plain LLMError", () => {
		const err = apiCallError({
			message: "Bad Request",
			statusCode: 400,
			responseBody: "not json at all",
		});
		const mapped = mapError(err, "gemini");
		expect(mapped).toBeInstanceOf(LLMError);
		expect(mapped).not.toBeInstanceOf(LLMRefusalError);
	});

	it("does not classify a non-400 status even if the body carries a safety code", () => {
		// The Interactions safety block is specifically a 400. A 500 that happens
		// to echo a safety-looking code is a server fault (route failure).
		const err = apiCallError({
			message: "Server Error",
			statusCode: 500,
			responseBody: '{"error":{"code":"safety"}}',
		});
		const mapped = mapError(err, "gemini");
		expect(mapped).toBeInstanceOf(LLMError);
		expect(mapped).not.toBeInstanceOf(LLMRefusalError);
	});
});
