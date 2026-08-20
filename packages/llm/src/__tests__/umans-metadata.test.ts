import { describe, expect, it } from "bun:test";
import {
	type UmansModelMeta,
	deriveUmansTiers,
	fetchUmansModelMetadata,
	fetchUmansUsage,
} from "../umans-metadata";

// Build a fetch stub that maps URL substrings to JSON responses (or errors).
function stubFetch(
	routes: Record<string, { status?: number; body?: unknown; throw?: boolean }>,
): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		for (const [needle, spec] of Object.entries(routes)) {
			if (url.includes(needle)) {
				if (spec.throw) throw new Error("network down");
				return new Response(JSON.stringify(spec.body ?? {}), {
					status: spec.status ?? 200,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

const MODELS_INFO = {
	"umans-coder": {
		capabilities: {
			context_window: 200000,
			max_completion_tokens: 8192,
			supports_vision: "via-handoff",
			supports_tools: true,
			reasoning: {
				supported: true,
				can_disable: false,
				levels: ["low", "high"],
				default_level: "low",
			},
		},
	},
	"umans-flash": {
		capabilities: {
			context_window: 128000,
			max_completion_tokens: 4096,
			supports_vision: false,
			supports_tools: true,
			reasoning: { supported: false, can_disable: true },
		},
	},
	"umans-legacy": {
		capabilities: { context_window: 8000, supports_tools: true },
		deprecation: { sunset_date: "2020-01-01" },
	},
};

const MODELS_PRICING = {
	data: [
		{ id: "umans-coder", pricing: { input: 3, output: 15 } },
		{ id: "umans-flash", pricing: { input: 0.5, output: 1.5 } },
	],
};

describe("fetchUmansModelMetadata", () => {
	it("parses + merges /v1/models/info and /v1/models into the full lineup", async () => {
		const fetch = stubFetch({
			"/models/info": { body: MODELS_INFO },
			"/models": { body: MODELS_PRICING },
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Deprecated model excluded.
		expect(res.value.has("umans-legacy")).toBe(false);
		expect(res.value.size).toBe(2);

		const coder = res.value.get("umans-coder");
		expect(coder?.contextWindow).toBe(200000);
		// "via-handoff" → vision true.
		expect(coder?.supportsVision).toBe(true);
		expect(coder?.reasoningSupported).toBe(true);
		expect(coder?.pricePerMInput).toBe(3);
		expect(coder?.pricePerMOutput).toBe(15);

		const flash = res.value.get("umans-flash");
		expect(flash?.supportsVision).toBe(false);
		expect(flash?.pricePerMInput).toBe(0.5);
	});

	it("returns ok:false (no throw) on HTTP error", async () => {
		const fetch = stubFetch({
			"/models/info": { status: 500, body: {} },
			"/models": { body: MODELS_PRICING },
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(false);
	});

	it("returns ok:false (no throw) on network failure", async () => {
		const fetch = stubFetch({
			"/models/info": { throw: true },
			"/models": { body: MODELS_PRICING },
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(false);
	});

	it("parses the live bare-record shape with explicit null reasoning/pricing fields (regression)", async () => {
		// Live umans /v1/models/info is a BARE record (no `data` envelope) and
		// uses explicit `null` (not omission) for unset fields like
		// reasoning.default_level. A strict `.optional()` schema rejected null;
		// `.nullish()` must accept it.
		const fetch = stubFetch({
			"/models/info": {
				body: {
					"umans-coder": {
						capabilities: {
							context_window: 200000,
							max_completion_tokens: null,
							supports_vision: "via-handoff",
							supports_tools: true,
							reasoning: {
								supported: true,
								can_disable: null,
								levels: null,
								default_level: null,
							},
						},
					},
				},
			},
			"/models": {
				body: { data: [{ id: "umans-coder", pricing: { input: null, output: null } }] },
			},
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const coder = res.value.get("umans-coder");
		expect(coder).toBeDefined();
		expect(coder?.reasoningSupported).toBe(true);
		// null default_level → undefined, null pricing → unlisted (undefined).
		expect(coder?.reasoningDefault).toBeUndefined();
		expect(coder?.pricePerMInput).toBeUndefined();
		expect(coder?.supportsVision).toBe(true);
	});

	it("preserves undefined context_window as undefined (not 0) when API omits it", async () => {
		// When the umans /v1/models/info endpoint doesn't report context_window
		// for a model, the parsed metadata must carry undefined — NOT 0.
		// A 0 sentinel is falsy, so `||` at the consumption site (agent-loop.ts)
		// silently substitutes 200K, causing context-length errors on models
		// whose real window is unknown.
		const fetch = stubFetch({
			"/models/info": {
				body: {
					"umans-noctx": {
						capabilities: {
							max_completion_tokens: 4096,
							supports_tools: true,
						},
					},
				},
			},
			"/models": {
				body: { data: [{ id: "umans-noctx", pricing: { input: 0.5, output: 1.5 } }] },
			},
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const model = res.value.get("umans-noctx");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBeUndefined();
	});

	it("returns ok:false when no non-deprecated models remain", async () => {
		const fetch = stubFetch({
			"/models/info": { body: { "umans-legacy": MODELS_INFO["umans-legacy"] } },
			"/models": { body: { data: [] } },
		});
		const res = await fetchUmansModelMetadata("https://api.code.umans.ai/v1", { fetch });
		expect(res.ok).toBe(false);
	});
});

describe("fetchUmansUsage", () => {
	it("parses limits/usage with Bearer auth and never throws", async () => {
		let seenAuth: string | null = null;
		const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			seenAuth = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({
					limits: {
						concurrency: { limit: 4, hard_cap: 6 },
						requests: { limit: 100, hard_cap: 200, window_seconds: 60 },
					},
					usage: {
						concurrent_sessions: 1,
						remaining_requests: 99,
						priority: { boxed_until: null },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		const res = await fetchUmansUsage("https://api.code.umans.ai", "sk-test", { fetch });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.concurrencyLimit).toBe(4);
		expect(res.value.remainingRequests).toBe(99);
		expect(res.value.boxedUntil).toBeUndefined();
		// AC.9: Bearer auth, not x-api-key.
		expect(seenAuth).toBe("Bearer sk-test");
	});

	it("parses a future boxed_until into epoch ms", async () => {
		const now = new Date("2026-08-20T03:28:00.000Z");
		const future = new Date(now.getTime() + 60_000).toISOString();
		const fetch = (async () =>
			new Response(JSON.stringify({ usage: { priority: { boxed_until: future } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const res = await fetchUmansUsage("https://api.code.umans.ai", "sk-test", { fetch });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.boxedUntil).toBeGreaterThan(now.getTime());
	});

	it("returns ok:false on network failure (no throw)", async () => {
		const fetch = (async () => {
			throw new Error("down");
		}) as typeof fetch;
		const res = await fetchUmansUsage("https://api.code.umans.ai", "sk-test", { fetch });
		expect(res.ok).toBe(false);
	});
});

describe("deriveUmansTiers (AC.18)", () => {
	function meta(id: string, price?: number): UmansModelMeta {
		return {
			id,
			contextWindow: 100000,
			supportsVision: false,
			supportsTools: true,
			reasoningSupported: false,
			reasoningCanDisable: true,
			pricePerMInput: price,
		};
	}

	it("K=1 → tier 5 (cheapest)", () => {
		const tiers = deriveUmansTiers([meta("a", 1)]);
		expect(tiers.get("a")).toBe(5);
	});

	it("K=5 → cheapest tier 5, dearest tier 1, evenly distributed", () => {
		const tiers = deriveUmansTiers([
			meta("e", 50),
			meta("a", 1),
			meta("d", 20),
			meta("b", 5),
			meta("c", 10),
		]);
		// sorted asc: a(1) b(5) c(10) d(20) e(50) → tiers 5,4,3,2,1
		expect(tiers.get("a")).toBe(5);
		expect(tiers.get("b")).toBe(4);
		expect(tiers.get("c")).toBe(3);
		expect(tiers.get("d")).toBe(2);
		expect(tiers.get("e")).toBe(1);
	});

	it("K>5 → still spans tiers 1..5, cheapest 5 / dearest 1", () => {
		const models = [10, 20, 30, 40, 50, 60].map((p, i) => meta(`m${i}`, p));
		const tiers = deriveUmansTiers(models);
		const values = models.map((m) => tiers.get(m.id));
		// cheapest gets 5, dearest gets 1; all within 1..5
		expect(Math.max(...(values as number[]))).toBe(5);
		expect(Math.min(...(values as number[]))).toBe(1);
		expect(tiers.get("m0")).toBe(5);
		expect(tiers.get("m5")).toBe(1);
	});

	it("a model with no listed price sorts as cheapest and is still registered (tier 5)", () => {
		const tiers = deriveUmansTiers([meta("priced", 10), meta("free")]);
		expect(tiers.get("free")).toBe(5);
		expect(tiers.has("priced")).toBe(true);
	});

	it("is deterministic via stable secondary sort by id on price ties", () => {
		const t1 = deriveUmansTiers([meta("b", 5), meta("a", 5), meta("c", 5)]);
		const t2 = deriveUmansTiers([meta("c", 5), meta("a", 5), meta("b", 5)]);
		expect(t1.get("a")).toBe(t2.get("a"));
		expect(t1.get("b")).toBe(t2.get("b"));
		expect(t1.get("c")).toBe(t2.get("c"));
	});
});
