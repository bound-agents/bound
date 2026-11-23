import { describe, expect, it } from "bun:test";
import { normalizeModelKey } from "../../catalog/normalize";
import type { BackendReadiness, LLMBackend, ModelDescriptor } from "../../types";
import type { CopilotAccountInfo } from "./auth-core";
import { GitHubCopilotDriver } from "./driver";
import type { CopilotTokenManager } from "./token-store";

const account: CopilotAccountInfo = {
	chatEnabled: true,
	copilotPlan: "enterprise",
	apiEndpoint: "https://api.enterprise.githubcopilot.com",
};

const tokenManager = {
	getAccessToken: async () => "ghu_abc",
} as unknown as CopilotTokenManager;

/** A fake fetch that serves the `/models` catalog and records every request. */
function catalogFetch(opts: { catalog: unknown[]; requests?: Request[] }): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		opts.requests?.push(req);
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models")) {
			return new Response(JSON.stringify({ data: opts.catalog }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

/** Collect one register call's descriptors + backends from a readiness run. */
async function expand(
	driver: GitHubCopilotDriver,
): Promise<Array<{ descriptor: ModelDescriptor; backend: LLMBackend }>> {
	const readiness = driver.readiness as BackendReadiness;
	let registered: Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> = [];
	readiness.start({
		register(_providerId, models) {
			registered = models;
		},
	});
	// The lineup fetch resolves on a microtask; a short poll drains it.
	for (let i = 0; i < 10 && !readiness.isReady(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
	return registered;
}

describe("GitHubCopilotDriver namespace mode (self-configuring expansion)", () => {
	it("carries readiness when constructed with no model, and its chat() throws a guard", async () => {
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: catalogFetch({ catalog: [] }),
		});
		expect(namespace.readiness).toBeDefined();
		let threw: unknown;
		try {
			for await (const _ of namespace.chat({ messages: [{ role: "user", content: "hi" }] })) {
				// should not yield
			}
		} catch (e) {
			threw = e;
		}
		expect(threw).toBeDefined();
		expect(String((threw as Error).message)).toContain("not directly invokable");
	});

	it("a single-model driver (model present) carries no readiness", () => {
		const single = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-opus-5.5",
			contextWindow: 200000,
			account,
		});
		expect(single.readiness).toBeUndefined();
	});

	it("expands into one backend per routable catalog model, keyed by `${namespaceId}-${providerModelId}`", async () => {
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: catalogFetch({
				catalog: [
					{
						id: "claude-opus-5.5",
						name: "Claude Opus 5.5",
						supported_endpoints: ["/v1/messages"],
						capabilities: {
							limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
							supports: { tool_calls: true, vision: true },
						},
					},
					{
						id: "gpt-6.2-sol",
						name: "GPT-6.2 Sol",
						supported_endpoints: ["/responses"],
						capabilities: {
							limits: { max_context_window_tokens: 1000000, max_output_tokens: 128000 },
							supports: { tool_calls: true, vision: true, reasoning_effort: ["low", "high"] },
						},
					},
				],
			}),
		});
		const models = await expand(namespace);
		const ids = models.map((m) => m.descriptor.id).sort();
		// Requirement 2: expanded backend id = namespace id + "-" + provider model id.
		expect(ids).toEqual(["copilot-claude-opus-5.5", "copilot-gpt-6.2-sol"]);
		// Each expanded backend is a concrete, invokable driver (no readiness).
		for (const { backend } of models) {
			expect((backend as GitHubCopilotDriver).readiness).toBeUndefined();
		}
	});

	it("excludes a catalog model whose endpoints the driver cannot route", async () => {
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: catalogFetch({
				catalog: [
					{
						id: "text-embedding-3",
						// An embeddings-only endpoint the chat driver has no route for.
						supported_endpoints: ["/embeddings"],
						capabilities: { limits: { max_context_window_tokens: 8191 } },
					},
					{
						id: "claude-opus-5.5",
						supported_endpoints: ["/v1/messages"],
						capabilities: { limits: { max_context_window_tokens: 200000 } },
					},
				],
			}),
		});
		const models = await expand(namespace);
		expect(models.map((m) => m.descriptor.id)).toEqual(["copilot-claude-opus-5.5"]);
	});

	it("carries per-model limits, display name, and reasoning from the catalog", async () => {
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: catalogFetch({
				catalog: [
					{
						id: "gpt-6.2-sol",
						name: "GPT-6.2 Sol",
						supported_endpoints: ["/responses"],
						capabilities: {
							limits: {
								max_prompt_tokens: 900000,
								max_output_tokens: 100000,
								max_context_window_tokens: 1000000,
							},
							supports: {
								tool_calls: true,
								vision: true,
								reasoning_effort: ["low", "medium", "high"],
							},
						},
					},
				],
			}),
		});
		const [model] = await expand(namespace);
		expect(model.descriptor.id).toBe("copilot-gpt-6.2-sol");
		expect(model.descriptor.capabilities.max_context).toBe(1000000);
		expect(model.descriptor.maxOutputTokens).toBe(100000);
		expect(model.descriptor.capabilities.tool_use).toBe(true);
		expect(model.descriptor.capabilities.vision).toBe(true);
	});

	it("retries on an empty lineup so a transient catalog outage recovers", async () => {
		let calls = 0;
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(new Request(input).url);
			if (url.pathname.endsWith("/models")) {
				calls++;
				if (calls === 1) {
					// First fetch 500s → CopilotCatalog.load() swallows to an empty map.
					return new Response("boom", { status: 500 });
				}
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-opus-5.5",
								supported_endpoints: ["/v1/messages"],
								capabilities: { limits: { max_context_window_tokens: 200000 } },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: fetchImpl,
			// A near-zero retry delay so the test does not wait real seconds.
			lineupRetryBaseMs: 1,
			lineupRetryMaxMs: 1,
		});
		const models = await expand(namespace);
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(models.map((m) => m.descriptor.id)).toEqual(["copilot-claude-opus-5.5"]);
	});

	it("disposal prevents a late lineup fetch from registering", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(new Request(input).url);
			if (url.pathname.endsWith("/models")) {
				await gate;
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-opus-5.5",
								supported_endpoints: ["/v1/messages"],
								capabilities: { limits: { max_context_window_tokens: 200000 } },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: fetchImpl,
		});
		const readiness = namespace.readiness as BackendReadiness;
		let registerCalls = 0;
		readiness.start({
			register() {
				registerCalls++;
			},
		});
		readiness.dispose();
		release?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(registerCalls).toBe(0);
		expect(readiness.isReady()).toBe(false);
	});
});

// Requirement 2: expanded backend ids are `${namespaceId}-${providerModelId}`.
// Existing thread/task/agent model_hints that name today's `copilot-*` ids keep
// resolving ONLY where the logical key is preserved: resolution goes through
// LOGICAL models, not backend-id string equality, and the shared structural
// normalization (packages/llm/src/catalog/normalize.ts) strips the dashed
// `copilot-` prefix. For the gpt/grok/gemini families the old config id and the
// expanded id land on the same canonical key; for the claude family they diverge
// because the raw provider model id carries a `claude-` segment the hand-written
// `copilot-opus-5.5` id omitted (see the report + migration list).
describe("GitHubCopilotDriver expansion id parity with existing copilot-* references (requirement 2)", () => {
	it("an expanded id and the old copilot-* ref share a logical key for gpt/grok/gemini", () => {
		// Families whose raw Copilot catalog id carries no extra vendor segment, so
		// `copilot-<x>` (old config id) and `copilot-<x>` (expanded id) are identical
		// and both normalize to the bare family key.
		const pairs: Array<[oldRef: string, expandedId: string]> = [
			["copilot-gpt-6.2-sol", "copilot-gpt-6.2-sol"],
			["copilot-gpt-6-luna", "copilot-gpt-6-luna"],
			["copilot-grok-4.7", "copilot-grok-4.7"],
			["copilot-gemini-4-neon", "copilot-gemini-4-neon"],
			["copilot-gemini-4-carbon", "copilot-gemini-4-carbon"],
		];
		for (const [oldRef, expandedId] of pairs) {
			const a = normalizeModelKey("github-copilot", oldRef).key;
			const b = normalizeModelKey("github-copilot", expandedId).key;
			expect(b).toBe(a);
		}
	});

	it("the provider-local `auto` pseudo-model stays provider-scoped and ungrouped", () => {
		const r = normalizeModelKey("github-copilot", "auto");
		expect(r.key).toBe("github-copilot:auto");
		expect(r.recognizedNamespace).toBe(false);
	});

	it("documents the claude-family divergence: expanded id differs from the old copilot-* key", () => {
		// The 4 Claude Copilot models are the exception: the expanded id
		// (`copilot-claude-opus-5.5`) strips `copilot-` to `claude-opus-5-5` — the
		// `claude-` segment is NOT a stripped vendor prefix — while the old
		// `copilot-opus-5.5` id strips to the bare family `opus-5-5`. The two forms
		// therefore normalize to DIFFERENT logical keys. Reported as a design
		// question + migration item, not silently papered over.
		const oldRef = normalizeModelKey("github-copilot", "copilot-opus-5.5").key;
		const expandedId = normalizeModelKey("github-copilot", "copilot-claude-opus-5.5").key;
		expect(oldRef).toBe("opus-5-5");
		expect(expandedId).toBe("claude-opus-5-5");
		expect(expandedId).not.toBe(oldRef);
		// The expanded id DOES match the cross-provider Bedrock/Mantle Anthropic
		// routes, so expansion pools Copilot Claude with those routes (a routing win).
		expect(normalizeModelKey("bedrock-mantle", "anthropic.claude-opus-5-5").key).toBe(expandedId);
	});
});
