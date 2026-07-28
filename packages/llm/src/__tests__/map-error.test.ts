import { describe, expect, it } from "bun:test";
import { mapError } from "../bridge/errors";
import { LLMError } from "../types";

describe("mapError", () => {
	it("extracts statusCode from a plain APICallError-shaped object", () => {
		const err = { statusCode: 529, message: "Overloaded" };
		const result = mapError(err, "anthropic");
		expect(result.statusCode).toBe(529);
		expect(result.provider).toBe("anthropic");
		expect(result.message).toContain("Overloaded");
	});

	it("extracts statusCode from $metadata.httpStatusCode (AWS/Bedrock shape)", () => {
		const err = { $metadata: { httpStatusCode: 403 }, message: "AccessDenied" };
		const result = mapError(err, "bedrock");
		expect(result.statusCode).toBe(403);
	});

	it("extracts retry-after header into retryAfterMs", () => {
		const err = {
			statusCode: 429,
			message: "Rate limited",
			responseHeaders: { "retry-after": "5" },
		};
		const result = mapError(err, "openai");
		expect(result.statusCode).toBe(429);
		expect(result.retryAfterMs).toBe(5000);
	});

	it("returns LLMError instances unchanged", () => {
		const original = new LLMError("existing", "test", 500);
		const result = mapError(original, "ignored");
		expect(result).toBe(original);
	});

	it("unwraps RetryError.lastError to extract statusCode", () => {
		// The AI SDK wraps the final error in a RetryError after exhausting
		// its internal retry budget. The RetryError itself carries no
		// statusCode — the HTTP status lives on .lastError.
		const retryError = {
			name: "RetryError",
			message: "Failed after 3 attempts",
			lastError: {
				statusCode: 529,
				message: "Overloaded",
				responseHeaders: { "retry-after": "10" },
			},
		};
		const result = mapError(retryError, "anthropic");
		expect(result.statusCode).toBe(529);
		expect(result.retryAfterMs).toBe(10000);
		expect(result.message).toContain("Failed after 3 attempts");
	});

	it("falls back to undefined statusCode when neither carrier has one", () => {
		const err = { message: "unknown error" };
		const result = mapError(err, "test");
		expect(result.statusCode).toBeUndefined();
	});
});
