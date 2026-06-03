import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import type { Message, WsStreamChunk } from "@bound/shared";
import fc from "fast-check";
import {
	messageToSessionUpdate,
	promptToText,
	streamChunkToSessionUpdate,
	toolCallContent,
	toolCallLocations,
	toolCallMeta,
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

describe("toolCallMeta", () => {
	it("includes Zed's programmatic tool name metadata", () => {
		expect(toolCallMeta("boundless_read", "/work", "c1")).toEqual({
			tool_name: "boundless_read",
		});
	});

	it("includes terminal metadata for shell tools", () => {
		expect(toolCallMeta("boundless_bash", "/work", "c-bash", { command: "pwd" })).toEqual({
			tool_name: "boundless_bash",
			terminal_info: { terminal_id: "c-bash", cwd: "/work" },
		});
	});

	it("includes sandbox authorization write paths for host writes", () => {
		expect(toolCallMeta("boundless_write", "/work", "c-write", { file_path: "src/a.ts" })).toEqual({
			tool_name: "boundless_write",
			sandbox_authorization: { write_paths: ["/work/src/a.ts"] },
		});
		expect(toolCallMeta("boundless_edit", "/work", "c-edit", { file_path: "/tmp/a.ts" })).toEqual({
			tool_name: "boundless_edit",
			sandbox_authorization: { write_paths: ["/tmp/a.ts"] },
		});
		expect(
			toolCallMeta("boundless_copy", "/work", "c-copy", {
				source: "sandbox",
				source_path: "/tmp/a.ts",
				target: "host",
				target_path: "copied/a.ts",
			}),
		).toEqual({
			tool_name: "boundless_copy",
			sandbox_authorization: { write_paths: ["/work/copied/a.ts"] },
		});
	});

	it("does not report sandbox write paths for sandbox copy targets", () => {
		expect(
			toolCallMeta("boundless_copy", "/work", "c-copy", {
				source: "host",
				source_path: "a.ts",
				target: "sandbox",
				target_path: "/tmp/a.ts",
			}),
		).toEqual({
			tool_name: "boundless_copy",
		});
	});
});

describe("toolCallLocations", () => {
	it("returns local file locations for host filesystem tools", () => {
		expect(toolCallLocations("boundless_read", {}, "/work")).toEqual([]);
		expect(toolCallLocations("boundless_read", { file_path: "src/a.ts" }, "/work")).toEqual([
			{ path: "/work/src/a.ts" },
		]);
		expect(toolCallLocations("boundless_edit", { file_path: "/tmp/a.ts" }, "/work")).toEqual([
			{ path: "/tmp/a.ts" },
		]);
	});

	it("carries the read offset as the follow-along line", () => {
		// boundless_read's offset is a 1-based line number; pass it through to
		// ToolCallLocation.line so the editor can scroll to where we're reading.
		expect(
			toolCallLocations("boundless_read", { file_path: "src/a.ts", offset: 200 }, "/work"),
		).toEqual([{ path: "/work/src/a.ts", line: 200 }]);
		// offset of 1 is a valid line.
		expect(
			toolCallLocations("boundless_read", { file_path: "src/a.ts", offset: 1 }, "/work"),
		).toEqual([{ path: "/work/src/a.ts", line: 1 }]);
		// no offset → no line.
		expect(toolCallLocations("boundless_read", { file_path: "src/a.ts" }, "/work")).toEqual([
			{ path: "/work/src/a.ts" },
		]);
		// non-positive / non-integer offsets are not valid lines.
		expect(
			toolCallLocations("boundless_read", { file_path: "src/a.ts", offset: 0 }, "/work"),
		).toEqual([{ path: "/work/src/a.ts" }]);
		expect(
			toolCallLocations("boundless_read", { file_path: "src/a.ts", offset: 12.5 }, "/work"),
		).toEqual([{ path: "/work/src/a.ts" }]);
		// offset only applies to reads — write/edit have no line in their args.
		expect(
			toolCallLocations("boundless_write", { file_path: "src/a.ts", offset: 200 }, "/work"),
		).toEqual([{ path: "/work/src/a.ts" }]);
	});

	it("locates the first old_string match as the edit follow-along line", () => {
		const dir = join("/tmp", `boundless-acp-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "a.ts"), "line 1\nline 2\nTARGET here\nline 4\nTARGET here\n");
			// First match begins on line 3, even though there are two.
			expect(
				toolCallLocations("boundless_edit", { file_path: "a.ts", old_string: "TARGET here" }, dir),
			).toEqual([{ path: join(dir, "a.ts"), line: 3 }]);

			// Multi-line old_string resolves to the line where the match begins.
			writeFileSync(join(dir, "b.ts"), "alpha\nbeta\ngamma\ndelta\n");
			expect(
				toolCallLocations("boundless_edit", { file_path: "b.ts", old_string: "beta\ngamma" }, dir),
			).toEqual([{ path: join(dir, "b.ts"), line: 2 }]);

			// old_string absent from the file → path-only, no line.
			expect(
				toolCallLocations("boundless_edit", { file_path: "a.ts", old_string: "nope" }, dir),
			).toEqual([{ path: join(dir, "a.ts") }]);

			// Missing old_string arg → nothing to match → path-only.
			expect(toolCallLocations("boundless_edit", { file_path: "a.ts" }, dir)).toEqual([
				{ path: join(dir, "a.ts") },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("degrades to path-only when the edit target does not exist", () => {
		expect(
			toolCallLocations(
				"boundless_edit",
				{ file_path: "/tmp/does-not-exist-acp.ts", old_string: "x" },
				"/work",
			),
		).toEqual([{ path: "/tmp/does-not-exist-acp.ts" }]);
	});

	it("does not compute a line for writes even when the file exists", () => {
		const dir = join("/tmp", `boundless-acp-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "c.ts"), "hello\nworld\n");
			expect(
				toolCallLocations("boundless_write", { file_path: "c.ts", old_string: "world" }, dir),
			).toEqual([{ path: join(dir, "c.ts") }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns only host-side copy locations", () => {
		expect(
			toolCallLocations(
				"boundless_copy",
				{
					source: "host",
					source_path: "input.txt",
					target: "host",
					target_path: "output.txt",
				},
				"/work",
			),
		).toEqual([{ path: "/work/input.txt" }, { path: "/work/output.txt" }]);
		expect(
			toolCallLocations(
				"boundless_copy",
				{
					source: "sandbox",
					source_path: "/tmp/input.txt",
					target: "host",
					target_path: "output.txt",
				},
				"/work",
			),
		).toEqual([{ path: "/work/output.txt" }]);
	});
});

describe("toolCallContent", () => {
	it("diffs a write against the existing file contents (overwrite)", () => {
		const dir = join("/tmp", `boundless-acp-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "a.ts"), "old line 1\nold line 2\n");
			expect(
				toolCallContent("boundless_write", { file_path: "a.ts", content: "new line 1\n" }, dir),
			).toEqual([
				{
					type: "diff",
					path: join(dir, "a.ts"),
					oldText: "old line 1\nold line 2\n",
					newText: "new line 1\n",
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders a brand-new write as all-additions (oldText null is the truth)", () => {
		const dir = join("/tmp", `boundless-acp-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		try {
			// File does not exist on disk — there is no prior state to diff against.
			expect(
				toolCallContent("boundless_write", { file_path: "fresh.ts", content: "hello\n" }, dir),
			).toEqual([{ type: "diff", path: join(dir, "fresh.ts"), oldText: null, newText: "hello\n" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("diffs an edit from the args without touching disk", () => {
		expect(
			toolCallContent(
				"boundless_edit",
				{ file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
				"/work",
			),
		).toEqual([{ type: "diff", path: "/tmp/x.ts", oldText: "a", newText: "b" }]);
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
