import { describe, expect, it } from "bun:test";
import type { LLMFinishReason, StreamChunk } from "@bound/llm";
import { boundedJsonParseError, hasUnparseableArgs, parseResponseChunks } from "../stream-parser";

/**
 * #307: a tool-call argument parse failure is a max_tokens truncation only when
 * the stream ended on a length stop. On any other finish it is malformed JSON.
 * Either way the call stays non-executable and nothing logs the argument text.
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

const SECRET_ARGS = '{"path":"/secret/sauce.txt","value":1,}';

function toolTurn(args: string, finishReason: LLMFinishReason): StreamChunk[] {
	return [
		{ type: "tool_use_start", id: "call-1", name: "boundless_edit" },
		{ type: "tool_use_args", id: "call-1", partial_json: args },
		{ type: "tool_use_end", id: "call-1" },
		{
			type: "done",
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
			finish_reason: finishReason,
		},
	];
}

describe("parseResponseChunks tool-arg parse failures (#307)", () => {
	it("reports invalid JSON, not truncation, when the response finished normally", () => {
		const { logger, warnings } = captureLogger();
		const parsed = parseResponseChunks(toolTurn(SECRET_ARGS, "tool-calls"), { logger });

		expect(parsed.finishReason).toBe("tool-calls");
		const [call] = parsed.toolCalls;
		expect(call.truncated).toBe(false);
		expect(call.input).toEqual({});
		expect(call.argsError?.kind).toBe("invalid_json");
		expect(call.argsError?.finishReason).toBe("tool-calls");
		expect(call.argsError?.argsLength).toBe(SECRET_ARGS.length);
		expect(call.argsError?.parseError.length).toBeGreaterThan(0);
		expect(hasUnparseableArgs(call)).toBe(true);

		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain("not valid JSON");
		expect(warnings[0].message).not.toContain("max_tokens");
		expect(warnings[0].metadata?.finishReason).toBe("tool-calls");
		expect(JSON.stringify(warnings)).not.toContain("secret");
	});

	it("reports truncation when the response ended on a length stop with unfinished JSON", () => {
		const { logger, warnings } = captureLogger();
		const unfinished = '{"path":"/secret/sauce.txt","conte';
		const parsed = parseResponseChunks(toolTurn(unfinished, "length"), { logger });

		const [call] = parsed.toolCalls;
		expect(call.truncated).toBe(true);
		expect(call.argsError?.kind).toBe("truncated");
		expect(call.argsError?.finishReason).toBe("length");
		expect(hasUnparseableArgs(call)).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain("output-token limit");
		expect(JSON.stringify(warnings)).not.toContain("secret");
	});

	it("leaves a valid call untouched", () => {
		const parsed = parseResponseChunks(toolTurn('{"value":1}', "tool-calls"));
		const [call] = parsed.toolCalls;
		expect(call.input).toEqual({ value: 1 });
		expect(call.truncated).toBe(false);
		expect(call.argsError).toBeUndefined();
		expect(hasUnparseableArgs(call)).toBe(false);
	});
});

describe("boundedJsonParseError", () => {
	it("elides quoted spans and caps the message length", () => {
		const message = boundedJsonParseError(
			new SyntaxError(
				`Unexpected token in "${"x".repeat(500)}" is not valid JSON ${"y".repeat(300)}`,
			),
		);
		expect(message).not.toContain("xxx");
		expect(message.length).toBeLessThanOrEqual(121);
	});
});
