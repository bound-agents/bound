import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import type { RegisteredTool, ToolContext } from "../../types.js";
import { createYardTool } from "../yard.js";

/**
 * Yard infer() beyond the local backend: relay dispatch for remote-resolving
 * models, and AbortSignal propagation from the root budget deadline into
 * in-flight operations. These close the two gaps deliberately left by the
 * registration slice — a model that resolves to a remote host must delegate
 * over the inference relay exactly like acquireSummaryBackend does, and
 * deadline expiry must CANCEL in-flight work, not merely stop awaiting it.
 */

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function localTextBackend(reply: string): LLMBackend {
	return {
		async *chat(_params: ChatParams): AsyncIterable<StreamChunk> {
			yield { type: "text", content: reply };
			yield {
				type: "done",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		},
		capabilities(): BackendCapabilities {
			return {
				streaming: true,
				tool_use: false,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				extended_thinking: false,
				max_context: 100_000,
			};
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, pollMs = 10): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

function getInferenceOutboxRow(db: Database): { stream_id: string; payload: string } | null {
	return db
		.prepare(
			"SELECT stream_id, payload FROM durable_work WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { stream_id: string; payload: string } | null;
}

function insertRelayInboxEntry(
	db: Database,
	opts: { id: string; sourceSiteId: string; kind: string; streamId: string; payload: string },
) {
	// Post-N+1: stream responses ride the durable_work spool as self-targeted rows
	// keyed by stream_id, consumed by the awaiter's union read.
	db.prepare(
		`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, claim_state, attempt_count, created_at, source_site)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
	).run(
		opts.id,
		"local-spoke",
		opts.kind,
		null,
		`stream:${opts.streamId}:${opts.kind}:${opts.id}`,
		opts.streamId,
		opts.payload,
		new Date(Date.now() + 300_000).toISOString(),
		new Date().toISOString(),
		new Date().toISOString(),
		opts.sourceSiteId,
	);
}

/** Register a remote host advertising `modelId` so resolveModel goes remote. */
function insertRemoteHost(db: Database, siteId: string, modelId: string) {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at, work_spool_capable)
		 VALUES (?, ?, ?, 0, ?, ?, 1)`,
		[
			siteId,
			`${siteId}.local`,
			JSON.stringify([
				{ id: modelId, max_output_tokens: 8192, capabilities: { max_context: 200_000 } },
			]),
			now,
			now,
		],
	);
}

describe("yard infer() over the relay", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let ctx: ToolContext;
	let registry: Map<string, RegisteredTool>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'local-spoke')");
		eventBus = new TypedEventEmitter();
		registry = new Map();
		ctx = {
			db,
			siteId: "local-spoke",
			eventBus,
			logger: mockLogger,
			modelRouter: new ModelRouter(
				new Map([["local-model", localTextBackend("local reply")]]),
				"local-model",
			),
			getToolRegistry: () => registry,
		};
	});

	function invoke(input: Record<string, unknown>) {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard tool has no execute");
		return tool.execute(input) as Promise<string>;
	}

	it("delegates infer() on a remote-resolving model over the inference relay", async () => {
		insertRemoteHost(db, "remote-spoke", "remote-model");

		const run = invoke({
			program: `function* main() {
				return yield infer("remote-model", { prompt: "Classify." });
			}`,
		});

		// Responder: the relay request must land in the outbox carrying the
		// logical model alias; seed the streamed reply and wake the stream.
		const appeared = await waitFor(() => getInferenceOutboxRow(db) !== null);
		expect(appeared).toBe(true);
		const row = getInferenceOutboxRow(db);
		if (!row) throw new Error("no inference outbox row");
		const payload = JSON.parse(row.payload) as { model: string };
		expect(payload.model).toBe("remote-model");

		insertRelayInboxEntry(db, {
			id: "chunk-0",
			sourceSiteId: "remote-spoke",
			kind: "stream_chunk",
			streamId: row.stream_id,
			payload: JSON.stringify({
				seq: 0,
				chunks: [{ type: "text", content: "remote says hi" }],
			}),
		});
		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: "remote-spoke",
			kind: "stream_end",
			streamId: row.stream_id,
			payload: JSON.stringify({ seq: 0, chunks: [] }),
		});
		eventBus.emit("relay:inbox", { stream_id: row.stream_id, kind: "stream_chunk" as const });

		const out = JSON.parse(await run);
		expect(out.result).toBe("remote says hi");
		expect(out.usage.inference_calls).toBe(1);
	});

	it("still fails loudly for a model that resolves nowhere", async () => {
		const raw = await invoke({
			program: `function* main() {
				try {
					yield infer("no-such-model-anywhere", { prompt: "p" });
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		expect(JSON.parse(raw).result).toMatch(/caught:/);
	});
});

describe("yard AbortSignal propagation", () => {
	let db: Database;
	let ctx: ToolContext;
	let registry: Map<string, RegisteredTool>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'local-spoke')");
		registry = new Map();
		ctx = {
			db,
			siteId: "local-spoke",
			eventBus: new TypedEventEmitter(),
			logger: mockLogger,
			getToolRegistry: () => registry,
		};
	});

	function invoke(input: Record<string, unknown>) {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard tool has no execute");
		return tool.execute(input) as Promise<string>;
	}

	it("aborts in-flight inference when the budget deadline expires", async () => {
		let sawAbort = false;
		const hangingBackend: LLMBackend = {
			async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
				// A driver that honors ChatParams.signal: hang until aborted,
				// then throw — the yard deadline must reach THIS signal.
				await new Promise<never>((_, reject) => {
					if (params.signal?.aborted) {
						sawAbort = true;
						reject(new Error("aborted"));
						return;
					}
					params.signal?.addEventListener("abort", () => {
						sawAbort = true;
						reject(new Error("aborted"));
					});
				});
				yield { type: "text", content: "unreachable" };
			},
			capabilities(): BackendCapabilities {
				return {
					streaming: true,
					tool_use: false,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					extended_thinking: false,
					max_context: 100_000,
				};
			},
		};
		ctx.modelRouter = new ModelRouter(new Map([["hang-model", hangingBackend]]), "hang-model");

		const start = Date.now();
		const raw = await invoke({
			program: `function* main() {
				return yield infer("hang-model", { prompt: "p" });
			}`,
			budget: { timeout_seconds: 1, concurrency: 2 },
		});
		expect(Date.now() - start).toBeLessThan(4_000);
		expect(raw).toMatch(/Error:.*(deadline|abort|timeout)/i);
		expect(sawAbort).toBe(true);
	});

	it("stops dispatching new effects across the tree after deadline expiry", async () => {
		const dispatched: string[] = [];
		registry.set("step", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "step", description: "x", parameters: {} },
			},
			execute: async (input) => {
				dispatched.push(String((input as { n: unknown }).n));
				await new Promise((r) => setTimeout(r, 1500));
				return "done";
			},
		});
		const raw = await invoke({
			program: `function* main() {
				yield tool("step", { n: 1 });
				yield tool("step", { n: 2 });
				return "unreachable";
			}`,
			budget: { timeout_seconds: 1, concurrency: 2 },
		});
		expect(raw).toMatch(/Error:/);
		// The first effect was in flight when the deadline hit; the second
		// must never have been dispatched.
		expect(dispatched).toEqual(["1"]);
	});
});
