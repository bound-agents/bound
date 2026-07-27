import { describe, expect, it } from "bun:test";
import { formatError } from "../errors";

describe("formatError", () => {
	it("returns an Error's message", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
	});

	it("passes a string through", () => {
		expect(formatError("plain failure")).toBe("plain failure");
	});

	it("uses the fallback for null / undefined", () => {
		expect(formatError(null)).toBe("Unknown error");
		expect(formatError(undefined)).toBe("Unknown error");
		expect(formatError(null, "custom")).toBe("custom");
	});

	it("renders non-object primitives rather than the fallback", () => {
		expect(formatError(404)).toBe("404");
		expect(formatError(false)).toBe("false");
	});

	// ── The regression this file exists for ──────────────────────────────────
	//
	// The AI SDK forwards arbitrary objects on `fullStream` error events. A
	// `String(err)` on those renders "[object Object]", and a bare fallback
	// renders "Unknown error" — either way the only diagnostic the provider
	// gave us is destroyed, and it travels verbatim out through /v1/responses
	// to external clients. Observed live via polytoken:
	//   provider error server_error: [object Object]

	it("never renders [object Object] for a plain object", () => {
		expect(formatError({ statusCode: 403 })).not.toContain("[object Object]");
		expect(formatError({ foo: "bar" })).not.toContain("[object Object]");
	});

	it("preserves a status-only carrier as an HTTP status", () => {
		// JSON projection wins here — it carries strictly more than "HTTP 403".
		expect(formatError({ statusCode: 403 })).toContain("403");
	});

	it("falls back to HTTP <status> when the object is not serializable", () => {
		const circular: Record<string, unknown> = { statusCode: 503 };
		circular.self = circular;
		expect(formatError(circular)).toBe("HTTP 503");
	});

	it("pulls the message off a message-bearing object and prefixes the status", () => {
		expect(formatError({ statusCode: 403, message: "Access denied" })).toBe(
			"HTTP 403: Access denied",
		);
	});

	it("does not double-report a status already present in the message", () => {
		expect(formatError({ status: 429, message: "429 Too Many Requests" })).toBe(
			"429 Too Many Requests",
		);
	});

	it("reads a bare message with no status verbatim", () => {
		expect(formatError({ message: "stream closed early" })).toBe("stream closed early");
	});

	it("honors the alternate message keys providers use", () => {
		expect(formatError({ error_description: "invalid_grant" })).toBe("invalid_grant");
		expect(formatError({ detail: "quota exhausted" })).toBe("quota exhausted");
		expect(formatError({ reason: "model unavailable" })).toBe("model unavailable");
	});

	it("unwraps a nested OpenAI-style error envelope", () => {
		expect(formatError({ error: { message: "context length exceeded" } })).toBe(
			"context length exceeded",
		);
	});

	it("unwraps a nested cause", () => {
		expect(formatError({ cause: new Error("socket hang up") })).toBe("socket hang up");
	});

	it("reads the AWS SDK $metadata status shape", () => {
		expect(formatError({ $metadata: { httpStatusCode: 503 }, message: "unavailable" })).toBe(
			"HTTP 503: unavailable",
		);
	});

	it("survives a self-referential error key without recursing forever", () => {
		const selfRef: Record<string, unknown> = {};
		selfRef.error = selfRef;
		expect(() => formatError(selfRef)).not.toThrow();
	});
});
