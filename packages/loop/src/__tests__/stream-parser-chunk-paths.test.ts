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
