import { describe, expect, it } from "bun:test";
import type { StreamChunk } from "@bound/llm";
import { parseResponseChunks } from "../stream-parser";

/**
 * Behavioral coverage for parseResponseChunks paths the property suite does not
 * reach: the production default duplicate-id factory (no injected factory on a
 * collision), the thinking encrypted-content accumulation, the stream "error"
 * chunk warn path, and the "heartbeat" no-op. These assert on the parsed output
 * and on what the logger was told, not on internal structure.
 */

function captureLogger() {
	const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
	return {
		logger: {
			warn: (message: string, metadata?: Record<string, unknown>) =>
				warnings.push({ message, metadata }),
		},
		warnings,
	};
}

describe("parseResponseChunks default duplicate-id factory", () => {
	it("reassigns colliding tool_use ids with the built-in factory and keeps both calls", () => {
		const { logger, warnings } = captureLogger();
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "dup", name: "first" },
			{ type: "tool_use_args", id: "dup", partial_json: '{"a":1}' },
			{ type: "tool_use_end", id: "dup" },
			{ type: "tool_use_start", id: "dup", name: "second" },
			{ type: "tool_use_args", id: "dup", partial_json: '{"b":2}' },
			{ type: "tool_use_end", id: "dup" },
		];
		// No duplicateIdFactory supplied -> exercises defaultDuplicateIdFactory.
		const parsed = parseResponseChunks(chunks, { logger });

		expect(parsed.toolCalls).toHaveLength(2);
		const ids = parsed.toolCalls.map((tc) => tc.id);
		expect(new Set(ids).size).toBe(2); // the collision was resolved
		expect(ids[0]).toBe("dup"); // first keeps the original id
		expect(ids[1]).toContain("dup-dedup-"); // default factory shape
		expect(parsed.toolCalls[0].name).toBe("first");
		expect(parsed.toolCalls[1].name).toBe("second");
		expect(parsed.toolCalls[1].input).toEqual({ b: 2 });
		// The remap was logged.
		expect(warnings.some((w) => w.message.includes("Duplicate tool-use ID detected"))).toBe(true);
	});
});

describe("parseResponseChunks malformed tool arguments", () => {
	it("keeps parse diagnostics bounded and excludes the argument bytes", () => {
		const { logger, warnings } = captureLogger();
		const rawArgs = '{"value":1,}';
		const parsed = parseResponseChunks(
			[
				{ type: "tool_use_start", id: "bad-call", name: "lookup" },
				{ type: "tool_use_args", id: "bad-call", partial_json: rawArgs },
				{ type: "tool_use_end", id: "bad-call" },
				{
					type: "done",
					finish_reason: "tool-calls",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				},
			],
			{ logger },
		);

		expect(parsed.toolCalls[0]).toMatchObject({
			parseError: "invalid_json",
			finishReason: "tool-calls",
			truncated: false,
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].metadata).toEqual({
			toolCallId: "bad-call",
			argsLength: rawArgs.length,
			parseError: "invalid_json",
			finishReason: "tool-calls",
		});
		expect(warnings[0].message).not.toContain(rawArgs);
	});

	it("associates malformed calls with the done chunk for their own attempt", () => {
		const usage = {
			input_tokens: 10,
			output_tokens: 5,
			cache_write_tokens: null,
			cache_read_tokens: null,
			estimated: false,
		};
		const parsed = parseResponseChunks([
			{ type: "tool_use_start", id: "normal-call", name: "lookup" },
			{ type: "tool_use_args", id: "normal-call", partial_json: '{"value":1,}' },
			{ type: "tool_use_end", id: "normal-call" },
			{ type: "done", finish_reason: "tool-calls", usage },
			{ type: "tool_use_start", id: "length-call", name: "lookup" },
			{ type: "tool_use_args", id: "length-call", partial_json: '{"value":2,' },
			{ type: "tool_use_end", id: "length-call" },
			{ type: "done", finish_reason: "length", usage },
		]);

		expect(
			parsed.toolCalls.map(({ finishReason, truncated }) => ({ finishReason, truncated })),
		).toEqual([
			{ finishReason: "tool-calls", truncated: false },
			{ finishReason: "length", truncated: true },
		]);
	});
});

describe("parseResponseChunks thinking encrypted content", () => {
	it("captures reasoning_encrypted_content from a thinking chunk", () => {
		const chunks: StreamChunk[] = [
			{
				type: "thinking",
				content: "weighing options",
				reasoning_encrypted_content: "enc-blob-xyz",
			},
			{ type: "text", content: "answer" },
		];
		const parsed = parseResponseChunks(chunks);
		expect(parsed.thinking).toBe("weighing options");
		expect(parsed.thinkingEncryptedContent).toBe("enc-blob-xyz");
		expect(parsed.textContent).toBe("answer");
	});
});

describe("parseResponseChunks stream error chunk", () => {
	it("warns on an error chunk without aborting the rest of the parse", () => {
		const { logger, warnings } = captureLogger();
		const chunks: StreamChunk[] = [
			{ type: "text", content: "partial" },
			{ type: "error", error: "upstream blip" },
			{ type: "text", content: " more" },
		];
		const parsed = parseResponseChunks(chunks, { logger });
		// Parsing continues past the error chunk.
		expect(parsed.textContent).toBe("partial more");
		const errorWarn = warnings.find((w) => w.message.includes("Stream error chunk in response"));
		expect(errorWarn).toBeDefined();
		expect(errorWarn?.metadata).toEqual({ error: "upstream blip" });
	});
});

describe("parseResponseChunks heartbeat chunk", () => {
	it("ignores heartbeat chunks and still parses surrounding content", () => {
		const chunks: StreamChunk[] = [
			{ type: "heartbeat" },
			{ type: "text", content: "alive" },
			{ type: "heartbeat" },
		];
		const parsed = parseResponseChunks(chunks);
		expect(parsed.textContent).toBe("alive");
	});
});

describe("parseResponseChunks declined outcome (slice 5, R-RT15/R-RT17)", () => {
	it("carries the done chunk's ModelDeclinedOutcome through to ParsedResponse", () => {
		const chunks: StreamChunk[] = [
			{ type: "text", content: "partial" },
			{
				type: "done",
				usage: {
					input_tokens: 10,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "content-filter",
				declined: {
					kind: "model-declined",
					vendor: "anthropic",
					category: "cyber",
					raw_reason: "refusal",
					substitutable: true,
				},
			},
		];
		const parsed = parseResponseChunks(chunks);
		expect(parsed.finishReason).toBe("content-filter");
		expect(parsed.declined?.category).toBe("cyber");
		expect(parsed.declined?.substitutable).toBe(true);
	});

	it("leaves declined null on a clean completion", () => {
		const chunks: StreamChunk[] = [
			{ type: "text", content: "done" },
			{
				type: "done",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "stop",
			},
		];
		const parsed = parseResponseChunks(chunks);
		expect(parsed.declined).toBeNull();
	});

	it("records each done chunk as a distinct attempt when a stream carries a refusal then a served retry", () => {
		// The driver-level inline credit redemption (slice 5, R-RT18) yields the
		// refused primary attempt's chunks AND the served retry's chunks on ONE
		// stream. parseResponseChunks must surface each done chunk as a separate
		// attempt so recordTurn can account for both (R-RT21) and the final
		// finishReason/usage reflects the SERVED attempt, not the refusal.
		const chunks: StreamChunk[] = [
			{ type: "text", content: "refused partial" },
			{
				type: "done",
				usage: {
					input_tokens: 10,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "content-filter",
				declined: {
					kind: "model-declined",
					vendor: "anthropic",
					category: "cyber",
					raw_reason: "refusal",
					substitutable: true,
				},
			},
			{ type: "text", content: "here is a safe answer" },
			{
				type: "done",
				usage: {
					input_tokens: 12,
					output_tokens: 20,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "stop",
			},
		];
		const parsed = parseResponseChunks(chunks);
		// Two attempts recorded, in stream order.
		expect(parsed.attempts).toHaveLength(2);
		expect(parsed.attempts[0].declined?.category).toBe("cyber");
		expect(parsed.attempts[0].finishReason).toBe("content-filter");
		expect(parsed.attempts[1].declined).toBeNull();
		expect(parsed.attempts[1].finishReason).toBe("stop");
		// Top-level fields reflect the SERVED (last) attempt.
		expect(parsed.finishReason).toBe("stop");
		expect(parsed.declined).toBeNull();
		expect(parsed.usage.outputTokens).toBe(20);
	});

	it("records a single attempt for a clean one-done stream (byte-identical single-attempt path)", () => {
		const chunks: StreamChunk[] = [
			{ type: "text", content: "hello" },
			{
				type: "done",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "stop",
			},
		];
		const parsed = parseResponseChunks(chunks);
		expect(parsed.attempts).toHaveLength(1);
		expect(parsed.attempts[0].finishReason).toBe("stop");
	});
});
