import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { type WsTestCluster, createWsTestCluster } from "../../../sync/src/__tests__/test-harness";

import { applyMetricsSchema } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";

import { resolveModel } from "../model-resolution";
import { createRelayBackend } from "../relay-backend";
import { RelayProcessor } from "../relay-processor";
import { extractSummaryAndMemories } from "../summary-extraction";

/**
 * Mock LLM Backend with a single-shot text response queue. The first `chat()`
 * call (summary) yields the configured text; a second call (fact extraction)
 * falls through to the empty default — extraction still writes the summary.
 */
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	setTextResponse(text: string) {
		this.responses = [];
		this.responses.push(async function* () {
			yield { type: "text" as const, content: text };
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
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

/**
 * Router for a backendless host: no local backends registered. A `_stub_default_`
 * backend provides a default id so the router constructs; the requested model is
 * NOT registered locally, so `resolveModel` falls through to the remote lookup.
 */
function createBackendlessRouter(): ModelRouter {
	const stubBackend: LLMBackend = {
		async *chat() {
			yield { type: "text" as const, content: "" };
			throw new Error("Backendless router: chat() must never be called (model routes remotely)");
		},
		capabilities: () => ({
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 200000,
		}),
	};
	const backends = new Map<string, LLMBackend>();
	backends.set("_stub_default_", stubBackend);
	return new ModelRouter(backends, "_stub_default_");
}

describe("summary-extraction relay integration", () => {
	const REMOTE_MODEL = "claude-3-5-sonnet";
	const SUMMARY_TEXT = "GOAL: ship the relay extraction path. STATE: integration test green.";

	let testRunId: string;
	let basePort: number;
	let cluster: WsTestCluster;
	let relayProcessor: ReturnType<RelayProcessor["start"]> | null = null;

	let spokeDb: Database;
	let spokeSiteId: string;
	let remoteDb: Database;
	let remoteSiteId: string;

	beforeEach(async () => {
		testRunId = randomBytes(4).toString("hex");
		basePort = 10000 + Math.floor(Math.random() * 40000);

		cluster = await createWsTestCluster({ spokeCount: 2, basePort, testRunId });

		// spoke[0] = backendless requester (runs extraction); spoke[1] = remote model host.
		spokeDb = cluster.spokes[0].db;
		spokeSiteId = cluster.spokes[0].siteId;
		remoteDb = cluster.spokes[1].db;
		remoteSiteId = cluster.spokes[1].siteId;

		applyMetricsSchema(spokeDb);
		applyMetricsSchema(remoteDb);

		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse(SUMMARY_TEXT);
		const remoteRouter = new ModelRouter(
			new Map<string, LLMBackend>([[REMOTE_MODEL, mockBackend]]),
			REMOTE_MODEL,
		);

		relayProcessor = new RelayProcessor(
			remoteDb,
			remoteSiteId,
			new Map(),
			remoteRouter,
			noopLogger,
			cluster.spokes[1].eventBus,
			undefined,
			undefined,
		).start(50);
	});

	afterEach(async () => {
		if (relayProcessor) relayProcessor.stop();
		await new Promise((r) => setTimeout(r, 100));
		await cluster.cleanup();
		await new Promise((r) => setTimeout(r, 50));
	});

	it("summarizes a backendless host's thread by delegating extraction over the relay", async () => {
		const now = new Date().toISOString();

		// Register the remote host (advertising the model) in the spoke's hosts table
		// so resolveModel finds it for remote delegation.
		spokeDb.run(
			`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				remoteSiteId,
				"remote-host",
				"1.0",
				null,
				null,
				null,
				JSON.stringify([REMOTE_MODEL]),
				null,
				now,
				now,
				0,
			],
		);

		// Seed a user, thread (summary IS NULL), and one user + one assistant message.
		const userId = randomUUID();
		spokeDb.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, now, now, 0],
		);

		const threadId = randomUUID();
		spokeDb.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, created_at, modified_at, last_message_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[threadId, userId, "boundless", "localhost", 0, "Test Thread", null, null, now, now, now, 0],
		);
		spokeDb.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId,
				"user",
				"Can you route extraction over the relay?",
				now,
				"localhost",
			],
		);
		spokeDb.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId,
				"assistant",
				"Yes — acquiring the summary backend cluster-wide.",
				new Date(Date.now() + 1).toISOString(),
				"localhost",
			],
		);

		// Resolve the summary model cluster-wide from the backendless spoke: it must be remote.
		const router = createBackendlessRouter();
		const resolution = resolveModel(REMOTE_MODEL, router, spokeDb, spokeSiteId);
		expect(resolution.kind).toBe("remote");

		if (resolution.kind !== "remote") throw new Error("expected remote resolution");

		// Build the relay-backed backend and drive extraction through it.
		const backend = createRelayBackend(
			{
				db: spokeDb,
				eventBus: cluster.spokes[0].eventBus,
				siteId: spokeSiteId,
				logger: noopLogger,
			},
			resolution.hosts,
			resolution.modelId,
			15000,
		);

		const result = await extractSummaryAndMemories(spokeDb, threadId, backend, spokeSiteId);

		expect(result.ok).toBe(true);

		const thread = spokeDb
			.query("SELECT summary, summary_through FROM threads WHERE id = ?")
			.get(threadId) as { summary: string | null; summary_through: string | null };

		expect(thread.summary).toBe(SUMMARY_TEXT);
		expect(thread.summary_through).not.toBeNull();
	}, 30000);
});
