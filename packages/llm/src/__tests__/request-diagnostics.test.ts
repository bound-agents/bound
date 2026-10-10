/**
 * Regression tests for the Responses request-shape diagnostics.
 *
 * The diagnostic exists because the OpenAI Responses API rejects a malformed
 * `input` at the wire (`Invalid 'input': value did not match any expected
 * variant`) with no recoverable record of the offending item. These tests pin
 * two behaviors: the summarizer carries structure but NEVER payload, and the
 * error classifier catches the invalid-`input` family across the AI SDK's
 * wrapped-error shapes.
 */
import { isResponsesInputRejection, summarizeRequestShape } from "../bridge/request-diagnostics";
const PNG = Buffer.from("png-bytes").toString("base64");
const SECRET_TEXT = "SENSITIVE prompt text that must never appear in diagnostics";
const SECRET_ARG = "s3cr3t-argument-value";

describe("summarizeRequestShape — structure without payload", () => {
	it("summarizes roles, block kinds, media types, tool names, and tool-result output forms", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: SECRET_TEXT },
			{
				role: "assistant",
				content: [
					{ type: "text", text: SECRET_TEXT },
					{ type: "tool_use", id: "call_1", name: "boundless_read", input: { path: SECRET_ARG } },
				],
			},
			{
				role: "tool_result",
				tool_use_id: "call_1",
				content: [
					{ type: "text", text: "here:" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
				],
			},
		];

		const shape = summarizeRequestShape(messages);

		expect(shape.messageCount).toBe(3);
		expect(shape.roleCounts).toEqual({ user: 1, assistant: 1, tool_result: 1 });
		// Block kinds summed across the whole request.
		expect(shape.blockKindCounts).toEqual({ text: 2, tool_use: 1, image: 1 });
		expect(shape.mediaTypes).toEqual(["image/png"]);
		expect(shape.toolNames).toEqual(["boundless_read"]);
		// The tool_result carries a non-text block → "content" output form.
		expect(shape.toolResultOutputForms).toEqual({ content: 1 });

		// Per-message shape, in order.
		expect(shape.messages[0]).toEqual({ role: "user", stringContent: true, blockKinds: {} });
		expect(shape.messages[2]).toEqual({
			role: "tool_result",
			stringContent: false,
			blockKinds: { text: 1, image: 1 },
			toolResultOutputForm: "content",
			mediaTypes: ["image/png"],
			hasToolUseId: true,
		});
	});

	it("classifies an all-text tool_result as the 'text' output form", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_result",
				tool_use_id: "call_x",
				content: [{ type: "text", text: SECRET_TEXT }],
			},
		];
		const shape = summarizeRequestShape(messages);
		expect(shape.toolResultOutputForms).toEqual({ text: 1 });
		expect(shape.messages[0].toolResultOutputForm).toBe("text");
	});

	it("NEVER leaks prompt text, base64 data, or raw tool arguments", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: SECRET_TEXT },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: SECRET_TEXT },
					{ type: "tool_use", id: "call_1", name: "sh", input: { cmd: SECRET_ARG } },
				],
			},
			{
				role: "tool_result",
				tool_use_id: "call_1",
				content: [
					{ type: "text", text: SECRET_TEXT },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: PNG },
						text_representation: SECRET_TEXT,
					},
				],
			},
		];

		// The entire serialized summary must contain none of the secrets.
		const serialized = JSON.stringify(summarizeRequestShape(messages));
		expect(serialized).not.toContain(SECRET_TEXT);
		expect(serialized).not.toContain(SECRET_ARG);
		expect(serialized).not.toContain(PNG);
		// It DOES carry the safe structural facts.
		expect(serialized).toContain("image/png");
		expect(serialized).toContain("application/pdf");
		expect(serialized).toContain("tool_use");
	});

	it("bounds the tool-name list to 10 distinct names", () => {
		const content = Array.from({ length: 15 }, (_, i) => ({
			type: "tool_use" as const,
			id: `call_${i}`,
			name: `tool_${i}`,
			input: {},
		}));
		const shape = summarizeRequestShape([{ role: "assistant", content }]);
		expect(shape.toolNames).toHaveLength(10);
	});
});

describe("isResponsesInputRejection — error classification", () => {
	it("matches the canonical Responses variant-mismatch message", () => {
		expect(
			isResponsesInputRejection(
				new Error("Invalid 'input': value did not match any expected variant"),
			),
		).toBe(true);
	});

	it("matches when the detail rides on a wrapped APICallError's responseBody", () => {
		// Shape mirrors the AI SDK: RetryError.lastError = APICallError whose
		// .message is bare status text and .responseBody carries the JSON detail.
		const apiCallError = {
			message: "Bad Request",
			responseBody: JSON.stringify({
				error: { message: "Invalid 'input': value did not match any expected variant" },
			}),
		};
		const retryError = { message: "Failed after 3 attempts", lastError: apiCallError };
		expect(isResponsesInputRejection(retryError)).toBe(true);
	});

	it("matches the broader 'invalid request body' + input phrasing", () => {
		expect(
			isResponsesInputRejection(
				new Error("ai-sdk request failed: invalid request body: bad 'input' field"),
			),
		).toBe(true);
	});

	it("does not match an unrelated error (empty completion, 429, cancellation)", () => {
		expect(isResponsesInputRejection(new Error("empty completion (output_tokens=0)"))).toBe(false);
		expect(isResponsesInputRejection(new Error("Too Many Requests"))).toBe(false);
		expect(isResponsesInputRejection(new Error("The operation was aborted"))).toBe(false);
		expect(isResponsesInputRejection(null)).toBe(false);
		expect(isResponsesInputRejection(undefined)).toBe(false);
		expect(isResponsesInputRejection("just a string")).toBe(false);
	});

	it("does not loop on a self-referential cause chain", () => {
		const a: { message: string; cause?: unknown } = { message: "outer" };
		a.cause = a;
		expect(isResponsesInputRejection(a)).toBe(false);
	});
});
