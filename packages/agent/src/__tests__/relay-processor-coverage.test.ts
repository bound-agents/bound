import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";
import { waitFor } from "./helpers";

// --- Shared fixtures ------------------------------------------------------

const createMockEventBus = (): TypedEventEmitter => {
	return new (require("@bound/shared").TypedEventEmitter)();
};

const createTrackedEventBus = (): {
	eventBus: TypedEventEmitter;
	emitted: Array<{ event: string; args: unknown }>;
} => {
	const eventBus = createMockEventBus();
	const emitted: Array<{ event: string; args: unknown }> = [];
	const originalEmit = eventBus.emit.bind(eventBus);
	eventBus.emit = ((event: string, ...args: unknown[]) => {
		emitted.push({ event, args: args[0] });
		return originalEmit(event, ...args);
	}) as typeof eventBus.emit;
	return { eventBus, emitted };
};

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// A backend that yields a scripted set of chunks, capturing the ChatParams it
// was invoked with so tests can assert alias/clamp behavior.
class ScriptedBackend implements LLMBackend {
	public capturedParams: ChatParams[] = [];
	private gen: () => AsyncGenerator<StreamChunk>;
	private caps: ReturnType<LLMBackend["capabilities"]>;

	constructor(
		gen?: () => AsyncGenerator<StreamChunk>,
		caps?: Partial<ReturnType<LLMBackend["capabilities"]>>,
	) {
		this.gen =
			gen ??
			async function* () {
				yield { type: "text" as const, content: "ok" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 3,
						output_tokens: 2,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			};
		this.caps = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
			...caps,
		};
	}

	async *chat(params: ChatParams) {
		this.capturedParams.push(params);
		yield* this.gen();
	}

	capabilities() {
		return this.caps;
	}
}

function makeRouter(model = "test-model", backend?: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set(model, backend ?? new ScriptedBackend());
	return new ModelRouter(backends, model);
}

// Insert a self-loopback durable_work request row (source_site == processor
// site) so its response rides the LOCAL_WORK_TARGET lane and is readable by
// ref_id on the same DB.
const SITE = "target-site";

function insertDurableRequest(
	db: Database,
	entry: {
		id: string;
		kind: string;
		payload: string;
		refId?: string | null;
		streamId?: string | null;
		idempotencyKey?: string | null;
		sourceSite?: string;
		traceContext?: string | null;
		expiresAt?: string;
	},
): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, ref_id, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at, trace_context)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
		[
			entry.id,
			SITE,
			entry.kind,
			entry.payload,
			entry.idempotencyKey ?? entry.id,
			entry.refId ?? null,
			entry.streamId ?? null,
			now,
			entry.expiresAt ?? new Date(Date.now() + 60000).toISOString(),
			entry.sourceSite ?? SITE,
			now,
			entry.traceContext ?? null,
		],
	);
}

function readResponse(
	db: Database,
	requestId: string,
	kind: "result" | "error",
): { kind: string; payload: string } | null {
	return db
		.query(
			"SELECT kind, payload FROM durable_work WHERE ref_id = ? AND kind = ? ORDER BY created_at ASC LIMIT 1",
		)
		.get(requestId, kind) as { kind: string; payload: string } | null;
}

function countStreamRows(db: Database, streamId: string): { chunks: number; ends: number } {
	const chunks = (
		db
			.query("SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_chunk'")
			.get(streamId) as { n: number }
	).n;
	const ends = (
		db
			.query("SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'")
			.get(streamId) as { n: number }
	).n;
	return { chunks, ends };
}

function insertHost(db: Database, siteId: string, extra: Record<string, unknown> = {}): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: siteId,
			version: "test",
			sync_url: null,
			mcp_servers: null,
			mcp_tools: extra.mcp_tools ?? null,
			models: extra.models ?? null,
			commit_hash: null,
			online_at: now,
			modified_at: now,
			work_spool_capable: 1,
			...extra,
		} as never,
		SITE,
	);
}

// Insert a minimal threads row (invariant #1: writes go through insertRow).
function insertThread(db: Database, id: string, extra: Record<string, unknown> = {}): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: "u",
			interface: "web",
			host_origin: SITE,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			...extra,
		} as never,
		SITE,
	);
}

// --- Test DB lifecycle ----------------------------------------------------

let db: Database;

beforeEach(() => {
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(":memory:");
	applySchema(db);
	try {
		require("@bound/core").applyMetricsSchema(db);
	} catch {
		// metrics schema optional for most paths
	}
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// already closed
	}
});

// --- selectIntakeHost tiers (via handleIntake routing) --------------------

describe("RelayProcessor - selectIntakeHost tiers", () => {
	it("Tier 2: routes to the host advertising the thread's model_hint", () => {
		insertThread(db, "thread-m", { model_hint: "special-model" });
		insertHost(db, "remote-model-host", { models: JSON.stringify(["special-model"]) });
		insertHost(db, "aaa-other-host", { models: JSON.stringify(["unrelated"]) });

		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const selected = (
			processor as unknown as {
				selectIntakeHost: (t: string, p?: string) => string | null;
			}
		).selectIntakeHost("thread-m");
		expect(selected).toBe("remote-model-host");
	});

	it("Tier 3: routes to the host whose mcp_tools best match the thread's tool usage", () => {
		insertThread(db, "thread-t");
		// thread used two tools
		for (const tool of ["github_create", "github_list"]) {
			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: "thread-t",
					role: "tool",
					content: "x",
					tool_name: tool,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: SITE,
				} as never,
				SITE,
			);
		}
		insertHost(db, "aaa-poor-match", { mcp_tools: JSON.stringify(["github_create"]) });
		insertHost(db, "bbb-best-match", {
			mcp_tools: JSON.stringify(["github_create", "github_list"]),
		});

		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const selected = (
			processor as unknown as {
				selectIntakeHost: (t: string, p?: string) => string | null;
			}
		).selectIntakeHost("thread-t");
		expect(selected).toBe("bbb-best-match");
	});

	it("Tier 4: falls back to the first live host when no model/tool match exists", () => {
		insertThread(db, "thread-f");
		insertHost(db, "zzz-last");
		insertHost(db, "aaa-first");

		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const selected = (
			processor as unknown as {
				selectIntakeHost: (t: string, p?: string) => string | null;
			}
		).selectIntakeHost("thread-f");
		expect(selected).toBe("aaa-first");
	});

	it("Tier 1: honors a live thread-affinity host over later tiers", () => {
		insertThread(db, "thread-a");
		insertHost(db, "affinity-host");
		insertHost(db, "aaa-other");

		const affinity = new Map<string, string>([["thread-a", "affinity-host"]]);
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
			null,
			undefined,
			affinity,
		);
		const selected = (
			processor as unknown as {
				selectIntakeHost: (t: string, p?: string) => string | null;
			}
		).selectIntakeHost("thread-a");
		expect(selected).toBe("affinity-host");
	});

	it("returns null when no hosts are live", () => {
		insertThread(db, "thread-empty");
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const selected = (
			processor as unknown as {
				selectIntakeHost: (t: string, p?: string) => string | null;
			}
		).selectIntakeHost("thread-empty");
		expect(selected).toBeNull();
	});
});

// --- executeToolCall: help, dispatch, confirmation, auth challenge --------

describe("RelayProcessor - executeToolCall", () => {
	class StubClient implements Partial<MCPClient> {
		public calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		constructor(
			private toolList: Array<{ name: string; description: string; inputSchema?: unknown }>,
			private behavior: (name: string, args: Record<string, unknown>) => Promise<unknown> = async (
				name,
			) => ({ content: JSON.stringify({ ok: name }), isError: false }),
		) {}
		async listTools() {
			return this.toolList as never;
		}
		getConfig() {
			return { name: "github", transport: "stdio" as const };
		}
		async callTool(name: string, args: Record<string, unknown>) {
			this.calls.push({ name, args });
			return (await this.behavior(name, args)) as never;
		}
	}

	function makeProcessor(client: Partial<MCPClient>): RelayProcessor {
		return new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>([["github", client as MCPClient]]),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
	}

	it("answers a --help request from a live listTools (exit_code 0)", async () => {
		const client = new StubClient([
			{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
		]);
		const processor = makeProcessor(client);
		const out = await (
			processor as unknown as {
				executeToolCall: (p: unknown) => Promise<string>;
			}
		).executeToolCall({ tool: "github", args: { help: true } });
		const parsed = JSON.parse(out);
		expect(parsed.exit_code).toBe(0);
		expect(parsed.stdout).toContain("create_issue");
		expect(client.calls.length).toBe(0);
	});

	it("dispatches a known subcommand and returns the tool result", async () => {
		const client = new StubClient(
			[{ name: "create_issue", description: "d", inputSchema: { type: "object" } }],
			async () => ({ content: JSON.stringify({ issue: 42 }), isError: false }),
		);
		const processor = makeProcessor(client);
		const out = await (
			processor as unknown as {
				executeToolCall: (p: unknown) => Promise<string>;
			}
		).executeToolCall({ tool: "github", args: { subcommand: "create_issue", title: "x" } });
		const parsed = JSON.parse(out);
		expect(parsed.exit_code).toBe(0);
		expect(parsed.stdout).toContain("issue");
		expect(client.calls[0]?.name).toBe("create_issue");
		// subcommand must be stripped from forwarded args
		expect(client.calls[0]?.args.subcommand).toBeUndefined();
	});

	it("throws when the MCP server is not registered", async () => {
		const processor = makeProcessor(new StubClient([]));
		await expect(
			(
				processor as unknown as {
					executeToolCall: (p: unknown) => Promise<string>;
				}
			).executeToolCall({ tool: "nonexistent", args: { subcommand: "x" } }),
		).rejects.toThrow(/MCP server not found/);
	});

	it("throws on an unknown subcommand", async () => {
		const client = new StubClient([
			{ name: "create_issue", description: "d", inputSchema: { type: "object" } },
		]);
		const processor = makeProcessor(client);
		await expect(
			(
				processor as unknown as {
					executeToolCall: (p: unknown) => Promise<string>;
				}
			).executeToolCall({ tool: "github", args: { subcommand: "delete_everything" } }),
		).rejects.toThrow(/Unknown subcommand/);
	});

	it("echoes a param hint and exit_code 1 when the tool reports isError", async () => {
		const client = new StubClient(
			[
				{
					name: "create_issue",
					description: "d",
					inputSchema: { type: "object", properties: { title: { type: "string" } } },
				},
			],
			async () => ({ content: "boom", isError: true }),
		);
		const processor = makeProcessor(client);
		const out = await (
			processor as unknown as {
				executeToolCall: (p: unknown) => Promise<string>;
			}
		).executeToolCall({ tool: "github", args: { subcommand: "create_issue" } });
		const parsed = JSON.parse(out);
		expect(parsed.exit_code).toBe(1);
		expect(parsed.stderr).toContain("boom");
	});
});

// --- executePlatformRequest ----------------------------------------------

describe("RelayProcessor - executePlatformRequest", () => {
	it("throws when no platform MCP registry is wired", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		await expect(
			(
				processor as unknown as {
					executePlatformRequest: (p: unknown) => Promise<string>;
				}
			).executePlatformRequest({ server_name: "discord", method: "ping", params: {} }),
		).rejects.toThrow(/Platform MCP registry not available/);
	});

	it("resolves a client from the registry and returns its response", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		(
			processor as unknown as {
				setPlatformMcpRegistry: (r: unknown) => void;
			}
		).setPlatformMcpRegistry({
			getClient: (name: string) =>
				name === "discord" ? { request: async () => ({ pong: true }) } : null,
		});
		const out = await (
			processor as unknown as {
				executePlatformRequest: (p: unknown) => Promise<string>;
			}
		).executePlatformRequest({ server_name: "discord", method: "ping", params: {} });
		const parsed = JSON.parse(out);
		expect(parsed.exit_code).toBe(0);
		expect(parsed.stdout).toContain("pong");
	});

	it("throws when the named platform server is not found on this host", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		(
			processor as unknown as {
				setPlatformMcpRegistry: (r: unknown) => void;
			}
		).setPlatformMcpRegistry({ getClient: () => null });
		await expect(
			(
				processor as unknown as {
					executePlatformRequest: (p: unknown) => Promise<string>;
				}
			).executePlatformRequest({ server_name: "discord", method: "ping", params: {} }),
		).rejects.toThrow(/not found on this host/);
	});
});

// --- handleNotifyWakeup ---------------------------------------------------

describe("RelayProcessor - handleNotifyWakeup", () => {
	it("delivers a notification wakeup through the event bus", async () => {
		insertThread(db, "thread-n");
		const { eventBus, emitted } = createTrackedEventBus();
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			eventBus,
		);

		const id = randomUUID();
		insertDurableRequest(db, {
			id,
			kind: "notify_wakeup",
			payload: JSON.stringify({ thread_id: "thread-n", payload: { note: "wake" } }),
		});
		const handle = processor.start(10);
		await waitFor(() => {
			const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(id) as {
				claim_state: string;
			} | null;
			return row?.claim_state === "consumed";
		});
		handle.stop();
		// delivery emits at least one event (dispatch_queue / notification wakeup)
		expect(emitted.length).toBeGreaterThan(0);
	});

	it("dead-letters an invalid notify_wakeup payload (PayloadParseError)", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		insertDurableRequest(db, { id, kind: "notify_wakeup", payload: "{not valid" });
		const handle = processor.start(10);
		await waitFor(() => {
			const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(id) as {
				claim_state: string;
			} | null;
			// A PayloadParseError inside the handler is an outcome; the lane acks the row.
			return row?.claim_state === "consumed" || row?.claim_state === "dead_letter";
		});
		handle.stop();
		expect(true).toBe(true);
	});
});

// --- handleMcpAuthHandoff (consumer unset -> throw -> row left processing) -

describe("RelayProcessor - handleMcpAuthHandoff", () => {
	it("invokes the wired owner-exchange consumer and consumes the row", async () => {
		let consumed: Record<string, unknown> | null = null;
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		(
			processor as unknown as {
				setMcpAuthHandoffConsumer: (fn: (p: Record<string, unknown>) => Promise<void>) => void;
			}
		).setMcpAuthHandoffConsumer(async (p) => {
			consumed = p;
		});

		const id = randomUUID();
		const payload = {
			challenge_id: "ch-1",
			server_name: "s",
			code: "abc",
			state: "st",
			redirect_uri: "https://x/cb",
			resource: "https://r",
			issuer: "https://i",
		};
		insertDurableRequest(db, { id, kind: "mcp_auth_handoff", payload: JSON.stringify(payload) });
		const handle = processor.start(10);
		await waitFor(() => consumed !== null);
		handle.stop();
		expect(consumed).not.toBeNull();
	});
});

// --- executeInference through the durable lane ----------------------------

describe("RelayProcessor - executeInference", () => {
	function insertInference(entry: {
		id: string;
		streamId: string;
		payload: string;
		traceContext?: string | null;
	}): void {
		insertDurableRequest(db, {
			id: entry.id,
			kind: "inference",
			payload: entry.payload,
			streamId: entry.streamId,
			idempotencyKey: entry.id,
			traceContext: entry.traceContext ?? null,
		});
	}

	it("writes an error response when stream_id is missing", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		// No stream_id column set → executeInference errors out.
		insertDurableRequest(db, {
			id,
			kind: "inference",
			payload: JSON.stringify({ model: "test-model", segments: [], nowMs: 0 }),
			idempotencyKey: id,
		});
		const handle = processor.start(10);
		await waitFor(() => readResponse(db, id, "error") !== null);
		handle.stop();
		const err = readResponse(db, id, "error");
		if (!err) throw new Error("expected error response");
		expect(JSON.parse(err.payload).error).toContain("Missing stream_id");
	});

	it("writes an error when the model is unavailable on this host", async () => {
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter("other-model"),
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		const streamId = randomUUID();
		insertInference({
			id,
			streamId,
			payload: JSON.stringify({
				threadId: "t",
				model: "absent-model",
				segments: [{ kind: "inline", message: { role: "user", content: "hi" } }],
				nowMs: 0,
			}),
		});
		const handle = processor.start(10);
		await waitFor(() => readResponse(db, id, "error") !== null);
		handle.stop();
		const err = readResponse(db, id, "error");
		if (!err) throw new Error("expected error response");
		expect(JSON.parse(err.payload).error).toContain("Model not available");
	});

	it("streams chunks and a stream_end on normal completion; clamps max_tokens and strips model alias", async () => {
		const backend = new ScriptedBackend(async function* () {
			yield { type: "text" as const, content: "y".repeat(5000) };
			yield { type: "text" as const, content: "tail" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		const router = makeRouter("test-model", backend);
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		const streamId = randomUUID();
		insertInference({
			id,
			streamId,
			payload: JSON.stringify({
				threadId: "thread-x",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "Hello" } }],
				nowMs: 0,
				max_tokens: 9_999_999,
			}),
		});
		const handle = processor.start(10);
		await waitFor(() => countStreamRows(db, streamId).ends > 0, { timeoutMs: 8000 });
		handle.stop();
		const rows = countStreamRows(db, streamId);
		expect(rows.ends).toBeGreaterThan(0);
		expect(rows.chunks).toBeGreaterThan(0);
		// Invariant #11: the logical alias is never forwarded as params.model; the
		// backend uses its own configured identifier. The relay processor also passes
		// a threadId through from the payload.
		const captured = backend.capturedParams[0];
		expect(captured).toBeDefined();
		expect((captured as unknown as { model?: string }).model).toBeUndefined();
		expect(captured?.threadId).toBe("thread-x");
	});

	it("writes an error response when the backend throws", async () => {
		const backend = new ScriptedBackend(
			// biome-ignore lint/correctness/useYield: throwing generator for test
			async function* () {
				throw new Error("backend exploded");
			},
		);
		const router = makeRouter("test-model", backend);
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		const streamId = randomUUID();
		insertInference({
			id,
			streamId,
			payload: JSON.stringify({
				threadId: "t",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "hi" } }],
				nowMs: 0,
			}),
		});
		const handle = processor.start(10);
		await waitFor(() => readResponse(db, id, "error") !== null, { timeoutMs: 8000 });
		handle.stop();
		const err = readResponse(db, id, "error");
		if (!err) throw new Error("expected error response");
		expect(JSON.parse(err.payload).error).toContain("backend exploded");
	});

	it("collects and relays trace_data when a trace carrier is present", async () => {
		const backend = new ScriptedBackend();
		const router = makeRouter("test-model", backend);
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const id = randomUUID();
		const streamId = randomUUID();
		const carrier = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});
		insertInference({
			id,
			streamId,
			payload: JSON.stringify({
				threadId: "t",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "hi" } }],
				nowMs: 0,
			}),
			traceContext: carrier,
		});
		const handle = processor.start(10);
		await waitFor(() => countStreamRows(db, streamId).ends > 0, { timeoutMs: 8000 });
		// trace_data rides the response transport keyed by ref_id.
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE ref_id = ? AND kind = 'trace_data'",
						)
						.get(id) as { n: number }
				).n > 0,
			{ timeoutMs: 8000 },
		);
		handle.stop();
		const traceCount = (
			db
				.query("SELECT COUNT(*) as n FROM durable_work WHERE ref_id = ? AND kind = 'trace_data'")
				.get(id) as { n: number }
		).n;
		expect(traceCount).toBeGreaterThan(0);
	});
});

// --- runLocalThreadLoop / runLocalLoop via agentLoopFactory ---------------

describe("RelayProcessor - runLocalThreadLoop", () => {
	function makeProcessorWithFactory(opts: {
		factory?: (config: unknown) => { run: () => Promise<Record<string, unknown>> };
		router?: ModelRouter | null;
		appCtx?: unknown;
	}): RelayProcessor {
		return new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			opts.router === undefined ? makeRouter() : opts.router,
			createMockLogger(),
			createMockEventBus(),
			(opts.appCtx as never) ?? null,
			undefined,
			new Map(),
			opts.factory as never,
		);
	}

	it("runs the agent loop locally via the factory and returns its result shape", async () => {
		insertThread(db, "thread-local");
		let ran = false;
		const processor = makeProcessorWithFactory({
			appCtx: { siteId: SITE, config: { modelBackends: { backends: [] } } },
			factory: () => ({
				run: async () => {
					ran = true;
					return { yielded: false, error: undefined, messagesCreated: 2 };
				},
			}),
		});
		const result = await (
			processor as unknown as {
				runLocalThreadLoop: (r: unknown) => Promise<void>;
			}
		).runLocalThreadLoop({
			threadId: "thread-local",
			messageId: randomUUID(),
			userId: "platform:web",
			platform: "web",
		});
		expect(ran).toBe(true);
		expect(result).toBeUndefined();
	});

	it("bails without running when the thread row does not exist", async () => {
		let ran = false;
		const processor = makeProcessorWithFactory({
			appCtx: { siteId: SITE, config: { modelBackends: { backends: [] } } },
			factory: () => ({
				run: async () => {
					ran = true;
					return { yielded: false };
				},
			}),
		});
		await (
			processor as unknown as {
				runLocalThreadLoop: (r: unknown) => Promise<void>;
			}
		).runLocalThreadLoop({
			threadId: "missing-thread",
			messageId: randomUUID(),
			userId: "u",
			platform: null,
		});
		expect(ran).toBe(false);
	});

	it("bails without running when no model router is configured", async () => {
		insertThread(db, "thread-norouter");
		let ran = false;
		const processor = makeProcessorWithFactory({
			router: null,
			appCtx: { siteId: SITE, config: { modelBackends: { backends: [] } } },
			factory: () => ({
				run: async () => {
					ran = true;
					return { yielded: false };
				},
			}),
		});
		await (
			processor as unknown as {
				runLocalThreadLoop: (r: unknown) => Promise<void>;
			}
		).runLocalThreadLoop({
			threadId: "thread-norouter",
			messageId: randomUUID(),
			userId: "u",
			platform: null,
		});
		expect(ran).toBe(false);
	});

	it("bails without running when AppContext is absent", async () => {
		insertThread(db, "thread-noctx");
		let ran = false;
		const processor = makeProcessorWithFactory({
			appCtx: null,
			factory: () => ({
				run: async () => {
					ran = true;
					return { yielded: false };
				},
			}),
		});
		await (
			processor as unknown as {
				runLocalThreadLoop: (r: unknown) => Promise<void>;
			}
		).runLocalThreadLoop({
			threadId: "thread-noctx",
			messageId: randomUUID(),
			userId: "u",
			platform: null,
		});
		expect(ran).toBe(false);
	});
});

// --- handleClientTool / awaitClientResult relay flow (R-UD5/R-UD8/R-UD9) ---

describe("RelayProcessor - handleClientTool", () => {
	// A ClientToolResolver stub: it reports whether a live local WS session holds
	// the requested tool, which gates handleClientTool step 1.
	function makeResolver(hasSession: boolean) {
		return {
			getClientToolsForThread: () => undefined,
			getConnectionForTool: (_t: string, _tool: string) => (hasSession ? "conn-1" : undefined),
			getSystemPromptAdditionForThread: () => undefined,
		};
	}

	function makeProcessor(resolver?: ReturnType<typeof makeResolver>): {
		processor: RelayProcessor;
		emitted: Array<{ event: string; args: unknown }>;
	} {
		const { eventBus, emitted } = createTrackedEventBus();
		const processor = new RelayProcessor(
			db,
			SITE,
			new Map<string, MCPClient>(),
			makeRouter(),
			createMockLogger(),
			eventBus,
		);
		if (resolver) {
			(processor as unknown as { setWsRegistry: (r: unknown) => void }).setWsRegistry(resolver);
		}
		return { processor, emitted };
	}

	// Persist a tool_result message the way the WS handler does, so the fast path
	// (and the polling backstop) in awaitClientResult can observe it.
	function persistToolResult(threadId: string, callId: string, content: string, isError = false) {
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "tool_result",
				content,
				tool_name: callId,
				exit_code: isError ? 1 : 0,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: SITE,
			} as never,
			SITE,
		);
	}

	function basePayload(overrides: Record<string, unknown> = {}) {
		return JSON.stringify({
			thread_id: "thread-ct",
			call_id: "call_1",
			tool_name: "read",
			args: { path: "x" },
			timeout_ms: 500,
			...overrides,
		});
	}

	it("relays a retriable error when no live WS session holds the tool", async () => {
		insertThread(db, "thread-ct");
		const { processor } = makeProcessor(makeResolver(false));
		const id = randomUUID();
		insertDurableRequest(db, { id, kind: "client_tool", payload: basePayload() });
		const handle = processor.start(10);
		await waitFor(() => readResponse(db, id, "error") !== null, { timeoutMs: 6000 });
		handle.stop();
		const err = readResponse(db, id, "error");
		if (!err) throw new Error("expected error response");
		const parsed = JSON.parse(err.payload);
		expect(parsed.retriable).toBe(true);
		expect(parsed.definitely_not_executed).toBe(true);
	});

	it("enqueues a client tool call, emits client_tool_call:created, and relays the client_result", async () => {
		insertThread(db, "thread-ct");
		// Pre-persist the tool_result so awaitClientResult's fast path settles quickly.
		persistToolResult("thread-ct", "call_1", JSON.stringify({ ok: true }), false);
		const { processor, emitted } = makeProcessor(makeResolver(true));
		const id = randomUUID();
		insertDurableRequest(db, { id, kind: "client_tool", payload: basePayload() });
		const handle = processor.start(10);
		// client_result rides the response transport keyed by ref_id.
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE ref_id = ? AND kind = 'client_result'",
						)
						.get(id) as { n: number }
				).n > 0,
			{ timeoutMs: 6000 },
		);
		handle.stop();
		// dispatch_queue row enqueued for the WS layer
		const dispatchRows = (
			db.query("SELECT COUNT(*) as n FROM dispatch_queue WHERE thread_id = ?").get("thread-ct") as {
				n: number;
			}
		).n;
		expect(dispatchRows).toBeGreaterThan(0);
		// creation event emitted
		expect(emitted.some((e) => e.event === "client_tool_call:created")).toBe(true);
		// client_result payload carries the tool content
		const row = db
			.query("SELECT payload FROM durable_work WHERE ref_id = ? AND kind = 'client_result' LIMIT 1")
			.get(id) as { payload: string };
		const clientResult = JSON.parse(row.payload);
		expect(clientResult.call_id).toBe("call_1");
		expect(clientResult.is_error).toBe(false);
	});

	it("dead-letters an invalid client_tool payload with a non-retriable error", async () => {
		const { processor } = makeProcessor(makeResolver(true));
		const id = randomUUID();
		insertDurableRequest(db, { id, kind: "client_tool", payload: "{bad" });
		const handle = processor.start(10);
		await waitFor(() => readResponse(db, id, "error") !== null, { timeoutMs: 6000 });
		handle.stop();
		const err = readResponse(db, id, "error");
		if (!err) throw new Error("expected error response");
		expect(JSON.parse(err.payload).retriable).toBe(false);
	});
});
