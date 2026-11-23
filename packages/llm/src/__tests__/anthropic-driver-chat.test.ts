import { describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../drivers/anthropic";
import type { ChatParams, StreamChunk } from "../types";

// Drives AnthropicDriver.chat() through an injected fetch returning a valid
// Anthropic Messages SSE stream (the same wire shape @ai-sdk/anthropic expects).
// Covers the large chat() block (bridge message/system/reasoning assembly,
// streamText invocation, chunk mapping) without contacting Anthropic.

function anthropicSse(): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-7",
				content: [],
				stop_reason: null,
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_input_tokens: 3,
					cache_read_input_tokens: 2,
				},
			},
		})}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hello" },
		})}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 7 },
		})}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	].join("");
	return new Response(events, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of it) out.push(c);
	return out;
}

const baseParams: ChatParams = {
	model: "claude-opus-4-7",
	messages: [{ role: "user", content: "hi" }],
};

describe("AnthropicDriver.chat", () => {
	it("streams a plain text turn and yields a heartbeat, text, and done", async () => {
		let captured: { url: string; body: string } | null = null;
		const captureFetch: typeof fetch = async (input, init) => {
			captured = {
				url: String(input),
				body: typeof init?.body === "string" ? init.body : "",
			};
			return anthropicSse();
		};
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-opus-4-7",
			contextWindow: 200000,
			fetch: captureFetch,
		});

		const chunks = await collect(driver.chat(baseParams));
		expect(chunks.some((c) => c.type === "heartbeat")).toBe(true);
		const text = chunks
			.filter((c): c is Extract<StreamChunk, { type: "text" }> => c.type === "text")
			.map((c) => c.content)
			.join("");
		expect(text).toContain("hello");
		expect(chunks.some((c) => c.type === "done")).toBe(true);
		expect(captured).not.toBeNull();
	});

	it("forwards extended-thinking reasoning options without a temperature", async () => {
		let body = "";
		const captureFetch: typeof fetch = async (_input, init) => {
			body = typeof init?.body === "string" ? init.body : "";
			return anthropicSse();
		};
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-opus-4-7",
			contextWindow: 200000,
			fetch: captureFetch,
		});

		await collect(
			driver.chat({
				...baseParams,
				// temperature must be dropped when reasoning is active.
				temperature: 0.9,
				thinking: { type: "enabled", budget_tokens: 2048 },
			}),
		);
		expect(body).toContain("thinking");
		// temperature is omitted alongside active reasoning.
		expect(body).not.toContain('"temperature":0.9');
	});

	it("recovers from a cache_control rejection by retrying once without the field (R-MC14)", async () => {
		// A compatible Anthropic-Messages endpoint that rejects the cache_control ttl
		// must not fail the whole turn: the driver drops the field and reissues once.
		let attempt = 0;
		const bodies: string[] = [];
		const recoveringFetch: typeof fetch = async (_input, init) => {
			bodies.push(typeof init?.body === "string" ? init.body : "");
			attempt++;
			if (attempt === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "cache_control: unsupported ttl" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return anthropicSse();
		};
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-opus-4-7",
			contextWindow: 200000,
			fetch: recoveringFetch,
		});

		// A system prompt anchors the cache_control breakpoint on the system message.
		const chunks = await collect(
			driver.chat({ ...baseParams, system: "you are a helpful assistant", cache_ttl: "1h" }),
		);
		// Two attempts total: the rejected one and the recovered one.
		expect(attempt).toBe(2);
		// The first attempt carried cache_control; the retry dropped it.
		expect(bodies[0]).toContain("cache_control");
		expect(bodies[1]).not.toContain("cache_control");
		// The turn still lands — the rejection was never a route failure.
		const text = chunks
			.filter((c): c is Extract<StreamChunk, { type: "text" }> => c.type === "text")
			.map((c) => c.content)
			.join("");
		expect(text).toContain("hello");
		expect(chunks.some((c) => c.type === "done")).toBe(true);
	});
});
