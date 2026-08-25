import { describe, expect, it } from "bun:test";
import type { ContentBlock, StreamChunk } from "@bound/llm";
import { SseEmitter, assembleOutput, buildOutputItems, inputToMessages } from "../routes/responses";

// ── Input side: reasoning items → thinking ContentBlocks ────────────────────

describe("inputToMessages — reasoning item translation", () => {
	it("attaches a reasoning item to the following function_call as a thinking block", () => {
		const input = [
			{ role: "user", content: "list files" },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "I should list the directory." }],
				encrypted_content: "ENCRYPTED_BLOB",
			},
			{ type: "function_call", call_id: "fc_1", name: "shell_exec", arguments: '{"command":"ls"}' },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(2);
		expect(messages[1].role).toBe("tool_call");
		const blocks = messages[1].content as ContentBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("thinking");
		const thinking = blocks[0] as Extract<ContentBlock, { type: "thinking" }>;
		expect(thinking.thinking).toBe("I should list the directory.");
		expect(thinking.reasoning_encrypted_content).toBe("ENCRYPTED_BLOB");
		expect(blocks[1].type).toBe("tool_use");
	});

	it("attaches a reasoning item to the following assistant message", () => {
		const input = [
			{ role: "user", content: "hi" },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "Greeting back." }],
				encrypted_content: "ENC",
			},
			{ role: "assistant", content: "hello" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(2);
		expect(messages[1].role).toBe("assistant");
		const blocks = messages[1].content as ContentBlock[];
		expect(blocks[0].type).toBe("thinking");
		const thinking = blocks[0] as Extract<ContentBlock, { type: "thinking" }>;
		expect(thinking.reasoning_encrypted_content).toBe("ENC");
		expect(blocks[1]).toEqual({ type: "text", text: "hello" });
	});

	it("carries a reasoning item without encrypted_content as plain thinking text", () => {
		const input = [
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "local model reasoning" }],
			},
			{ type: "function_call", call_id: "fc_1", name: "ping", arguments: "{}" },
		];
		const messages = inputToMessages(input);
		const blocks = messages[0].content as ContentBlock[];
		const thinking = blocks[0] as Extract<ContentBlock, { type: "thinking" }>;
		expect(thinking.type).toBe("thinking");
		expect(thinking.thinking).toBe("local model reasoning");
		expect(thinking.reasoning_encrypted_content).toBeUndefined();
	});

	it("joins multiple summary parts into one thinking text", () => {
		const input = [
			{
				type: "reasoning",
				id: "rs_1",
				summary: [
					{ type: "summary_text", text: "part one. " },
					{ type: "summary_text", text: "part two." },
				],
				encrypted_content: "ENC",
			},
			{ type: "function_call", call_id: "fc_1", name: "ping", arguments: "{}" },
		];
		const messages = inputToMessages(input);
		const blocks = messages[0].content as ContentBlock[];
		const thinking = blocks[0] as Extract<ContentBlock, { type: "thinking" }>;
		expect(thinking.thinking).toBe("part one. part two.");
	});

	it("accumulates consecutive reasoning items onto the next assistant-side item", () => {
		const input = [
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC1" },
			{ type: "reasoning", id: "rs_2", summary: [], encrypted_content: "ENC2" },
			{ type: "function_call", call_id: "fc_1", name: "ping", arguments: "{}" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(1);
		const blocks = messages[0].content as ContentBlock[];
		expect(blocks).toHaveLength(3);
		expect(
			(blocks[0] as { reasoning_encrypted_content?: string }).reasoning_encrypted_content,
		).toBe("ENC1");
		expect(
			(blocks[1] as { reasoning_encrypted_content?: string }).reasoning_encrypted_content,
		).toBe("ENC2");
		expect(blocks[2].type).toBe("tool_use");
	});

	it("drops a trailing reasoning item with no following assistant-side item", () => {
		const input = [
			{ role: "user", content: "hi" },
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
	});

	it("drops pending reasoning when a user message intervenes", () => {
		const input = [
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
			{ role: "user", content: "actually, stop" },
			{ role: "assistant", content: "ok" },
		];
		const messages = inputToMessages(input);
		expect(messages).toHaveLength(2);
		// The assistant message must NOT have inherited the orphaned reasoning.
		expect(messages[1].content).toBe("ok");
	});

	it("emits an assistant message whose only content is reasoning when content is empty", () => {
		const input = [
			{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "hmm" }] },
			{ role: "assistant", content: "" },
			{ role: "user", content: "go on" },
		];
		const messages = inputToMessages(input);
		// The empty assistant item would normally be skipped; with pending
		// reasoning it must survive to carry the thinking block.
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("assistant");
		const blocks = messages[0].content as ContentBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("thinking");
	});
});

// ── Output side: thinking chunks → reasoning output items ───────────────────

function doneChunk(): StreamChunk {
	return {
		type: "done",
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			cache_write_tokens: null,
			cache_read_tokens: null,
			estimated: false,
		},
		finish_reason: "stop",
	};
}

describe("assembleOutput + buildOutputItems — reasoning items", () => {
	it("emits a reasoning item with summary text and encrypted_content before the message", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Let me think about this." },
			{ type: "thinking", content: "", reasoning_encrypted_content: "ENC_STATE" },
			{ type: "text", content: "The answer is 4." },
			doneChunk(),
		];
		const { pieces, usage, finishReason } = assembleOutput(chunks);
		const items = buildOutputItems(pieces) as Array<Record<string, unknown>>;
		expect(items).toHaveLength(2);
		expect(items[0].type).toBe("reasoning");
		expect(items[0].encrypted_content).toBe("ENC_STATE");
		expect(items[0].summary).toEqual([{ type: "summary_text", text: "Let me think about this." }]);
		expect(items[1].type).toBe("message");
		expect(finishReason).toBe("stop");
		expect(usage.output_tokens).toBe(5);
	});

	it("preserves interleaved reasoning → tool_call → reasoning → tool_call order", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "first thought" },
			{ type: "thinking", content: "", reasoning_encrypted_content: "ENC1" },
			{ type: "tool_use_start", id: "call_1", name: "grep" },
			{ type: "tool_use_args", id: "call_1", partial_json: '{"q":1}' },
			{ type: "tool_use_end", id: "call_1" },
			{ type: "thinking", content: "second thought" },
			{ type: "thinking", content: "", reasoning_encrypted_content: "ENC2" },
			{ type: "tool_use_start", id: "call_2", name: "read" },
			{ type: "tool_use_end", id: "call_2" },
			doneChunk(),
		];
		const { pieces } = assembleOutput(chunks);
		const items = buildOutputItems(pieces) as Array<Record<string, unknown>>;
		expect(items.map((i) => i.type)).toEqual([
			"reasoning",
			"function_call",
			"reasoning",
			"function_call",
		]);
		expect(items[0].encrypted_content).toBe("ENC1");
		expect(items[2].encrypted_content).toBe("ENC2");
		expect((items[1] as { call_id: string }).call_id).toBe("call_1");
		expect((items[3] as { call_id: string }).call_id).toBe("call_2");
	});

	it("filters reasoning segments with neither text nor encrypted content", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "" },
			{ type: "text", content: "hi" },
			doneChunk(),
		];
		const { pieces } = assembleOutput(chunks);
		const items = buildOutputItems(pieces) as Array<Record<string, unknown>>;
		expect(items.map((i) => i.type)).toEqual(["message"]);
	});

	it("keeps signature-only (Anthropic) thinking as a summary-only reasoning item", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "anthropic reasoning", signature: "SIG" },
			{ type: "text", content: "answer" },
			doneChunk(),
		];
		const { pieces } = assembleOutput(chunks);
		const items = buildOutputItems(pieces) as Array<Record<string, unknown>>;
		expect(items[0].type).toBe("reasoning");
		expect(items[0].encrypted_content).toBeUndefined();
		expect(items[0].summary).toEqual([{ type: "summary_text", text: "anthropic reasoning" }]);
	});
});

// ── Streaming: SseEmitter reasoning item lifecycle ───────────────────────────

class FakeSse {
	events: Array<{ event?: string; data: Record<string, unknown> }> = [];
	async writeSSE(msg: { event?: string; data: string }): Promise<void> {
		this.events.push({ event: msg.event, data: JSON.parse(msg.data) });
	}
}

async function* streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const c of chunks) yield c;
}

describe("SseEmitter — reasoning item streaming", () => {
	it("emits reasoning item events and includes the item in response.completed", async () => {
		const sse = new FakeSse();
		const emitter = new SseEmitter(sse, "gpt-5.6-sol", {
			tools: [],
			toolChoice: "auto",
			parallelToolCalls: true,
		});
		await emitter.run(
			streamOf([
				{ type: "thinking", content: "pondering" },
				{ type: "thinking", content: "", reasoning_encrypted_content: "ENC" },
				{ type: "text", content: "result" },
				doneChunk(),
			]),
		);

		const types = sse.events.map((e) => e.event);
		const addedIdx = types.indexOf("response.output_item.added");
		expect(addedIdx).toBeGreaterThan(-1);
		const added = sse.events[addedIdx].data as { item: { type: string; id: string } };
		expect(added.item.type).toBe("reasoning");

		expect(types).toContain("response.reasoning_summary_text.delta");

		const doneEvents = sse.events.filter((e) => e.event === "response.output_item.done");
		const reasoningDone = doneEvents.find(
			(e) => (e.data as { item: { type: string } }).item.type === "reasoning",
		);
		expect(reasoningDone).toBeDefined();
		const doneItem = (reasoningDone?.data as { item: Record<string, unknown> }).item;
		expect(doneItem.encrypted_content).toBe("ENC");
		expect(doneItem.summary).toEqual([{ type: "summary_text", text: "pondering" }]);
		// Reasoning item id remains stable between added and done.
		expect(doneItem.id).toBe(added.item.id);

		const completed = sse.events.find((e) => e.event === "response.completed");
		const output = (completed?.data as { response: { output: Array<{ type: string }> } }).response
			.output;
		expect(output.map((o) => o.type)).toEqual(["reasoning", "message"]);

		// The reasoning item must precede the text item in the event stream.
		const textAddedIdx = sse.events.findIndex(
			(e) =>
				e.event === "response.output_item.added" &&
				(e.data as { item: { type: string } }).item.type === "message",
		);
		expect(addedIdx).toBeLessThan(textAddedIdx);
	});

	it("closes an open reasoning item at stream end even without encrypted content", async () => {
		const sse = new FakeSse();
		const emitter = new SseEmitter(sse, "kimi-k2.5", {
			tools: [],
			toolChoice: "auto",
			parallelToolCalls: true,
		});
		await emitter.run(streamOf([{ type: "thinking", content: "unterminated" }, doneChunk()]));
		const doneEvents = sse.events.filter((e) => e.event === "response.output_item.done");
		expect(doneEvents).toHaveLength(1);
		const item = (doneEvents[0].data as { item: Record<string, unknown> }).item;
		expect(item.type).toBe("reasoning");
		expect(item.encrypted_content).toBeUndefined();
	});

	it("does not emit reasoning events when a thinking chunk carries nothing", async () => {
		const sse = new FakeSse();
		const emitter = new SseEmitter(sse, "gpt-5.6-sol", {
			tools: [],
			toolChoice: "auto",
			parallelToolCalls: true,
		});
		await emitter.run(streamOf([{ type: "thinking", content: "" }, doneChunk()]));
		const itemEvents = sse.events.filter(
			(e) => e.event === "response.output_item.added" || e.event === "response.output_item.done",
		);
		expect(itemEvents).toHaveLength(0);
	});
});
