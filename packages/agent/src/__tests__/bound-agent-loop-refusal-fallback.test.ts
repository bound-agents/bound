import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { BackendConfig, LLMBackend, ModelDeclinedOutcome, StreamChunk } from "@bound/llm";
import { LLMError, LLMRefusalError, ModelRouter, makeRouteId } from "@bound/llm";
import { ROUTING_DEFAULT_FALLBACK_MODELS_KEY } from "@bound/shared";
import { MainAgentLoop } from "../agent-loop";

/**
 * Loop-host refusal-fallback walk (2026-11-21-model-routing.md §7.2–§7.4,
 * R-RT15–R-RT17, R-RT20, R-RT21). Two local routes serve two DIFFERENT logical
 * models: `route-a` → `m1` (the requested model) and `route-b` → `m2`, plus
 * `route-c` → `m3`. A refusal on `m1` that no co-located credit carried returns
 * to the loop host, which walks the fallback chain to the next model.
 */

const SITE = "test-site-id";

const CAPS = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: false,
	vision: false,
	max_context: 8000,
};

const USAGE = (input: number, output: number) => ({
	input_tokens: input,
	output_tokens: output,
	cache_write_tokens: null,
	cache_read_tokens: null,
	estimated: false,
});

function declined(over: Partial<ModelDeclinedOutcome> = {}): ModelDeclinedOutcome {
	return {
		kind: "model-declined",
		vendor: "anthropic",
		category: "cyber",
		raw_reason: "refusal",
		explanation: "classifier declined",
		substitutable: true,
		...over,
	};
}

/** 200-shaped refusal: partial text, then a `content-filter` done chunk. */
class RefusingBackend implements LLMBackend {
	calls = 0;
	constructor(private readonly outcome: ModelDeclinedOutcome | null = declined()) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.calls++;
		yield { type: "text" as const, content: "refused partial" };
		yield {
			type: "done" as const,
			usage: USAGE(100, 3),
			finish_reason: "content-filter" as const,
			...(this.outcome ? { declined: this.outcome } : {}),
		};
	}
	capabilities() {
		return CAPS;
	}
}

/** Error-shaped refusal (e.g. Gemini Interactions 400 safety block). */
class ThrowingRefusalBackend implements LLMBackend {
	calls = 0;
	constructor(private readonly outcome: ModelDeclinedOutcome) {}
	// biome-ignore lint/correctness/useYield: throws before the first yield
	async *chat(): AsyncGenerator<StreamChunk> {
		this.calls++;
		throw new LLMRefusalError("safety block", "google", this.outcome, 400);
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
		yield { type: "done" as const, usage: USAGE(40, 7) };
	}
	capabilities() {
		return CAPS;
	}
}

/** Scripted refuse / empty (degenerate) / text responses with its own context window. */
class WindowedBackend implements LLMBackend {
	calls = 0;
	constructor(
		private readonly steps: Array<"refuse" | "empty" | "text">,
		private readonly maxContext: number,
		private readonly label: string,
	) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
		this.calls++;
		if (step === "refuse") {
			yield {
				type: "done" as const,
				usage: USAGE(100, 3),
				finish_reason: "content-filter" as const,
				declined: declined(),
			};
			return;
		}
		if (step === "empty") {
			// Thinking with no text or tool call: a degenerate turn.
			yield { type: "thinking" as const, content: "pondering" };
			yield { type: "done" as const, usage: USAGE(20, 0) };
			return;
		}
		yield { type: "text" as const, content: `served by ${this.label}` };
		yield { type: "done" as const, usage: USAGE(40, 7) };
	}
	capabilities() {
		return { ...CAPS, max_context: this.maxContext };
	}
}

/**
 * A driver-level inline credited retry on one stream: the refused primary
 * attempt, then the step the driver served on `servedModel` with the credit.
 */
class InlineCreditedBackend implements LLMBackend {
	calls = 0;
	constructor(
		private readonly servedModel: string,
		private readonly emitToolCall = false,
	) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.calls++;
		yield {
			type: "done" as const,
			usage: USAGE(100, 3),
			finish_reason: "content-filter" as const,
			declined: declined({ credit: { token: "tok-1", endpoint: "ep-A" } }),
		};
		if (this.emitToolCall) {
			const id = `call-inline-${this.calls}`;
			yield { type: "tool_use_start" as const, id, name: "bash" };
			yield { type: "tool_use_args" as const, id, partial_json: '{"command":"echo hi"}' };
			yield { type: "tool_use_end" as const, id };
		} else {
			yield { type: "text" as const, content: "served inline" };
		}
		yield {
			type: "done" as const,
			usage: USAGE(40, 7),
			finish_reason: "stop" as const,
			served_model: this.servedModel,
			credit_redeemed: true,
		};
	}
	capabilities() {
		return CAPS;
	}
}

type Step = "refuse" | "tool" | "text";

/** Plays a scripted sequence of responses, repeating the last step once exhausted. */
class ScriptedBackend implements LLMBackend {
	calls = 0;
	constructor(
		public steps: Step[],
		private readonly label: string,
	) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
		this.calls++;
		if (step === "refuse") {
			yield { type: "text" as const, content: "refused partial" };
			yield {
				type: "done" as const,
				usage: USAGE(100, 3),
				finish_reason: "content-filter" as const,
				declined: declined(),
			};
			return;
		}
		if (step === "tool") {
			const id = `call-${this.label}-${this.calls}`;
			yield { type: "tool_use_start" as const, id, name: "bash" };
			yield { type: "tool_use_args" as const, id, partial_json: '{"command":"echo hi"}' };
			yield { type: "tool_use_end" as const, id };
			yield { type: "done" as const, usage: USAGE(30, 5) };
			return;
		}
		yield { type: "text" as const, content: `served by ${this.label}` };
		yield { type: "done" as const, usage: USAGE(40, 7) };
	}
	capabilities() {
		return CAPS;
	}
}

function makeRouter(
	backends: Record<string, LLMBackend>,
	logicalOverrides: Record<string, string> = {},
): ModelRouter {
	const logical: Record<string, string> = {
		"route-a": "m1",
		"route-b": "m2",
		"route-c": "m3",
		...logicalOverrides,
	};
	const map = new Map<string, LLMBackend>(Object.entries(backends));
	const configs = new Map<string, BackendConfig>(
		Object.keys(backends).map((id) => [
			id,
			{ id, provider: "openai-compatible", model: logical[id], logicalModel: logical[id] },
		]),
	);
	const identities = new Map(
		Object.keys(backends).map((id) => [
			id,
			{ routeId: makeRouteId(SITE, "openai-compatible", id), reasoningOrigin: `${SITE}:oc` },
		]),
	);
	return new ModelRouter(map, "route-a", undefined, configs, undefined, Date.now, identities);
}

describe("MainAgentLoop refusal-fallback walk (§7.3)", () => {
	let db: Database;
	let threadId: string;
	let events: Array<{ event: string; payload: Record<string, unknown> }>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		threadId = randomUUID();
		events = [];
	});
	afterEach(() => db.close());

	function seedDefaults(models: string[]) {
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
				value: JSON.stringify(models),
				modified_at: new Date().toISOString(),
			},
			SITE,
		);
	}

	function seedPolicy(model: string, policy: unknown) {
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: model,
				route_order: null,
				fallback_policy: JSON.stringify(policy),
				modified_at: new Date().toISOString(),
			},
			SITE,
		);
	}

	function makeLoop(router: ModelRouter, modelId = "m1") {
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: {
				on: () => {},
				off: () => {},
				emit: (event: string, payload: Record<string, unknown>) => events.push({ event, payload }),
			},
			hostName: "test-host",
			siteId: SITE,
		} as unknown as AppContext;
		const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
		return new MainAgentLoop(ctx, sandbox, router, { threadId, userId: "u", modelId });
	}

	function turns() {
		return db
			.query(
				"SELECT model_id, route_id, substituted_from, tokens_in, tokens_out, cost_breakdown, status FROM turns WHERE thread_id = ? ORDER BY created_at, rowid",
			)
			.all(threadId) as Array<{
			model_id: string;
			route_id: string | null;
			substituted_from: string | null;
			tokens_in: number;
			tokens_out: number;
			cost_breakdown: string | null;
			status: string;
		}>;
	}

	function messages() {
		return db
			.query("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at")
			.all(threadId) as Array<{ role: string; content: string }>;
	}

	const byEvent = (name: string) => events.filter((e) => e.event === name).map((e) => e.payload);

	it("walks routing.default_fallback_models on a 200-shaped content-filter refusal", async () => {
		seedDefaults(["m2"]);
		const refusing = new RefusingBackend();
		const substitute = new TextBackend("served by m2");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(refusing.calls).toBe(1);
		expect(substitute.calls).toBe(1);

		// One turn row, served by the substitute, carrying the original model.
		const rows = turns();
		expect(rows).toHaveLength(1);
		expect(rows[0].model_id).toBe("route-b");
		expect(rows[0].substituted_from).toBe("m1");
		expect(rows[0].route_id).toBe(makeRouteId(SITE, "openai-compatible", "route-b"));
		// Top-level tokens are the served model's own numbers, never summed.
		expect(rows[0].tokens_in).toBe(40);
		expect(rows[0].tokens_out).toBe(7);
		const breakdown = JSON.parse(rows[0].cost_breakdown ?? "{}") as {
			attempts: Array<{
				model_id: string;
				route_id: string | null;
				outcome: string;
				refusal_category: string | null;
				credit_redeemed: boolean;
				tokens: { input: number; output: number };
			}>;
		};
		expect(breakdown.attempts).toHaveLength(2);
		expect(breakdown.attempts[0]).toMatchObject({
			model_id: "m1",
			route_id: makeRouteId(SITE, "openai-compatible", "route-a"),
			outcome: "refusal",
			refusal_category: "cyber",
			credit_redeemed: false,
			tokens: { input: 100, output: 3 },
		});
		expect(breakdown.attempts[1]).toMatchObject({
			model_id: "m2",
			outcome: "ok",
			refusal_category: null,
			tokens: { input: 40, output: 7 },
		});

		// No refused partial assistant row; the substitute's reply is persisted.
		const assistant = messages().filter((m) => m.role === "assistant");
		expect(assistant.map((m) => m.content)).toEqual(["served by m2"]);
		expect(messages().some((m) => m.content.includes("refused partial"))).toBe(false);

		// The refused route stays healthy (R-RT15).
		expect(router.getRouteHealthState("route-a").status).toBe("healthy");

		const refusals = byEvent("llm:refusal");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({
			model: "m1",
			route_id: makeRouteId(SITE, "openai-compatible", "route-a"),
			vendor: "anthropic",
			category: "cyber",
			substitutable: true,
		});
		const fallbacks = byEvent("llm:fallback");
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toMatchObject({
			refused_model: "m1",
			substitute_model: "m2",
			credit_redeemed: false,
			policy_mode: "auto",
		});
	});

	it("walks the chain on a thrown substitutable LLMRefusalError", async () => {
		seedDefaults(["m2"]);
		const refusing = new ThrowingRefusalBackend(declined({ vendor: "google", category: "SAFETY" }));
		const substitute = new TextBackend("served by m2");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(refusing.calls).toBe(1);
		expect(substitute.calls).toBe(1);
		const rows = turns();
		expect(rows).toHaveLength(1);
		expect(rows[0].substituted_from).toBe("m1");
		const breakdown = JSON.parse(rows[0].cost_breakdown ?? "{}") as {
			attempts: Array<{ model_id: string; outcome: string; refusal_category: string | null }>;
		};
		expect(breakdown.attempts.map((a) => [a.model_id, a.outcome, a.refusal_category])).toEqual([
			["m1", "refusal", "SAFETY"],
			["m2", "ok", null],
		]);
		expect(router.getRouteHealthState("route-a").status).toBe("healthy");
		expect(byEvent("llm:refusal")[0]).toMatchObject({ model: "m1", vendor: "google" });
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({ refused_model: "m1", substitute_model: "m2" }),
		]);
		// No partial-salvage developer row for a refusal (R-RT16).
		expect(messages().some((m) => m.content.includes("[Partial response"))).toBe(false);
	});

	it("halts immediately on substitutable:false and surfaces category + explanation", async () => {
		seedDefaults(["m2"]);
		const refusing = new ThrowingRefusalBackend(
			declined({ category: "reasoning_extraction", substitutable: false }),
		);
		const substitute = new TextBackend("must not run");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });

		const result = await makeLoop(router).run();

		expect(result.error).toContain("reasoning_extraction");
		expect(result.error).toContain("classifier declined");
		expect(substitute.calls).toBe(0);
		const alert = messages().find((m) => m.role === "alert");
		expect(alert?.content).toContain("reasoning_extraction");
		const rows = turns();
		expect(rows).toHaveLength(1);
		expect(rows[0].substituted_from).toBeNull();
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({ refused_model: "m1", substitute_model: null }),
		]);
	});

	it("does not substitute a hard-pinned request (R-RT10)", async () => {
		seedDefaults(["m2"]);
		const refusing = new RefusingBackend();
		const substitute = new TextBackend("must not run");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });
		const pin = `m1@${makeRouteId(SITE, "openai-compatible", "route-a")}`;

		await makeLoop(router, pin).run();

		expect(refusing.calls).toBe(1);
		expect(substitute.calls).toBe(0);
		expect(messages().some((m) => m.role === "assistant")).toBe(false);
		const alert = messages().find((m) => m.role === "alert");
		expect(alert?.content).toContain("content-filter");
		expect(alert?.content).toContain("hard-pinned");
		expect(turns()[0].substituted_from).toBeNull();
	});

	it("honors a per-model never policy", async () => {
		seedDefaults(["m2"]);
		seedPolicy("m1", { mode: "never" });
		const refusing = new RefusingBackend();
		const substitute = new TextBackend("must not run");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });

		await makeLoop(router).run();

		expect(substitute.calls).toBe(0);
		expect(messages().find((m) => m.role === "alert")?.content).toContain('"never"');
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({ substitute_model: null, policy_mode: "never" }),
		]);
	});

	it("walks a per-model custom list in order, ignoring the cluster defaults", async () => {
		seedDefaults(["m2"]);
		seedPolicy("m1", { mode: "custom", models: ["m3", "m2"] });
		const refusing = new RefusingBackend();
		const m2 = new TextBackend("served by m2");
		const m3 = new TextBackend("served by m3");
		const router = makeRouter({ "route-a": refusing, "route-b": m2, "route-c": m3 });

		await makeLoop(router).run();

		expect(m3.calls).toBe(1);
		expect(m2.calls).toBe(0);
		expect(turns()[0].substituted_from).toBe("m1");
		expect(byEvent("llm:fallback")[0]).toMatchObject({
			substitute_model: "m3",
			policy_mode: "custom",
		});
	});

	it("surfaces the refusal with substitute_model null when every candidate refuses", async () => {
		seedDefaults(["m2", "missing-model"]);
		const a = new RefusingBackend();
		const b = new RefusingBackend(declined({ category: "bio" }));
		const router = makeRouter({ "route-a": a, "route-b": b });

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(a.calls).toBe(1);
		expect(b.calls).toBe(1);
		expect(messages().some((m) => m.role === "assistant")).toBe(false);
		const alert = messages().find((m) => m.role === "alert");
		expect(alert?.content).toContain("bio");
		const rows = turns();
		expect(rows).toHaveLength(1);
		expect(rows[0].substituted_from).toBeNull();
		const breakdown = JSON.parse(rows[0].cost_breakdown ?? "{}") as {
			attempts: Array<{ model_id: string; outcome: string }>;
		};
		expect(breakdown.attempts.map((x) => [x.model_id, x.outcome])).toEqual([
			["m1", "refusal"],
			["m2", "refusal"],
		]);
		expect(byEvent("llm:refusal").map((e) => e.model)).toEqual(["m1", "m2"]);
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({ refused_model: "m1", substitute_model: null }),
		]);
		expect(router.getRouteHealthState("route-a").status).toBe("healthy");
		expect(router.getRouteHealthState("route-b").status).toBe("healthy");
	});

	it("stamps substituted_from on every turn of a substituted run and sticks the next run", async () => {
		seedDefaults(["m2"]);
		const m1 = new ScriptedBackend(["refuse"], "m1");
		const m2 = new ScriptedBackend(["tool", "text"], "m2");
		const router = makeRouter({ "route-a": m1, "route-b": m2 });

		const first = await makeLoop(router).run();

		expect(first.error).toBeUndefined();
		expect(m1.calls).toBe(1);
		expect(m2.calls).toBe(2);
		const rows = turns();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => [r.model_id, r.substituted_from])).toEqual([
			["route-b", "m1"],
			["route-b", "m1"],
		]);

		m2.steps = ["text"];
		await makeLoop(router).run();

		expect(m1.calls).toBe(1);
		expect(m2.calls).toBe(3);
		const after = turns();
		expect(after).toHaveLength(3);
		expect(after[2]).toMatchObject({ model_id: "route-b", substituted_from: "m1" });
	});

	it("keeps stickiness and substituted_from across consecutive runs after a substitution", async () => {
		seedDefaults(["m2"]);
		const m1 = new ScriptedBackend(["refuse"], "m1");
		const m2 = new ScriptedBackend(["text"], "m2");
		const router = makeRouter({ "route-a": m1, "route-b": m2 });

		await makeLoop(router).run();
		await makeLoop(router).run();
		await makeLoop(router).run();

		expect(m1.calls).toBe(1);
		expect(m2.calls).toBe(3);
		expect(turns().map((r) => [r.model_id, r.substituted_from])).toEqual([
			["route-b", "m1"],
			["route-b", "m1"],
			["route-b", "m1"],
		]);
	});

	it("walks the requested model's chain when a sticky substitute refuses", async () => {
		seedDefaults(["m2", "m3"]);
		// The substitute's own policy must not govern the walk (R-RT17).
		seedPolicy("m2", { mode: "never" });
		const m1 = new ScriptedBackend(["refuse"], "m1");
		const m2 = new ScriptedBackend(["text"], "m2");
		const m3 = new ScriptedBackend(["text"], "m3");
		const router = makeRouter({ "route-a": m1, "route-b": m2, "route-c": m3 });

		await makeLoop(router).run();
		expect(turns()[0]).toMatchObject({ model_id: "route-b", substituted_from: "m1" });

		m2.steps = ["refuse"];
		const second = await makeLoop(router).run();

		expect(second.error).toBeUndefined();
		// Never re-dispatches the already-refused original.
		expect(m1.calls).toBe(1);
		expect(m2.calls).toBe(2);
		expect(m3.calls).toBe(1);
		const rows = turns();
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ model_id: "route-c", substituted_from: "m1" });
		const breakdown = JSON.parse(rows[1].cost_breakdown ?? "{}") as {
			attempts: Array<{ model_id: string; outcome: string }>;
		};
		expect(breakdown.attempts.map((a) => [a.model_id, a.outcome])).toEqual([
			["m2", "refusal"],
			["m3", "ok"],
		]);
		expect(byEvent("llm:fallback").at(-1)).toMatchObject({
			refused_model: "m1",
			substitute_model: "m3",
			policy_mode: "auto",
		});
	});

	it("names only attempted models in the exhausted-walk alert", async () => {
		seedDefaults(["missing-model", "m2"]);
		const a = new RefusingBackend(declined({ explanation: "classifier declined." }));
		const b = new RefusingBackend();
		const router = makeRouter({ "route-a": a, "route-b": b });

		await makeLoop(router).run();

		const alert = messages().find((m) => m.role === "alert")?.content ?? "";
		expect(alert).toContain("tried: m1, m2)");
		expect(alert).not.toContain("missing-model");
		expect(alert).not.toContain("..");
	});

	it("surfaces a thrown refusal cleanly when no candidate is eligible", async () => {
		seedDefaults(["missing-model"]);
		const refusing = new ThrowingRefusalBackend(declined());
		const router = makeRouter({ "route-a": refusing });

		const result = await makeLoop(router).run();

		expect(result.error).toContain("Model refused the request");
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({ refused_model: "m1", substitute_model: null }),
		]);
		expect(turns()).toHaveLength(1);
	});

	it("fails over across the substitute's own routes without bouncing back to the refused original", async () => {
		seedDefaults(["m2"]);
		const m1 = new RefusingBackend();
		let b1Calls = 0;
		const b1: LLMBackend = {
			// biome-ignore lint/correctness/useYield: throws before the first yield
			async *chat() {
				b1Calls++;
				throw new LLMError("rate limited", "openai-compatible", 429);
			},
			capabilities: () => CAPS,
		};
		const b2 = new TextBackend("served by m2 second route");
		const router = makeRouter(
			{ "route-a": m1, "route-b1": b1, "route-b2": b2 },
			{ "route-b1": "m2", "route-b2": "m2" },
		);

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(m1.calls).toBe(1);
		expect(b1Calls).toBe(1);
		expect(b2.calls).toBe(1);
		expect(router.getRouteHealthState("route-a").status).toBe("healthy");
		expect(router.getRouteHealthState("route-b1").status).toBe("backoff");
		expect(turns()).toHaveLength(1);
		expect(turns()[0]).toMatchObject({ model_id: "route-b2", substituted_from: "m1" });
		expect(messages().find((m) => m.role === "assistant")?.content).toBe(
			"served by m2 second route",
		);
	});

	it("re-derives the frame for a smaller-window substitute and keeps it across a later rebuild", async () => {
		seedDefaults(["m2"]);
		const refusing = new WindowedBackend(["refuse"], 16000, "m1");
		// The substitute's first reply is degenerate, forcing a rebuildFrame retry.
		const substitute = new WindowedBackend(["empty", "text"], 8000, "m2");
		const router = makeRouter({ "route-a": refusing, "route-b": substitute });

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(refusing.calls).toBe(1);
		expect(substitute.calls).toBe(2);
		const rows = db
			.query(
				"SELECT model_id, substituted_from, context_debug FROM turns WHERE thread_id = ? ORDER BY created_at, rowid",
			)
			.all(threadId) as Array<{
			model_id: string;
			substituted_from: string | null;
			context_debug: string | null;
		}>;
		// The degenerate reply and the served retry, both on the substitute.
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toMatchObject({ model_id: "route-b", substituted_from: "m1" });
			const debug = JSON.parse(row.context_debug ?? "{}") as {
				contextWindow: number;
				model: string;
				truncationTargetTokens?: number;
			};
			// Budgeted against the substitute's window, never the run-start model's.
			expect(debug.contextWindow).toBe(8000);
			expect(debug.model).toBe("route-b");
			expect(debug.truncationTargetTokens).toBeLessThanOrEqual(8000);
		}
		expect(messages().find((m) => m.role === "assistant")?.content).toBe("served by m2");
	});

	it("records an inline credited retry's served model and credit on the turn and events", async () => {
		const inline = new InlineCreditedBackend("m2");
		const unused = new TextBackend("never dispatched");
		const router = makeRouter({ "route-a": inline, "route-b": unused });

		const result = await makeLoop(router).run();

		expect(result.error).toBeUndefined();
		expect(inline.calls).toBe(1);
		expect(unused.calls).toBe(0);
		const rows = turns();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			model_id: "route-b",
			route_id: makeRouteId(SITE, "openai-compatible", "route-b"),
			substituted_from: "m1",
			tokens_in: 40,
			tokens_out: 7,
		});
		const breakdown = JSON.parse(rows[0].cost_breakdown ?? "{}") as {
			attempts: Array<{
				model_id: string;
				route_id: string | null;
				outcome: string;
				credit_redeemed: boolean;
			}>;
		};
		expect(breakdown.attempts).toEqual([
			expect.objectContaining({
				model_id: "m1",
				route_id: makeRouteId(SITE, "openai-compatible", "route-a"),
				outcome: "refusal",
				credit_redeemed: false,
			}),
			expect.objectContaining({
				model_id: "m2",
				route_id: makeRouteId(SITE, "openai-compatible", "route-b"),
				outcome: "ok",
				credit_redeemed: true,
			}),
		]);
		expect(byEvent("llm:refusal")).toEqual([expect.objectContaining({ model: "m1" })]);
		expect(byEvent("llm:fallback")).toEqual([
			expect.objectContaining({
				refused_model: "m1",
				substitute_model: "m2",
				credit_redeemed: true,
			}),
		]);
		expect(messages().find((m) => m.role === "assistant")?.content).toBe("served inline");
	});

	it("stays on the substitute for turn 2 and the next run after an inline credited retry", async () => {
		const inline = new InlineCreditedBackend("m2", true);
		const substitute = new TextBackend("served by m2 after tool");
		const router = makeRouter({ "route-a": inline, "route-b": substitute });

		const first = await makeLoop(router).run();

		expect(first.error).toBeUndefined();
		// Turn 1 ran on route-a (inline credited retry -> tool call); turn 2 stayed on route-b.
		expect(inline.calls).toBe(1);
		expect(substitute.calls).toBe(1);
		const firstRows = turns();
		expect(firstRows).toHaveLength(2);
		expect(firstRows[0]).toMatchObject({
			model_id: "route-b",
			route_id: makeRouteId(SITE, "openai-compatible", "route-b"),
			substituted_from: "m1",
		});
		expect(firstRows[1]).toMatchObject({
			model_id: "route-b",
			route_id: makeRouteId(SITE, "openai-compatible", "route-b"),
			substituted_from: "m1",
		});

		// Next run inherits stickiness to route-b without re-hitting route-a.
		const second = await makeLoop(router).run();
		expect(second.error).toBeUndefined();
		expect(inline.calls).toBe(1);
		expect(substitute.calls).toBe(2);
		expect(turns()[2]).toMatchObject({
			model_id: "route-b",
			route_id: makeRouteId(SITE, "openai-compatible", "route-b"),
			substituted_from: "m1",
		});
	});
});
