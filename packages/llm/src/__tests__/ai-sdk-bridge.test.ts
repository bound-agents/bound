/**
 * Bridge layer tests — these are the correctness floor for the AI SDK
 * migration. If one of these changes unexpectedly, the relay/agent-loop
 * plumbing downstream of the drivers is likely about to behave differently.
 *
 * Grouped by function: toModelMessages, toToolSet, mapChunks, mapError.
 */

import { describe, expect, it } from "bun:test";
import { mapChunks, mapError, toModelMessages, toToolSet } from "../ai-sdk-bridge";
import type { LLMMessage, StreamChunk } from "../types";
import { LLMError } from "../types";

// Helper to drain an async iterable into an array.
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) out.push(x);
	return out;
}

// Helper: AI SDK fullStream is an AsyncIterable of events; synthesize one.
async function* events(...parts: Array<Record<string, unknown>>): AsyncIterable<unknown> {
	for (const p of parts) yield p;
}

describe("toModelMessages — basic role mapping", () => {
	it("passes string user content through", () => {
		const out = toModelMessages([{ role: "user", content: "hello" }]);
		expect(out).toEqual([{ role: "user", content: "hello" }]);
	});

	it("passes string assistant content through", () => {
		// Prefix with a user message — the conversation-start invariant
		// (covered in its own describe block below) would otherwise prepend
		// a placeholder. We want to isolate the assistant-passthrough behavior.
		const out = toModelMessages([
			{ role: "user", content: "hi there" },
			{ role: "assistant", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi there" },
			{ role: "assistant", content: "hi" },
		]);
	});

	it("passes string system content through", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "system", content: "sys" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "system", content: "sys" },
		]);
	});

	// developer-role messages carry volatile context (enrichment, platform
	// context, model switches). They are emitted interleaved with history —
	// the agent loop always appends one at the tail before calling the LLM,
	// so they can appear between user/assistant turns. Bedrock rejects
	// multiple system messages separated by user/assistant, so we merge
	// developer content into the neighboring user message, wrapped in a
	// <system-context> tag so the model can tell it apart from user input.
	// Contract: "mapped by drivers to <system-context>-wrapped text prepended
	// to the next user message" (CLAUDE.md).

	it("prepends developer content to the next user message", () => {
		const out = toModelMessages([
			{ role: "developer", content: "dev note" },
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "<system-context>\ndev note\n</system-context>\n\nhi" },
		]);
	});

	it("appends developer content to the last user message when none follows", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "there" },
			{ role: "developer", content: "enrichment tail" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi\n\n<system-context>\nenrichment tail\n</system-context>" },
			{ role: "assistant", content: "there" },
		]);
	});

	it("merges multiple developer messages into one wrapped block", () => {
		const out = toModelMessages([
			{ role: "developer", content: "first" },
			{ role: "developer", content: "second" },
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "<system-context>\nfirst\n\nsecond\n</system-context>\n\nhi" },
		]);
	});

	it("extracts text from developer block content before merging", () => {
		const out = toModelMessages([
			{
				role: "developer",
				content: [
					{ type: "text", text: "part-a " },
					{ type: "text", text: "part-b" },
				],
			},
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{
				role: "user",
				content: "<system-context>\npart-a part-b\n</system-context>\n\nhi",
			},
		]);
	});

	it("wraps developer-only input as a user message (conversation-start invariant)", () => {
		// Scheduler wakeup threads can have no pre-existing user message in
		// history; the bridge promotes the developer content into a synthetic
		// user-role message so the provider accepts the request. See the
		// "conversation-start invariant" describe block below for full coverage.
		const out = toModelMessages([{ role: "developer", content: "orphan" }]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toEqual("<system-context>\norphan\n</system-context>");
	});

	it("merges developer into a user message that has content blocks", () => {
		const out = toModelMessages([
			{ role: "developer", content: "dev note" },
			{
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "text", text: "also" },
				],
			},
		]);
		expect(out).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "<system-context>\ndev note\n</system-context>" },
					{ type: "text", text: "keep" },
					{ type: "text", text: "also" },
				],
			},
		]);
	});
});

// Bedrock (and most providers) require the conversation to start with a
// user-role message. The scheduler produces wakeup threads shaped as
// [developer(wakeup), tool_call(retrieve_task), tool_result(payload)] with
// NO user message in history (by design — the task payload rides on the
// synthetic tool_result). The bridge must guarantee the resulting AI SDK
// ModelMessage[] starts with a user message, otherwise Bedrock returns
// "A conversation must start with a user message".
//
// This is the layer where the provider contract is enforced — individual
// drivers (bedrock-driver, openai-compatible-driver) both route through
// toModelMessages and share this invariant.
describe("toModelMessages — conversation-start invariant", () => {
	it("prepends a user message wrapping dev content when history starts with non-user (scheduler wakeup shape)", () => {
		const out = toModelMessages([
			{ role: "developer", content: "[Task wakeup] task triggered." },
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc1", name: "retrieve_task", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "tc1",
				content: [{ type: "text", text: "payload" }],
			},
		]);
		expect(out.length).toBe(3);
		expect(out[0].role).toBe("user");
		// Developer wakeup content survives — wrapped in <system-context>
		// so the model can distinguish it from user-authored input.
		expect(out[0].content).toEqual(
			"<system-context>\n[Task wakeup] task triggered.\n</system-context>",
		);
		expect(out[1].role).toBe("assistant");
		expect(out[2].role).toBe("tool");
	});

	it("prepends a neutral placeholder when no dev content and first message is non-user", () => {
		// Defense-in-depth: even without developer content, if the history
		// happens to lead with assistant/tool/system, the bridge must still
		// produce a user-starting conversation. The old toBedrockMessages
		// used "<system-notification />" for this; we preserve that shape.
		const out = toModelMessages([
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc1", name: "x", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "tc1",
				content: [{ type: "text", text: "r" }],
			},
		]);
		expect(out[0].role).toBe("user");
	});

	it("does nothing when the first message is already user", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
		expect(out.length).toBe(2);
		expect(out[0]).toEqual({ role: "user", content: "hi" });
	});

	it("wraps a developer-only input as a sendable user message (was: silently dropped)", () => {
		// Previously this returned [] — sendable nowhere. With the invariant
		// enforced, we produce a single user message carrying the dev content
		// so the model at least sees the context.
		const out = toModelMessages([{ role: "developer", content: "orphan dev" }]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toEqual("<system-context>\norphan dev\n</system-context>");
	});
});

describe("toModelMessages — content blocks", () => {
	it("converts text blocks to text parts, dropping empty", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "text", text: "" }, // dropped
				],
			},
		]);
		expect(out[0].content).toEqual([{ type: "text", text: "keep" }]);
	});

	it("converts thinking blocks to reasoning parts", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reasoning text", signature: "sig-1" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "reasoning text",
				providerOptions: { bedrock: { signature: "sig-1" } },
			},
			{ type: "text", text: "answer" },
		]);
	});

	it("omits providerOptions on reasoning when no signature", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "bare" }],
			},
		]);
		expect(out[1].content).toEqual([{ type: "reasoning", text: "bare" }]);
	});

	it("converts base64 image blocks on user messages", () => {
		const data = Buffer.from("hello").toString("base64");
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data },
					},
				],
			},
		]);
		const part = (out[0].content as Array<{ type: string }>)[0] as {
			type: string;
			image: Uint8Array;
			mediaType: string;
		};
		expect(part.type).toBe("image");
		expect(part.mediaType).toBe("image/png");
		expect(Array.from(part.image)).toEqual([...Buffer.from("hello")]);
	});

	it("skips file_ref images (no AI SDK shape yet)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "file_ref", file_id: "f1" },
					},
				],
			},
		]);
		// No image part — falls through to empty-parts synthesis.
		expect(out[0].content).toEqual([{ type: "text", text: "" }]);
	});

	it("routes image blocks on assistant messages through FilePart (AssistantContent forbids ImagePart but allows FilePart)", () => {
		const data = Buffer.from("x").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "plot please" },
			{
				role: "assistant",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data },
						description: "a plot",
					},
					{ type: "text", text: "here it is" },
				],
			},
		]);
		const parts = out[1].content as Array<Record<string, unknown>>;
		expect(parts[0]).toMatchObject({
			type: "file",
			mediaType: "image/png",
			filename: "a plot",
		});
		expect((parts[0] as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array);
		expect(parts[1]).toEqual({ type: "text", text: "here it is" });
	});

	it("skips image blocks with file_ref source at driver layer (contract: resolved upstream)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "file_ref", file_id: "f1" },
					},
					{ type: "text", text: "describe this" },
				],
			},
		]);
		expect(out[0].content).toEqual([{ type: "text", text: "describe this" }]);
	});

	it("routes document base64 blocks as FilePart with IANA mediaType", () => {
		const data = Buffer.from("%PDF-1.4 ...").toString("base64");
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data },
						filename: "report.pdf",
						title: "Q3 Report",
					},
				],
			},
		]);
		const parts = out[0].content as Array<Record<string, unknown>>;
		expect(parts[0]).toMatchObject({
			type: "file",
			mediaType: "application/pdf",
			filename: "report.pdf",
		});
		expect((parts[0] as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array);
	});

	it("routes document base64 on assistant messages through FilePart", () => {
		const data = Buffer.from("...").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "csv please" },
			{
				role: "assistant",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "text/csv", data },
						filename: "out.csv",
					},
				],
			},
		]);
		expect(out[1].content).toMatchObject([
			{ type: "file", mediaType: "text/csv", filename: "out.csv" },
		]);
	});

	it("falls back to text_representation when document source is file_ref (unresolved)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "file_ref", file_id: "doc1" },
						text_representation: "extracted pdf text",
					},
				],
			},
		]);
		expect(out[0].content).toEqual([{ type: "text", text: "extracted pdf text" }]);
	});

	it("drops document blocks with neither base64 source nor text_representation", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "file_ref", file_id: "orphan" },
					},
				],
			},
		]);
		// Empty-parts synthesis kicks in to keep message ordering stable.
		expect(out[0].content).toEqual([{ type: "text", text: "" }]);
	});

	it("propagates thinking.redacted_data to providerOptions.bedrock.redactedData", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						redacted_data: "BLOB",
					},
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "",
				providerOptions: { bedrock: { redactedData: "BLOB" } },
			},
			{ type: "text", text: "answer" },
		]);
	});

	it("merges signature and redacted_data under the same bedrock bucket", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "visible reasoning",
						signature: "SIG",
						redacted_data: "RED",
					},
				],
			},
		]);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "visible reasoning",
				providerOptions: { bedrock: { signature: "SIG", redactedData: "RED" } },
			},
		]);
	});

	it("synthesizes empty text part when parts list would be empty", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{ role: "assistant", content: [] },
		]);
		expect(out[1].content).toEqual([{ type: "text", text: "" }]);
	});
});

describe("toModelMessages — tool call / result wrapping", () => {
	// These tests all prepend a user message so they exercise tool-call /
	// tool-result wrapping in isolation, unaffected by the conversation-start
	// invariant (covered separately above). out[0] is the user prefix;
	// wrapping outputs start at out[1].
	it("wraps tool_call message as assistant with tool-call part", () => {
		const out = toModelMessages([
			{ role: "user", content: "weather?" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "get_weather",
						input: { city: "Tokyo" },
					},
				],
			},
		]);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "get_weather",
					input: { city: "Tokyo" },
				},
			],
		});
	});

	it("wraps tool_result with resolved toolName from prior tool_call", () => {
		const out = toModelMessages([
			{ role: "user", content: "weather?" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_42",
						name: "get_weather",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "call_42",
				content: [{ type: "text", text: "72F" }],
			},
		]);
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_42",
					toolName: "get_weather",
					output: { type: "text", value: "72F" },
				},
			],
		});
	});

	it("resolves toolName when tool_call appears inline in assistant message", () => {
		const out = toModelMessages([
			{ role: "user", content: "search x" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{
						type: "tool_use",
						id: "inline_1",
						name: "search",
						input: { q: "x" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "inline_1",
				content: [{ type: "text", text: "ok" }],
			},
		]);
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "inline_1",
					toolName: "search",
					output: { type: "text", value: "ok" },
				},
			],
		});
	});

	it("falls back to empty toolName when no matching call", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{
				role: "tool_result",
				tool_use_id: "orphan",
				content: [{ type: "text", text: "?" }],
			},
		]);
		expect(out[1]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "orphan",
					toolName: "",
					output: { type: "text", value: "?" },
				},
			],
		});
	});

	it("parses JSON string content on tool_call (DB serialization path)", () => {
		const blocks = [{ type: "tool_use", id: "x", name: "y", input: { a: 1 } }];
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{ role: "tool_call", content: JSON.stringify(blocks) },
		]);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "x", toolName: "y", input: { a: 1 } }],
		});
	});

	it("treats unparseable string on tool_result as text", () => {
		const out = toModelMessages([
			{ role: "user", content: "do it" },
			{
				role: "tool_result",
				tool_use_id: "z",
				content: "plain string result",
			},
		]);
		expect(out[1]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "z",
					toolName: "",
					output: { type: "text", value: "plain string result" },
				},
			],
		});
	});
});

describe("toModelMessages — cache marker", () => {
	it("attaches bedrock cachePoint to previous message", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: "bedrock" },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toEqual({
			bedrock: { cachePoint: { type: "default" } },
		});
	});

	it("attaches anthropic cacheControl to previous message", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: "anthropic" },
		);
		expect(out[0].providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
	});

	it("drops cache marker silently when provider is null", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: null },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toBeUndefined();
	});

	it("drops leading cache marker with no prior message", () => {
		const out = toModelMessages(
			[
				{ role: "cache", content: "" },
				{ role: "user", content: "hi" },
			],
			{ cacheProvider: "bedrock" },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toBeUndefined();
	});
});

describe("toToolSet", () => {
	it("returns undefined when no tools", () => {
		expect(toToolSet()).toBeUndefined();
		expect(toToolSet([])).toBeUndefined();
	});

	it("builds a ToolSet keyed by function name", () => {
		const tools = toToolSet([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Get weather for a city",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			},
		]);
		expect(tools).toBeDefined();
		if (!tools) throw new Error("tools undefined");
		expect(Object.keys(tools)).toEqual(["get_weather"]);
		expect(tools.get_weather.description).toBe("Get weather for a city");
	});
});

describe("mapChunks — text and reasoning", () => {
	it("emits text chunks for text-delta events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "hello " },
					{ type: "text-delta", id: "t1", text: "world" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "text")).toEqual([
			{ type: "text", content: "hello " },
			{ type: "text", content: "world" },
		]);
	});

	it("drops empty text-delta events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "text")).toHaveLength(0);
	});

	it("emits thinking chunks for reasoning-delta text", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "analyzing..." },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "analyzing..." },
		]);
	});

	it("emits signature on reasoning-delta with empty text + providerMetadata.bedrock.signature", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "thinking" },
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { bedrock: { signature: "SIG-ABC" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		const thinking = out.filter((c) => c.type === "thinking");
		expect(thinking).toEqual([
			{ type: "thinking", content: "thinking" },
			{ type: "thinking", content: "", signature: "SIG-ABC" },
		]);
	});

	it("emits anthropic signature from providerMetadata.anthropic.signature", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { anthropic: { signature: "A-SIG" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", signature: "A-SIG" },
		]);
	});

	it("emits redacted reasoning as a dedicated redacted_data field on the thinking chunk", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { bedrock: { redactedData: "BLOB" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", redacted_data: "BLOB" },
		]);
	});

	it("emits signature and redacted_data as separate chunks when both arrive in one delta", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: {
							bedrock: { signature: "SIG", redactedData: "BLOB" },
						},
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", signature: "SIG" },
			{ type: "thinking", content: "", redacted_data: "BLOB" },
		]);
	});
});

describe("mapChunks — tool calls", () => {
	it("emits start/args/end sequence for tool-input events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "tool-input-start", id: "t1", toolName: "search" },
					{ type: "tool-input-delta", id: "t1", delta: '{"q":' },
					{ type: "tool-input-delta", id: "t1", delta: '"x"}' },
					{ type: "tool-input-end", id: "t1" },
					{ type: "finish", finishReason: "tool-calls", totalUsage: {} },
				),
			),
		);
		expect(out.slice(0, 4)).toEqual([
			{ type: "tool_use_start", id: "t1", name: "search" },
			{ type: "tool_use_args", id: "t1", partial_json: '{"q":' },
			{ type: "tool_use_args", id: "t1", partial_json: '"x"}' },
			{ type: "tool_use_end", id: "t1" },
		]);
	});
});

describe("mapChunks — finish / usage", () => {
	it("extracts cache-write tokens from finish-step providerMetadata (bedrock)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "answer" },
					{
						type: "finish-step",
						providerMetadata: {
							bedrock: { usage: { cacheWriteInputTokens: 1024 } },
						},
					},
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: {
							inputTokens: 500,
							outputTokens: 50,
							cachedInputTokens: 100,
						},
					},
				),
				{ usageProvider: "bedrock" },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage).toEqual({
			input_tokens: 500,
			output_tokens: 50,
			cache_write_tokens: 1024,
			cache_read_tokens: 100,
			estimated: false,
		});
	});

	it("extracts cache-write tokens from anthropic providerMetadata", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "ok" },
					{
						type: "finish-step",
						providerMetadata: {
							anthropic: { cacheCreationInputTokens: 500 },
						},
					},
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 10, outputTokens: 2 },
					},
				),
				{ usageProvider: "anthropic" },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.cache_write_tokens).toBe(500);
	});

	it("reports null cache tokens when provider metadata absent", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "ok" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 10, outputTokens: 2 },
					},
				),
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.cache_write_tokens).toBeNull();
		expect(done?.usage.cache_read_tokens).toBeNull();
		expect(done?.usage.estimated).toBe(false);
	});

	it("falls back to char-based estimation when zero-usage + output text", async () => {
		const messages: LLMMessage[] = [{ role: "user", content: "this is a prompt of some length" }];
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "reply of some length" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: messages },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("does not estimate when there was no output at all", async () => {
		// Truly silent response — no text, no thinking, no tool calls. Without
		// any signal that work happened, we don't phantom-bill input tokens.
		const out = await collect(
			mapChunks(
				events({
					type: "finish",
					finishReason: "stop",
					totalUsage: { inputTokens: 0, outputTokens: 0 },
				}),
				{ estimateInputFromMessages: [{ role: "user", content: "x" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(false);
	});

	// bound_issue:turns-table:observability-gap — non-text responses (tool
	// calls, thinking-only) were being recorded as tokens_in=0/tokens_out=0
	// because the zero-usage fallback only fired when `outputText.length > 0`.
	// haiku cron turns (a single retrieve_task call, no text) and qwen3.6
	// threads that produced only thinking+tool_call output were the canaries.
	it("estimates usage when only a tool call was emitted (no text output)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "tool-input-start", id: "t1", toolName: "retrieve_task" },
					{ type: "tool-input-delta", id: "t1", delta: "{}" },
					{ type: "tool-input-end", id: "t1" },
					{
						type: "finish",
						finishReason: "tool-calls",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: [{ role: "user", content: "please retrieve the task" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("estimates usage when only thinking was emitted (no text output)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "let me think about this for a moment" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: [{ role: "user", content: "think carefully" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("throws an LLMError when the SDK emits a fullStream error event", async () => {
		// Background: AI SDK converts initial request failures (e.g. Bedrock
		// 403 AccessDeniedException on converse-stream) into
		// `{ type: "error", error }` chunks on `fullStream` — it does NOT
		// reject the iterator. Before this regression test, mapChunks
		// forwarded the chunk as a `{type:"error"}` StreamChunk, which
		// agent-loop silently dropped: the turn appeared to succeed with
		// empty output, no alert was emitted, and scheduled tasks quietly
		// hung forever. mapChunks now throws so the driver's try/catch
		// wraps it via mapError and the agent-loop alert path fires.
		const iter = mapChunks(
			events(
				{ type: "error", error: new Error("boom") },
				{ type: "finish", finishReason: "error", totalUsage: {} },
			),
		);
		await expect(collect(iter)).rejects.toThrow("boom");
	});

	it("throws an LLMError that carries the original provider message verbatim", async () => {
		const iter = mapChunks(
			events({
				type: "error",
				error: new Error(
					"You invoked an unsupported model or your request did not allow prompt caching.",
				),
			}),
		);
		await expect(collect(iter)).rejects.toThrow(/unsupported model/);
	});

	it("throws an LLMError even if the error is a plain object with no message", async () => {
		const iter = mapChunks(events({ type: "error", error: { statusCode: 403 } }));
		// Should still throw, not silently resolve
		let threw = false;
		try {
			await collect(iter);
		} catch (err) {
			threw = true;
			expect(err).toBeInstanceOf(LLMError);
		}
		expect(threw).toBe(true);
	});

	it("ignores events we don't model (start, text-start, reasoning-end, etc.)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "start" },
					{ type: "start-step" },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", text: "hello" },
					{ type: "text-end", id: "t1" },
					{ type: "reasoning-start", id: "r1" },
					{ type: "reasoning-end", id: "r1" },
					{ type: "response-metadata" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		// Should only see: 1 text, 1 done.
		expect(out.filter((c) => c.type === "text")).toHaveLength(1);
		expect(out.filter((c) => c.type === "done")).toHaveLength(1);
	});
});

describe("mapError", () => {
	it("passes LLMError through unchanged", () => {
		const orig = new LLMError("original", "bedrock", 500);
		const out = mapError(orig, "bedrock");
		expect(out).toBe(orig);
	});

	it("extracts statusCode from APICallError-like shape", () => {
		const err = Object.assign(new Error("bad"), {
			statusCode: 429,
			responseHeaders: {},
		});
		const out = mapError(err, "openai");
		expect(out.provider).toBe("openai");
		expect(out.statusCode).toBe(429);
	});

	it("extracts statusCode from bedrock $metadata.httpStatusCode", () => {
		const err = Object.assign(new Error("throttled"), {
			$metadata: { httpStatusCode: 503 },
		});
		const out = mapError(err, "bedrock");
		expect(out.statusCode).toBe(503);
	});

	it("parses retry-after header as seconds", () => {
		const err = Object.assign(new Error("rate"), {
			statusCode: 429,
			responseHeaders: { "retry-after": "12" },
		});
		const out = mapError(err, "openai");
		expect(out.retryAfterMs).toBe(12_000);
	});

	it("parses Title-Case Retry-After header", () => {
		const err = Object.assign(new Error("rate"), {
			statusCode: 429,
			responseHeaders: { "Retry-After": "5" },
		});
		const out = mapError(err, "openai");
		expect(out.retryAfterMs).toBe(5_000);
	});

	it("handles non-Error values", () => {
		const out = mapError("string error", "bedrock");
		expect(out).toBeInstanceOf(LLMError);
		expect(out.provider).toBe("bedrock");
		expect(out.originalError).toBeInstanceOf(Error);
	});
});
