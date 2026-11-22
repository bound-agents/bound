import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import { RelayProcessor } from "../relay-processor";
import { waitFor } from "./helpers";

// R-RT18 / §7.3 step 2 / "Adding a config field" checklist step 4: the resolved
// fallback chain must reach the executing driver on a REMOTE inference turn. The
// relay-processor reconstructs ChatParams for backend.chat() from the inbound
// payload; if it drops payload.fallback_policy / payload.fallback_models the
// driver sees fallback_models === undefined, resolveFallbackTargetFromParams
// returns null, and inline credit redemption can never fire on a remote host.
// This test pins that both fields are forwarded verbatim.

class CaptureBackend implements LLMBackend {
	public capturedParams: ChatParams[] = [];

	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		this.capturedParams.push(params);
		yield { type: "text" as const, content: "ok" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: false,
			system_prompt: false,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

const createMockEventBus = (): TypedEventEmitter =>
	new (require("@bound/shared").TypedEventEmitter)();

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-relay-fallback-forward-${testId}.db`);
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// already deleted
	}
});

function insertDurableInference(entry: { id: string; streamId: string; payload: string }): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, 'target-site', 'inference', ?, ?, ?, 'pending', 0, ?, ?, 'target-site', ?)`,
		[
			entry.id,
			entry.payload,
			entry.id,
			entry.streamId,
			now,
			new Date(Date.now() + 60000).toISOString(),
			now,
		],
	);
}

describe("RelayProcessor - fallback chain forwarding (R-RT18)", () => {
	it("forwards fallback_policy and fallback_models to the executing backend", async () => {
		const backend = new CaptureBackend();
		const router = new ModelRouter(
			new Map<string, LLMBackend>([["test-model", backend]]),
			"test-model",
		);

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);

		const streamId = randomUUID();
		insertDurableInference({
			id: randomUUID(),
			streamId,
			payload: JSON.stringify({
				threadId: "thread-fb",
				model: "test-model",
				segments: [
					{
						kind: "inline" as const,
						message: { role: "user" as const, content: "Hello" },
					},
				],
				nowMs: 0,
				timeout_ms: 5000,
				fallback_policy: { mode: "custom" as const },
				fallback_models: ["fallback-a", "fallback-b"],
			}),
		});

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written" },
		);
		handle.stop();

		const params = backend.capturedParams[0];
		expect(params).toBeDefined();
		expect(params?.fallback_policy).toEqual({ mode: "custom" });
		expect(params?.fallback_models).toEqual(["fallback-a", "fallback-b"]);
	});

	it("leaves fallback params undefined when the payload omits them", async () => {
		const backend = new CaptureBackend();
		const router = new ModelRouter(
			new Map<string, LLMBackend>([["test-model", backend]]),
			"test-model",
		);

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);

		const streamId = randomUUID();
		insertDurableInference({
			id: randomUUID(),
			streamId,
			payload: JSON.stringify({
				threadId: "thread-fb-none",
				model: "test-model",
				segments: [
					{
						kind: "inline" as const,
						message: { role: "user" as const, content: "Hello" },
					},
				],
				nowMs: 0,
				timeout_ms: 5000,
			}),
		});

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written" },
		);
		handle.stop();

		const params = backend.capturedParams[0];
		expect(params).toBeDefined();
		expect(params?.fallback_policy).toBeUndefined();
		expect(params?.fallback_models).toBeUndefined();
	});
});
