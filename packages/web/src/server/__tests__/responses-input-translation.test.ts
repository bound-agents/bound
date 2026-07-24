import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import { inputToMessages } from "../routes/responses";

describe("inputToMessages — function_call / function_call_output translation", () => {
	it("maps a function_call item to a tool_call LLMMessage", () => {
		const input = [
			{ role: "user", content: "list files" },
			{ type: "function_call", call_id: "fc_1", name: "shell_exec", arguments: '{"command":"ls"}' },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("tool_call");
		const blocks = messages[1].content as LLMMessage["content"];
		expect(Array.isArray(blocks)).toBe(true);
		const toolUse = (blocks as Extract<typeof blocks, { type: string }[]>)[0];
		expect(toolUse.type).toBe("tool_use");
		expect(toolUse.id).toBe("fc_1");
		expect(toolUse.name).toBe("shell_exec");
		expect(toolUse.input).toEqual({ command: "ls" });
	});

	it("maps a function_call_output item to a tool_result LLMMessage", () => {
		const input = [
			{ role: "user", content: "list files" },
			{ type: "function_call", call_id: "fc_1", name: "shell_exec", arguments: '{"command":"ls"}' },
			{ type: "function_call_output", call_id: "fc_1", output: "file1.txt\nfile2.txt" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(3);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("tool_call");
		expect(messages[2].role).toBe("tool_result");
		expect(messages[2].tool_use_id).toBe("fc_1");
		expect(messages[2].content).toBe("file1.txt\nfile2.txt");
	});

	it("does not end on an assistant message when tool calls follow it (the prefill bug)", () => {
		// This is the exact shape that triggered the production incident:
		// [..., assistant, function_call, function_call_output] — without the
		// fix, function_call and function_call_output were silently dropped,
		// leaving the assistant message at the tail.
		const input = [
			{ role: "user", content: "read config.yaml" },
			{ role: "assistant", content: "I'll read the file for you." },
			{
				type: "function_call",
				call_id: "fc_42",
				name: "file_read",
				arguments: '{"path":"config.yaml"}',
			},
			{ type: "function_call_output", call_id: "fc_42", output: "contents here" },
			{ role: "user", content: "now update it" },
		];
		const messages = inputToMessages(input);
		const last = messages[messages.length - 1];
		expect(last.role).not.toBe("assistant");
		expect(last.role).toBe("user");
		expect(messages).toHaveLength(5);
	});

	it("parses arguments JSON into the tool_use input object", () => {
		const input = [
			{
				type: "function_call",
				call_id: "fc_1",
				name: "write_file",
				arguments: '{"path": "config.yaml", "content": "hello: world"}',
			},
		];
		const messages = inputToMessages(input);
		const blocks = messages[0].content as Extract<LLMMessage["content"], { type: string }[]>;
		expect(blocks[0].input).toEqual({ path: "config.yaml", content: "hello: world" });
	});

	it("handles malformed arguments JSON by falling back to _raw", () => {
		const input = [
			{
				type: "function_call",
				call_id: "fc_1",
				name: "shell_exec",
				arguments: "not valid json",
			},
		];
		const messages = inputToMessages(input);
		const blocks = messages[0].content as Extract<LLMMessage["content"], { type: string }[]>;
		expect(blocks[0].input).toEqual({ _raw: "not valid json" });
	});

	it("handles empty arguments string", () => {
		const input = [{ type: "function_call", call_id: "fc_1", name: "ping", arguments: "" }];
		const messages = inputToMessages(input);
		const blocks = messages[0].content as Extract<LLMMessage["content"], { type: string }[]>;
		expect(blocks[0].input).toEqual({});
	});

	it("skips function_call items missing call_id or name", () => {
		const input = [
			{ type: "function_call", call_id: "fc_1", name: "shell_exec", arguments: "{}" },
			{ type: "function_call", call_id: "fc_2", arguments: "{}" },
			{ type: "function_call", name: "no_id", arguments: "{}" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("tool_call");
	});

	it("skips function_call_output items missing call_id", () => {
		const input = [
			{ type: "function_call_output", call_id: "fc_1", output: "ok" },
			{ type: "function_call_output", output: "no call_id" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(1);
		expect(messages[0].tool_use_id).toBe("fc_1");
	});

	it("handles function_call_output with missing output as empty string", () => {
		const input = [{ type: "function_call_output", call_id: "fc_1" }];
		const messages = inputToMessages(input);
		expect(messages[0].content).toBe("");
	});

	it("still handles plain message items (string input)", () => {
		const messages = inputToMessages("hello world");
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe("hello world");
	});

	it("still handles role-based message items in an array", () => {
		const input = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "bye" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(3);
		expect(messages[2].role).toBe("user");
	});
});
