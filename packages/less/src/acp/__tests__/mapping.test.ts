import { describe, expect, it } from "bun:test";
import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import type { Message, WsStreamChunk } from "@bound/shared";
import fc from "fast-check";
import {
	messageToSessionUpdate,
	promptToText,
	streamChunkToSessionUpdate,
	toolNameToKind,
	toolResultToAcpContent,
} from "../mapping";

describe("toolNameToKind", () => {
	it("maps known boundless tools to ACP kinds", () => {
		expect(toolNameToKind("boundless_read")).toBe("read");
		expect(toolNameToKind("boundless_write")).toBe("edit");
		expect(toolNameToKind("boundless_edit")).toBe("edit");
		expect(toolNameToKind("boundless_copy")).toBe("move");
		expect(toolNameToKind("boundless_bash")).toBe("execute");
		expect(toolNameToKind("boundless_pwsh")).toBe("execute");
		expect(toolNameToKind("boundless_mcp_github_search")).toBe("other");
		expect(toolNameToKind("totally_unknown")).toBe("other");
	});
});

describe("streamChunkToSessionUpdate", () => {
	it("maps text chunks to agent_message_chunk", () => {
		const chunk: WsStreamChunk = { type: "text", content: "hello" };
		expect(streamChunkToSessionUpdate(chunk)).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hello" },
		});
	});

	it("maps thinking chunks to agent_thought_chunk", () => {
		const chunk: WsStreamChunk = { type: "thinking", content: "pondering" };
		expect(streamChunkToSessionUpdate(chunk)).toEqual({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "pondering" },
		});
	});

	it("returns null for tool_use and lifecycle chunks (handled statefully)", () => {
		expect(streamChunkToSessionUpdate({ type: "tool_use_start", id: "a", name: "x" })).toBeNull();
		expect(
			streamChunkToSessionUpdate({ type: "tool_use_args", id: "a", partial_json: "{}" }),
		).toBeNull();
		expect(streamChunkToSessionUpdate({ type: "tool_use_end", id: "a" })).toBeNull();
		expect(streamChunkToSessionUpdate({ type: "error", error: "boom" })).toBeNull();
		expect(
			streamChunkToSessionUpdate({
				type: "done",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					cache_write_tokens: 0,
					cache_read_tokens: 0,
					estimated: false,
				},
			}),
		).toBeNull();
	});
});

describe("promptToText", () => {
	it("joins text blocks", () => {
		const blocks: AcpContentBlock[] = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(promptToText(blocks)).toBe("first\n\nsecond");
	});

	it("renders resource links and embedded resources", () => {
		const blocks: AcpContentBlock[] = [
			{ type: "text", text: "see" },
			{ type: "resource_link", name: "main.py", uri: "file:///main.py" },
			{
				type: "resource",
				resource: { uri: "file:///a.txt", text: "contents", mimeType: "text/plain" },
			},
		];
		const out = promptToText(blocks);
		expect(out).toContain("see");
		expect(out).toContain("[resource: main.py (file:///main.py)]");
		expect(out).toContain("[resource file:///a.txt]\ncontents");
	});

	it("elides image and audio content with a placeholder", () => {
		const blocks: AcpContentBlock[] = [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "audio", data: "BBBB", mimeType: "audio/wav" },
		];
		const out = promptToText(blocks);
		expect(out).toContain("image content omitted");
		expect(out).toContain("audio content omitted");
	});
});

describe("messageToSessionUpdate", () => {
	const base: Omit<Message, "role" | "content" | "tool_name"> = {
		id: "m1",
		thread_id: "t1",
		model_id: null,
		created_at: new Date(0).toISOString(),
		modified_at: null,
		host_origin: "",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};

	it("maps user/assistant to message chunks", () => {
		expect(
			messageToSessionUpdate({ ...base, role: "user", content: "hi", tool_name: null }),
		).toEqual({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "hi" },
		});
		expect(
			messageToSessionUpdate({ ...base, role: "assistant", content: "yo", tool_name: null }),
		).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "yo" },
		});
	});

	it("maps tool_call/tool_result using tool_name as the call id", () => {
		const call = messageToSessionUpdate({
			...base,
			role: "tool_call",
			content: "",
			tool_name: "call-123",
		});
		expect(call).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "call-123" });
		const result = messageToSessionUpdate({
			...base,
			role: "tool_result",
			content: "done",
			tool_name: "call-123",
		});
		expect(result).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-123",
			status: "completed",
		});
	});

	it("returns null for internal roles", () => {
		for (const role of ["system", "developer", "alert", "purge"] as const) {
			expect(messageToSessionUpdate({ ...base, role, content: "x", tool_name: null })).toBeNull();
		}
	});
});

describe("toolResultToAcpContent", () => {
	it("wraps a plain string", () => {
		expect(toolResultToAcpContent("hi")).toEqual([
			{ type: "content", content: { type: "text", text: "hi" } },
		]);
	});

	it("maps text blocks and placeholders non-text blocks", () => {
		const out = toolResultToAcpContent([
			{ type: "text", text: "a" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
		]);
		expect(out[0]).toEqual({ type: "content", content: { type: "text", text: "a" } });
		expect(out[1].content.text).toBe("[image content]");
	});
});

describe("property: streaming text is lossless and ordered", () => {
	it("concatenating mapped text chunks reproduces the original stream", () => {
		fc.assert(
			fc.property(fc.array(fc.string()), (texts) => {
				const reassembled = texts
					.map((t): WsStreamChunk => ({ type: "text", content: t }))
					.map(streamChunkToSessionUpdate)
					.map((u) =>
						u && u.sessionUpdate === "agent_message_chunk" && u.content.type === "text"
							? u.content.text
							: "",
					)
					.join("");
				return reassembled === texts.join("");
			}),
		);
	});
});

describe("property: promptToText never throws and always returns a string", () => {
	it("handles arbitrary content blocks", () => {
		const arbBlock = fc.oneof(
			fc.record({ type: fc.constant("text" as const), text: fc.string() }),
			fc.record({
				type: fc.constant("resource_link" as const),
				name: fc.string(),
				uri: fc.string(),
			}),
			fc.record({
				type: fc.constant("image" as const),
				data: fc.string(),
				mimeType: fc.string(),
			}),
		);
		fc.assert(
			fc.property(fc.array(arbBlock), (blocks) => {
				const out = promptToText(blocks as AcpContentBlock[]);
				return typeof out === "string";
			}),
		);
	});
});
