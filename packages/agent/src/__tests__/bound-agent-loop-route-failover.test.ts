import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { BackendConfig, LLMBackend, StreamChunk } from "@bound/llm";
import { LLMError, LLMRefusalError, ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { MainAgentLoop } from "../agent-loop";

/**
 * Same-model route failover for every route-failure class (#265, spec §7.1).
 * Two local routes serve one logical model ("m1"). The first route fails with
 * a classified route error; the turn must back that route off and complete on
 * the second route within the same turn. Rate limits (429/529) already failed
 * over; 402/quota, auth, 5xx, driver-bug 400 and transport errors did not.
 */

const CAPS = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: false,
	vision: false,
	max_context: 8000,
};

class FailingBackend implements LLMBackend {
	calls = 0;
	constructor(private readonly makeError: () => unknown) {}
	// biome-ignore lint/correctness/useYield: throws before the first yield
	async *chat(): AsyncGenerator<StreamChunk> {
		this.calls++;
		throw this.makeError();
	}
	capabilities() {
		return CAPS;
	}
}

class TextBackend implements LLMBackend {
	calls = 0;
	constructor(private readonly text: string) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.calls++;
		yield { type: "text" as const, content: this.text };
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
	}
	capabilities() {
		return CAPS;
	}
}

function makeRouter(a: LLMBackend, b: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>([
		["route-a", a],
		["route-b", b],
	]);
	const configs = new Map<string, BackendConfig>([
		["route-a", { id: "route-a", provider: "openai-compatible", model: "m1", logicalModel: "m1" }],
		["route-b", { id: "route-b", provider: "openai-compatible", model: "m1", logicalModel: "m1" }],
	]);
	return new ModelRouter(backends, "route-a", undefined, configs);
}

describe("MainAgentLoop same-model route failover (#265, §7.1)", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "route-failover-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };

	function makeLoop(router: ModelRouter) {
		return new MainAgentLoop(makeCtx(), sandbox, router, {
			threadId,
			userId: "test-user",
			modelId: "m1",
		});
	}

	// [label, error factory, expected route-health kind, calls on the failing
	// route]. Transient kinds (5xx, transport) first spend the same-route retry
	// budget (MAX_SILENCE_RETRIES = 3) so a blip keeps its prompt cache; every
	// other kind fails over on the first failure.
	const cases: Array<[string, () => unknown, string, number]> = [
		[
			"402 payment/quota exhaustion",
			() => new LLMError("Weekly usage limit reached", "opencode-go", 402),
			"rate_limit",
			1,
		],
		[
			"quota message without a status",
			() => new Error("usage limit reached for 5 hour window"),
			"rate_limit",
			1,
		],
		["401 auth failure", () => new LLMError("Unauthorized", "chatgpt-oauth", 401), "auth", 1],
		["403 auth failure", () => new LLMError("Forbidden", "bedrock", 403), "auth", 1],
		["500 server error", () => new LLMError("Internal Server Error", "zai", 500), "server", 4],
		[
			"driver-bug 400",
			() => new LLMError("Bad Request — invalid tool schema", "zai", 400),
			"driver_bug",
			1,
		],
		["transport error", () => new Error("socket hang up"), "transport", 4],
	];

	for (const [label, makeError, kind, failingCalls] of cases) {
		it(`fails over to the next route for the same model on ${label}`, async () => {
			const failing = new FailingBackend(makeError);
			const healthy = new TextBackend("served by route-b");
			const router = makeRouter(failing, healthy);

			const result = await makeLoop(router).run();

			expect(result.error).toBeUndefined();
			expect(failing.calls).toBe(failingCalls);
			expect(healthy.calls).toBe(1);
			const state = router.getRouteHealthState("route-a");
			expect(state.status).toBe("backoff");
			if (state.status === "backoff") {
				expect(state.last_error_kind).toBe(kind);
			}
			expect(router.getRouteHealthState("route-b").status).toBe("healthy");
		}, 20_000);
	}

	it("does not fail over on a model refusal", async () => {
		const refusing = new FailingBackend(
			() =>
				new LLMRefusalError(
					"declined",
					"anthropic",
					{
						vendor: "anthropic",
						category: "safety",
						raw_reason: "refusal",
						substitutable: false,
					} as never,
					400,
				),
		);
		const healthy = new TextBackend("should not run");
		const router = makeRouter(refusing, healthy);

		await makeLoop(router).run();

		expect(healthy.calls).toBe(0);
		expect(router.getRouteHealthState("route-a").status).toBe("healthy");
	});

	it("keeps the full error chain when every route fails", async () => {
		const a = new FailingBackend(() => new LLMError("Weekly usage limit reached", "zai", 402));
		const b = new FailingBackend(() => new LLMError("Unauthorized: token expired", "ocgo", 401));
		const router = makeRouter(a, b);

		const result = await makeLoop(router).run();

		expect(result.error).toBeDefined();
		expect(a.calls).toBe(1);
		expect(b.calls).toBe(1);
		// The final error names both failed routes and both causes.
		expect(result.error).toContain("route-a");
		expect(result.error).toContain("Weekly usage limit reached");
		expect(result.error).toContain("route-b");
		expect(result.error).toContain("token expired");
		expect(router.getRouteHealthState("route-a").status).toBe("backoff");
		expect(router.getRouteHealthState("route-b").status).toBe("backoff");
	});

	it("records a terminal failure exactly once (no double backoff)", async () => {
		const a = new FailingBackend(() => new LLMError("Bad Request", "zai", 400));
		const b = new FailingBackend(() => new LLMError("Bad Request", "zai", 400));
		const router = makeRouter(a, b);

		await makeLoop(router).run();

		for (const id of ["route-a", "route-b"]) {
			const state = router.getRouteHealthState(id);
			expect(state.status).toBe("backoff");
			if (state.status === "backoff") expect(state.consecutive_failures).toBe(1);
		}
	});
});
