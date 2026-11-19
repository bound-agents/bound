import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { LLMError, ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { createResponsesRoutes } from "../routes/responses";

// Drives the real /v1/responses route handler end-to-end: the request handler
// body, tool/tool_choice translation, non-streaming collectResponse, the
// streaming SseEmitter, the real withTransientRetry/withFailureLog wrappers,
// and error mapping. The pure translation helpers (inputToMessages, assembleOutput,
// classifyErrorType) are covered by the sibling responses-*.test.ts files; this
// file exercises everything that only runs when a request flows through the app.

const SITE_ID = "site-test";

/** Async iterable from a fixed chunk array — no generator syntax (useYield lint). */
function chunkStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				next: () =>
					Promise.resolve(
						i < chunks.length
							? { value: chunks[i++], done: false }
							: { value: undefined as unknown as StreamChunk, done: true },
					),
			};
		},
	};
}

/** Async iterable that rejects immediately with the given error. */
function errorStream(err: Error): AsyncIterable<StreamChunk> {
	return {
		[Symbol.asyncIterator]() {
			return { next: () => Promise.reject(err) };
		},
	};
}

function doneChunk(overrides?: Partial<Extract<StreamChunk, { type: "done" }>>): StreamChunk {
	return {
		type: "done",
		usage: {
			input_tokens: 11,
			output_tokens: 7,
			cache_write_tokens: 0,
			cache_read_tokens: 3,
			estimated: false,
		},
		finish_reason: "stop",
		...overrides,
	} as StreamChunk;
}

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: false,
	vision: false,
	extended_thinking: false,
	max_context: 128_000,
};

/**
 * Minimal LLMBackend whose `chat` returns a caller-supplied stream factory, and
 * records the ChatParams it was called with so tests can assert translation.
 */
class StubBackend implements LLMBackend {
	public lastParams: ChatParams | null = null;
	public calls = 0;
	constructor(private readonly factory: (params: ChatParams) => AsyncIterable<StreamChunk>) {}
	chat(params: ChatParams): AsyncIterable<StreamChunk> {
		this.lastParams = params;
		this.calls++;
		return this.factory(params);
	}
}

/**
 * ModelRouter with a single registered local backend. `register()` uses the
 * router's own dynamic-backend primitives so resolveModel's local path resolves
 * (effective caps carry a max_context, which buildLocalResolution requires).
 */
function routerWith(modelId: string, backend: LLMBackend): ModelRouter {
	const router = new ModelRouter(new Map(), modelId);
	router.addDynamicBackend(modelId, backend, CAPS, 1);
	return router;
}

function makeDb(): Database {
	const d = new Database(":memory:");
	// The remote-model lookup in resolveModel reads the hosts table; apply the
	// real schema so an unknown-model request resolves to a 404 error object
	// rather than throwing on a missing table (which would surface as a 500).
	applySchema(d);
	return d;
}

/** Parse an SSE body into ordered { event, data } records. */
function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
	const out: Array<{ event: string; data: Record<string, unknown> }> = [];
	for (const block of body.split("\n\n")) {
		const lines = block.split("\n");
		let event = "";
		let data = "";
		for (const line of lines) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data += line.slice(5).trim();
		}
		if (event && data) out.push({ event, data: JSON.parse(data) });
	}
	return out;
}

let db: Database;
const bus = new TypedEventEmitter();

beforeEach(() => {
	db = makeDb();
});
afterEach(() => {
	db.close();
});

describe("POST /v1/responses — request validation and error mapping", () => {
	it("returns 503 when no model router is configured", async () => {
		const app = createResponsesRoutes(db, null, bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi" }),
		});
		expect(res.status).toBe(503);
		const json = (await res.json()) as { error: { message: string; type: string } };
		expect(json.error.type).toBe("server_error");
		expect(json.error.message).toContain("No model router");
	});

	it("returns 400 on an invalid JSON body", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("m", new StubBackend(chunkStream.bind(null, []))),
			bus,
			SITE_ID,
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { type: string } };
		expect(json.error.type).toBe("invalid_request_error");
	});

	it("rejects previous_response_id with a stateless 400", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("m", new StubBackend(() => chunkStream([]))),
			bus,
			SITE_ID,
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", previous_response_id: "resp_prev" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { message: string } };
		expect(json.error.message).toContain("stateless");
	});

	it("rejects a conversation field with a stateless 400", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("m", new StubBackend(() => chunkStream([]))),
			bus,
			SITE_ID,
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", conversation: "conv_1" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when input translation throws", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("m", new StubBackend(() => chunkStream([]))),
			bus,
			SITE_ID,
		);
		// function_call_output with no prior function_call → inputToMessages throws.
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				// A non-string, non-array input is rejected by inputToMessages.
				input: 42,
			}),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { type: string } };
		expect(json.error.type).toBe("invalid_request_error");
	});

	it("returns 400 on empty input", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("m", new StubBackend(() => chunkStream([]))),
			bus,
			SITE_ID,
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: [] }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { message: string } };
		expect(json.error.message).toContain("input");
	});

	it("returns 404 for an unknown model", async () => {
		const app = createResponsesRoutes(
			db,
			routerWith("known", new StubBackend(() => chunkStream([]))),
			bus,
			SITE_ID,
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "does-not-exist" }),
		});
		expect(res.status).toBe(404);
		const json = (await res.json()) as { error: { type: string; message: string } };
		expect(json.error.type).toBe("invalid_request_error");
		expect(json.error.message).toContain("does-not-exist");
	});
});

describe("POST /v1/responses — non-streaming", () => {
	it("collects a text stream into a single Response object with usage and output", async () => {
		const backend = new StubBackend(() =>
			chunkStream([{ type: "text", content: "Hello world" } as StreamChunk, doneChunk()]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			object: string;
			status: string;
			model: string;
			output: Array<{ type: string; content?: Array<{ text: string }> }>;
			usage: { input_tokens: number; output_tokens: number; total_tokens: number };
		};
		expect(json.object).toBe("response");
		expect(json.status).toBe("completed");
		expect(json.model).toBe("m");
		expect(json.output).toHaveLength(1);
		expect(json.output[0].type).toBe("message");
		expect(json.output[0].content?.[0].text).toBe("Hello world");
		expect(json.usage.input_tokens).toBe(11);
		expect(json.usage.output_tokens).toBe(7);
		expect(json.usage.total_tokens).toBe(18);
	});

	it("passes instructions as system and clamps max_output_tokens by the backend cap", async () => {
		const backend = new StubBackend(() =>
			chunkStream([{ type: "text", content: "ok" } as StreamChunk, doneChunk()]),
		);
		// Cap the backend at 100 output tokens so a larger request is clamped.
		const router = new ModelRouter(new Map(), "m");
		router.addDynamicBackend("m", backend, CAPS, 1, 100);
		const app = createResponsesRoutes(db, router, bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: "hi",
				model: "m",
				instructions: "You are terse.",
				max_output_tokens: 5000,
				temperature: 0.3,
				top_p: 0.9,
			}),
		});
		expect(res.status).toBe(200);
		expect(backend.lastParams?.system).toBe("You are terse.");
		expect(backend.lastParams?.max_tokens).toBe(100); // clamped to cap
		expect(backend.lastParams?.temperature).toBe(0.3);
		expect(backend.lastParams?.top_p).toBe(0.9);
	});

	it("translates Responses-flat tools and tool_choice into ToolDefinition + chat params", async () => {
		const backend = new StubBackend(() =>
			chunkStream([{ type: "text", content: "ok" } as StreamChunk, doneChunk()]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: "run it",
				model: "m",
				tools: [
					{
						type: "function",
						name: "shell_exec",
						description: "run a shell command",
						parameters: { type: "object", properties: { cmd: { type: "string" } } },
					},
					{ type: "web_search" }, // non-function tool → dropped
				],
				tool_choice: { type: "function", name: "shell_exec" },
			}),
		});
		expect(res.status).toBe(200);
		const tools = backend.lastParams?.tools;
		expect(tools).toHaveLength(1);
		expect(tools?.[0]).toMatchObject({
			type: "function",
			function: { name: "shell_exec", description: "run a shell command" },
		});
		expect(backend.lastParams?.tool_choice).toEqual({ type: "tool", toolName: "shell_exec" });
	});

	it("echoes tool_choice string choices through to chat params", async () => {
		const backend = new StubBackend(() =>
			chunkStream([{ type: "text", content: "ok" } as StreamChunk, doneChunk()]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: "x",
				model: "m",
				tools: [{ type: "function", name: "t" }],
				tool_choice: "required",
			}),
		});
		expect(res.status).toBe(200);
		expect(backend.lastParams?.tool_choice).toBe("required");
	});

	it("emits a function_call output item for a tool-call stream", async () => {
		const backend = new StubBackend(() =>
			chunkStream([
				{ type: "tool_use_start", id: "call_1", name: "shell_exec" } as StreamChunk,
				{ type: "tool_use_args", id: "call_1", partial_json: '{"cmd":"ls"}' } as StreamChunk,
				{ type: "tool_use_end", id: "call_1" } as StreamChunk,
				doneChunk({ finish_reason: "tool-calls" }),
			]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: "ls",
				model: "m",
				tools: [{ type: "function", name: "shell_exec" }],
			}),
		});
		const json = (await res.json()) as {
			output: Array<{ type: string; name?: string; arguments?: string; call_id?: string }>;
		};
		expect(json.output).toHaveLength(1);
		expect(json.output[0].type).toBe("function_call");
		expect(json.output[0].name).toBe("shell_exec");
		expect(json.output[0].call_id).toBe("call_1");
		expect(json.output[0].arguments).toBe('{"cmd":"ls"}');
	});

	it("maps a context-length provider error to a 400 invalid_request_error", async () => {
		const backend = new StubBackend(() =>
			errorStream(new Error("prompt is too long: 200000 tokens")),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { type: string } };
		expect(json.error.type).toBe("invalid_request_error");
	});

	it("maps a generic provider error to a 502 server_error", async () => {
		const backend = new StubBackend(() => errorStream(new Error("upstream exploded")));
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m" }),
		});
		expect(res.status).toBe(502);
		const json = (await res.json()) as { error: { type: string; message: string } };
		expect(json.error.type).toBe("server_error");
		expect(json.error.message).toContain("upstream exploded");
	});
});

describe("POST /v1/responses — transient retry (real withTransientRetry/withFailureLog)", () => {
	it("retries a transient 529 and succeeds on the second attempt", async () => {
		let calls = 0;
		const backend = new StubBackend(() => {
			calls++;
			if (calls === 1) return errorStream(new LLMError("Overloaded", "anthropic", 529));
			return chunkStream([{ type: "text", content: "recovered" } as StreamChunk, doneChunk()]);
		});
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m" }),
		});
		expect(res.status).toBe(200);
		expect(calls).toBe(2);
		const json = (await res.json()) as { output: Array<{ content?: Array<{ text: string }> }> };
		expect(json.output[0].content?.[0].text).toBe("recovered");
	});

	it("does not retry a non-transient 400 and surfaces the error", async () => {
		let calls = 0;
		const backend = new StubBackend(() => {
			calls++;
			return errorStream(new LLMError("bad request", "openai", 400));
		});
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m" }),
		});
		expect(calls).toBe(1);
		expect(res.status).toBe(502);
	});
});

describe("POST /v1/responses — streaming SSE", () => {
	it("emits the text event sequence ending in response.completed", async () => {
		const backend = new StubBackend(() =>
			chunkStream([
				{ type: "text", content: "Hel" } as StreamChunk,
				{ type: "text", content: "lo" } as StreamChunk,
				doneChunk(),
			]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m", stream: true }),
		});
		expect(res.status).toBe(200);
		const events = parseSse(await res.text());
		const types = events.map((e) => e.event);
		expect(types[0]).toBe("response.created");
		expect(types[1]).toBe("response.in_progress");
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.content_part.added");
		expect(types).toContain("response.output_text.delta");
		expect(types).toContain("response.output_text.done");
		expect(types).toContain("response.content_part.done");
		expect(types).toContain("response.output_item.done");
		expect(types[types.length - 1]).toBe("response.completed");

		// Monotonic sequence numbers.
		const seqs = events.map((e) => e.data.sequence_number as number);
		for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

		// Two text deltas concatenate on the completed envelope.
		const completed = events.at(-1)?.data as {
			response: {
				output: Array<{ content: Array<{ text: string }> }>;
				usage: { total_tokens: number };
			};
		};
		expect(completed.response.output[0].content[0].text).toBe("Hello");
		expect(completed.response.usage.total_tokens).toBe(18);
	});

	it("emits reasoning summary events and carries encrypted_content", async () => {
		const backend = new StubBackend(() =>
			chunkStream([
				{ type: "thinking", content: "Let me think." } as StreamChunk,
				{ type: "thinking", content: "", reasoning_encrypted_content: "ENC" } as StreamChunk,
				{ type: "text", content: "answer" } as StreamChunk,
				doneChunk(),
			]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m", stream: true }),
		});
		const events = parseSse(await res.text());
		const types = events.map((e) => e.event);
		expect(types).toContain("response.reasoning_summary_text.delta");
		expect(types).toContain("response.reasoning_summary_text.done");
		const completed = events.at(-1)?.data as {
			response: { output: Array<{ type: string; encrypted_content?: string }> };
		};
		const reasoningItem = completed.response.output.find((o) => o.type === "reasoning");
		expect(reasoningItem?.encrypted_content).toBe("ENC");
	});

	it("emits function_call_arguments events and a completed function_call item", async () => {
		const backend = new StubBackend(() =>
			chunkStream([
				{ type: "tool_use_start", id: "c1", name: "do_thing" } as StreamChunk,
				{ type: "tool_use_args", id: "c1", partial_json: '{"a":' } as StreamChunk,
				{ type: "tool_use_args", id: "c1", partial_json: "1}" } as StreamChunk,
				{ type: "tool_use_end", id: "c1" } as StreamChunk,
				doneChunk({ finish_reason: "tool-calls" }),
			]),
		);
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: "go",
				model: "m",
				stream: true,
				tools: [{ type: "function", name: "do_thing" }],
			}),
		});
		const events = parseSse(await res.text());
		const types = events.map((e) => e.event);
		expect(types).toContain("response.function_call_arguments.delta");
		expect(types).toContain("response.function_call_arguments.done");
		const doneEvt = events.find((e) => e.event === "response.function_call_arguments.done")
			?.data as { arguments: string };
		expect(doneEvt.arguments).toBe('{"a":1}');
		const completed = events.at(-1)?.data as {
			response: { output: Array<{ type: string; name?: string; arguments?: string }> };
		};
		const fnItem = completed.response.output.find((o) => o.type === "function_call");
		expect(fnItem?.name).toBe("do_thing");
		expect(fnItem?.arguments).toBe('{"a":1}');
	});

	it("emits response.failed with a classified error when the stream errors", async () => {
		const backend = new StubBackend(() => errorStream(new Error("context length exceeded")));
		const app = createResponsesRoutes(db, routerWith("m", backend), bus, SITE_ID);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi", model: "m", stream: true }),
		});
		const events = parseSse(await res.text());
		const failed = events.find((e) => e.event === "response.failed");
		expect(failed).toBeDefined();
		const data = failed?.data as { response: { error: { code: string; message: string } } };
		expect(data.response.error.code).toBe("invalid_request_error");
		expect(data.response.error.message).toContain("context length");
	});
});
