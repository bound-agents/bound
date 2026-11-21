import { describe, expect, it } from "bun:test";
import {
	CATALOG_TTL_MS,
	CopilotCatalog,
	resolveRoute,
	routeFromEndpoints,
	routeFromModelName,
} from "./catalog";

describe("routeFromEndpoints", () => {
	it("prefers messages, then responses, then chat", () => {
		expect(routeFromEndpoints(["/v1/messages", "/chat/completions"])).toBe("messages");
		expect(routeFromEndpoints(["/responses", "/chat/completions"])).toBe("responses");
		expect(routeFromEndpoints(["/chat/completions"])).toBe("chat");
		// ws:/responses alone does not satisfy the HTTP responses route.
		expect(routeFromEndpoints(["ws:/responses"])).toBeNull();
	});

	it("returns null for absent/empty endpoints (legacy models fall through)", () => {
		expect(routeFromEndpoints(undefined)).toBeNull();
		expect(routeFromEndpoints([])).toBeNull();
	});
});

describe("routeFromModelName", () => {
	it("routes claude-* to messages", () => {
		expect(routeFromModelName("claude-sonnet-4.5")).toBe("messages");
		expect(routeFromModelName("claude-3.7-sonnet")).toBe("messages");
	});

	it("routes gpt-N (N>=5), grok-*, mai-code-* to responses", () => {
		expect(routeFromModelName("gpt-5.6")).toBe("responses");
		expect(routeFromModelName("gpt-6")).toBe("responses");
		expect(routeFromModelName("gpt-6.2")).toBe("responses");
		expect(routeFromModelName("gpt-5.4-nano")).toBe("responses");
		expect(routeFromModelName("grok-4.7")).toBe("responses");
		expect(routeFromModelName("mai-code-2-flash")).toBe("responses");
	});

	it("keeps gpt-5-mini on chat", () => {
		expect(routeFromModelName("gpt-5-mini")).toBe("chat");
	});

	it("routes everything else (gpt-4.x, gemini, unknown) to chat", () => {
		expect(routeFromModelName("gpt-4.1")).toBe("chat");
		expect(routeFromModelName("gpt-4o")).toBe("chat");
		expect(routeFromModelName("gemini-3.8-flash")).toBe("chat");
		expect(routeFromModelName("some-unknown-model")).toBe("chat");
	});
});

describe("resolveRoute", () => {
	it("uses the catalog entry's endpoints when present", () => {
		expect(
			resolveRoute("gpt-5.6", { id: "gpt-5.6", supportedEndpoints: ["/chat/completions"] }),
		).toBe("chat");
	});

	it("falls back to the name heuristic when the entry lacks endpoints", () => {
		expect(resolveRoute("gpt-5.6", { id: "gpt-5.6" })).toBe("responses");
		expect(resolveRoute("claude-sonnet-4.5", null)).toBe("messages");
	});
});

/** A fetch stub returning a canned `{api}/models` response. */
function modelsFetch(
	data: unknown[],
	opts: { status?: number; onCall?: () => void } = {},
): typeof fetch {
	return (async () => {
		opts.onCall?.();
		return new Response(JSON.stringify({ data }), {
			status: opts.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("CopilotCatalog", () => {
	const apiEndpoint = "https://api.individual.githubcopilot.com";

	it("fetches, parses, and routes from supported_endpoints and billing", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: modelsFetch([
				{
					id: "claude-sonnet-4.5",
					supported_endpoints: ["/v1/messages", "/chat/completions"],
					capabilities: {
						limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
						supports: { tool_calls: true, vision: true },
					},
					billing: { token_prices: { input: 3, output: 15, batch_size: 0 } },
				},
				{
					id: "gpt-4.1",
					supported_endpoints: ["/chat/completions"],
					billing: { token_prices: { input: 0, output: 0, batch_size: 0 } },
				},
			]),
		});
		const claude = await catalog.getEntry("claude-sonnet-4.5");
		expect(claude?.supportedEndpoints).toEqual(["/v1/messages", "/chat/completions"]);
		expect(claude?.zeroPriced).toBe(false);
		expect(resolveRoute("claude-sonnet-4.5", claude)).toBe("messages");

		const gpt41 = await catalog.getEntry("gpt-4.1");
		expect(gpt41?.zeroPriced).toBe(true);
	});

	it("caches within the TTL and refetches after it expires", async () => {
		let calls = 0;
		let clock = 0;
		const catalog = new CopilotCatalog({
			apiEndpoint,
			now: () => clock,
			fetch: modelsFetch([{ id: "gpt-5.6", supported_endpoints: ["/responses"] }], {
				onCall: () => {
					calls++;
				},
			}),
		});
		await catalog.load();
		await catalog.load();
		expect(calls).toBe(1); // second load served from cache
		clock += CATALOG_TTL_MS + 1;
		await catalog.load();
		expect(calls).toBe(2); // TTL expired → refetch
	});

	it("degrades to an empty catalog (name heuristic) on a fetch error without throwing", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: (async () => {
				throw new Error("network down");
			}) as typeof fetch,
		});
		const entry = await catalog.getEntry("claude-sonnet-4.5");
		expect(entry).toBeNull();
		// Routing still works via the name heuristic.
		expect(resolveRoute("claude-sonnet-4.5", entry)).toBe("messages");
	});

	it("degrades to an empty catalog on a non-OK response", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: modelsFetch([], { status: 500 }),
		});
		expect(await catalog.getEntry("gpt-5.6")).toBeNull();
	});

	it("single-flights concurrent loads into one fetch", async () => {
		let calls = 0;
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: (async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 10));
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.6" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		await Promise.all([catalog.load(), catalog.load()]);
		expect(calls).toBe(1);
	});
});
