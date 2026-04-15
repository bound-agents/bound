import { describe, expect, it } from "bun:test";
import { inferenceRequestPayloadSchema, streamChunkPayloadSchema } from "../relay-schemas";

describe("inferenceRequestPayloadSchema thinking field", () => {
	it("accepts payload with thinking config", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
		}
	});

	it("accepts payload without thinking config", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toBeUndefined();
		}
	});

	it("rejects thinking with invalid type", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "disabled", budget_tokens: 10000 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(false);
	});

	it("rejects thinking with negative budget_tokens", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "enabled", budget_tokens: -100 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(false);
	});
});

describe("streamChunkPayloadSchema thinking field", () => {
	it("accepts payload with thinking content", () => {
		const payload = {
			thinking: "Let me analyze this...",
		};
		const result = streamChunkPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toBe("Let me analyze this...");
		}
	});

	it("accepts payload without thinking content", () => {
		const payload = {
			content: "Hello world",
		};
		const result = streamChunkPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
	});
});
