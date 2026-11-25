/**
 * Regression: a hintless loop must run on the configured cluster default role
 * on EVERY turn, not only the first.
 *
 * The turn-boundary model refresh re-read the effective hint with the local
 * router default (`getDefaultId()`) as the fallback. A hintless thread entered
 * with the symbolic default, resolved the cluster role (Opus) on turn 1, and was
 * then switched to the local bootstrap backend (Nova) at the first tool-call
 * boundary — while also resetting the cached turn state.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { MainAgentLoop } from "../agent-loop";

const SITE = "site-local";

/**
 * Counts agent-loop turns; the first turn requests a bash tool, the second
 * ends. Post-run summary-extraction calls answer with text and are not counted.
 */
class ScriptedBackend implements LLMBackend {
	calls = 0;
	constructor(private readonly toolFirst: boolean) {}
	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		const isTurn = !String(params.system ?? "").includes("running summary of a conversation");
		const call = isTurn ? this.calls++ : -1;
		const usage = {
			input_tokens: 10,
			output_tokens: 5,
			cache_write_tokens: null,
			cache_read_tokens: null,
			estimated: false,
		};
		if (this.toolFirst && call === 0) {
			yield { type: "tool_use_start", id: "tool-1", name: "bash" };
			yield { type: "tool_use_args", id: "tool-1", partial_json: '{"command":"echo hi"}' };
			yield { type: "tool_use_end", id: "tool-1" };
			yield { type: "done", usage };
			return;
		}
		yield { type: "text", content: "Done." };
		yield { type: "done", usage };
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

describe("MainAgentLoop — hintless thread on a configured cluster default", () => {
	let db: Database;
	let threadId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, model_hint)
			 VALUES (?, 'u', 'web', ?, ?, ?, ?, 0, NULL)`,
			[threadId, SITE, now, now, now],
		);
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'user', 'run a command', ?, ?, ?, 0)`,
			[randomUUID(), threadId, now, now, SITE],
		);
	});

	afterEach(() => db.close());

	function ctx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: SITE,
		} as unknown as AppContext;
	}

	function setClusterDefault(target: string): void {
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: target }),
				deleted: 0,
				modified_at: new Date().toISOString(),
			},
			SITE,
		);
	}

	function run(nova: ScriptedBackend, opus: ScriptedBackend, modelId: string | undefined) {
		const router = new ModelRouter(
			new Map<string, LLMBackend>([
				["nova", nova],
				["opus", opus],
			]),
			"nova",
		);
		const sandbox = { exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }) };
		return new MainAgentLoop(ctx(), sandbox, router, {
			threadId,
			userId: "u",
			modelId,
		}).run();
	}

	for (const modelId of ["default", undefined]) {
		it(`stays on the cluster default across a tool-call turn boundary (modelId=${String(modelId)})`, async () => {
			setClusterDefault("opus");
			const nova = new ScriptedBackend(true);
			const opus = new ScriptedBackend(true);
			const result = await run(nova, opus, modelId);
			expect(result.error).toBeUndefined();
			expect(opus.calls).toBe(2);
			expect(nova.calls).toBe(0);
		});
	}

	it("uses the local bootstrap default on every turn when no cluster default is set", async () => {
		const nova = new ScriptedBackend(true);
		const opus = new ScriptedBackend(true);
		const result = await run(nova, opus, "default");
		expect(result.error).toBeUndefined();
		expect(nova.calls).toBe(2);
		expect(opus.calls).toBe(0);
	});

	it("keeps an explicit thread hint over the cluster default", async () => {
		setClusterDefault("opus");
		db.run("UPDATE threads SET model_hint = 'nova' WHERE id = ?", [threadId]);
		const nova = new ScriptedBackend(true);
		const opus = new ScriptedBackend(true);
		const result = await run(nova, opus, "nova");
		expect(result.error).toBeUndefined();
		expect(nova.calls).toBe(2);
		expect(opus.calls).toBe(0);
	});
});
