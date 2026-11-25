/**
 * Regression (#296): a hintless loop started while the node default still names
 * a self-configuring namespace placeholder must follow the default the lineup
 * discovery selects, never freeze the placeholder string and report it
 * decommissioned once the registrar removes it.
 *
 * Discovery is driven with the same router primitives, in the same order, as the
 * CLI namespace registrar (`registerDynamicBackends` in
 * `packages/cli/src/commands/start/inference.ts`): register the expanded backend,
 * redirect the default off the placeholder, remove the placeholder.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { MainAgentLoop } from "../agent-loop";

const SITE = "site-local";
const NAMESPACE = "a";
const EXPANDED = "a-m";

class CountingBackend implements LLMBackend {
	calls = 0;
	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		if (!String(params.system ?? "").includes("running summary of a conversation")) this.calls++;
		yield { type: "text", content: "Done." };
		yield {
			type: "done",
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
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

describe("MainAgentLoop — namespace placeholder default resolved by later discovery (#296)", () => {
	let db: Database;
	let threadId: string;
	let placeholder: CountingBackend;
	let expanded: CountingBackend;
	let router: ModelRouter;

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
			 VALUES (?, ?, 'user', 'hello', ?, ?, ?, 0)`,
			[randomUUID(), threadId, now, now, SITE],
		);
		placeholder = new CountingBackend();
		expanded = new CountingBackend();
		// Startup state: the only backend is the not-ready namespace placeholder,
		// and the node default names it.
		router = new ModelRouter(
			new Map<string, LLMBackend>([[NAMESPACE, placeholder]]),
			NAMESPACE,
			undefined,
			undefined,
			new Set([NAMESPACE]),
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

	/** The registrar's completion pass for the namespace lineup. */
	function completeDiscovery(): void {
		router.addDynamicBackend(EXPANDED, expanded, expanded.capabilities());
		router.redirectDefault(NAMESPACE, EXPANDED);
		router.removeBackend(NAMESPACE);
	}

	function run(modelId: string | undefined, sandboxExtras: Record<string, unknown> = {}) {
		const sandbox = {
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			...sandboxExtras,
		};
		return new MainAgentLoop(ctx(), sandbox, router, { threadId, userId: "u", modelId }).run();
	}

	function decommissionedAlerts(): number {
		const row = db
			.query(
				"SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = 'alert' AND content LIKE '%decommissioned%'",
			)
			.get(threadId) as { n: number };
		return row.n;
	}

	for (const modelId of ["default", undefined]) {
		it(`resolves the expanded default when discovery lands during the readiness wait (modelId=${String(modelId)})`, async () => {
			const release = setTimeout(completeDiscovery, 50);
			try {
				const result = await run(modelId);
				expect(result.error).toBeUndefined();
				expect(router.getDefaultId()).toBe(EXPANDED);
				expect(expanded.calls).toBe(1);
				expect(placeholder.calls).toBe(0);
				expect(decommissionedAlerts()).toBe(0);
			} finally {
				clearTimeout(release);
			}
		});

		it(`resolves the expanded default when discovery lands during hydration (modelId=${String(modelId)})`, async () => {
			const result = await run(modelId, {
				rehydrateFs: async () => {
					completeDiscovery();
				},
			});
			expect(result.error).toBeUndefined();
			expect(expanded.calls).toBe(1);
			expect(placeholder.calls).toBe(0);
			expect(decommissionedAlerts()).toBe(0);
		});
	}

	it("still rejects a genuinely removed explicit model as decommissioned", async () => {
		completeDiscovery();
		const result = await run("gone-model");
		expect(result.error).toContain("decommissioned");
		expect(expanded.calls).toBe(0);
	});
});
