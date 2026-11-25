import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, readDurableResponseByRefId } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { LLMError, LLMRefusalError, ModelRouter } from "@bound/llm";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";
import { waitFor } from "./helpers";

// The executor host is the only host that sees a relayed inference's provider
// answer, so it records that outcome against its OWN route health (model-routing
// spec §6.1), and it answers `route_health` snapshot requests from peers so the
// Settings › Models page on any host can show it.

const SITE = "exec-site";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const eventBus = (): TypedEventEmitter => new (require("@bound/shared").TypedEventEmitter)();

const CAPS = {
	streaming: true,
	tool_use: false,
	system_prompt: false,
	prompt_caching: false,
	vision: false,
	max_context: 8000,
};

const DONE: StreamChunk = {
	type: "done",
	usage: {
		input_tokens: 1,
		output_tokens: 1,
		cache_write_tokens: null,
		cache_read_tokens: null,
		estimated: false,
	},
};

type Behaviour = "ok" | Error | "slow";

class ScriptedBackend implements LLMBackend {
	refreshCalls = 0;
	refreshResult = false;
	constructor(private behaviour: Behaviour) {}
	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		if (this.behaviour instanceof Error) throw this.behaviour;
		yield { type: "text", content: "hi" };
		if (this.behaviour === "slow") {
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, 2_000);
				params.signal?.addEventListener("abort", () => {
					clearTimeout(t);
					resolve();
				});
			});
			if (params.signal?.aborted) throw new Error("This operation was aborted");
		}
		yield DONE;
	}
	capabilities() {
		return CAPS;
	}
	async refreshAuth(): Promise<boolean> {
		this.refreshCalls++;
		return this.refreshResult;
	}
}

let db: Database;

beforeEach(() => {
	db = new (require("bun:sqlite").Database)(":memory:");
	applySchema(db);
	db.run(
		"INSERT INTO hosts (site_id, host_name, version, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		[SITE, "exec", "1.0.0", new Date().toISOString()],
	);
});

function insertWork(kind: string, payload: unknown, streamId: string | null = null): string {
	const id = randomUUID();
	const now = new Date();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, ref_id, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
		[
			id,
			SITE,
			kind,
			JSON.stringify(payload),
			id,
			id,
			streamId,
			now.toISOString(),
			new Date(now.getTime() + 60_000).toISOString(),
			SITE,
			now.toISOString(),
		],
	);
	return id;
}

function insertInference(): { id: string; streamId: string } {
	const streamId = randomUUID();
	const id = insertWork(
		"inference",
		{
			threadId: "t-1",
			model: "opus",
			segments: [{ kind: "inline", message: { role: "user", content: "hello" } }],
			nowMs: 0,
			timeout_ms: 5_000,
		},
		streamId,
	);
	return { id, streamId };
}

function routerWith(backend: LLMBackend): ModelRouter {
	return new ModelRouter(new Map([["opus", backend]]), "opus");
}

function processorFor(router: ModelRouter | null): RelayProcessor {
	return new RelayProcessor(db, SITE, new Map<string, MCPClient>(), router, logger, eventBus());
}

async function runUntilResponse(processor: RelayProcessor, refId: string, kind: string) {
	const handle = processor.start(10);
	try {
		await waitFor(
			() =>
				(
					db
						.query("SELECT COUNT(*) AS n FROM durable_work WHERE ref_id = ? AND kind = ?")
						.get(refId, kind) as { n: number }
				).n > 0,
			{ message: `no ${kind} response for ${refId}` },
		);
	} finally {
		handle.stop();
	}
}

describe("RelayProcessor route_health (peer snapshot)", () => {
	it("answers with this host's own route health, backoff relative to now", async () => {
		const router = new ModelRouter(new Map(), "opus", undefined, undefined, undefined, () => 1_000);
		router.addDynamicBackend("opus", new ScriptedBackend("ok") as never, CAPS as never, undefined, {
			routeId: `${SITE}:bedrock:opus`,
			reasoningOrigin: `${SITE}:bedrock`,
		});
		router.addDynamicBackend("sol", new ScriptedBackend("ok") as never, CAPS as never, undefined, {
			routeId: `${SITE}:codex:sol`,
			reasoningOrigin: `${SITE}:codex`,
		});
		router.recordRouteFailure("sol", { errorKind: "server" });

		const id = insertWork("route_health", {});
		const handle = processorFor(router).start(10);
		await Bun.sleep(150);
		handle.stop();

		const response = readDurableResponseByRefId(db, id, SITE);
		expect(response?.kind).toBe("result");
		const envelope = JSON.parse(response?.payload ?? "{}") as { stdout: string };
		const snapshot = JSON.parse(envelope.stdout) as {
			routes: Array<{ route_id: string; status: string; next_trial_in_ms: number | null }>;
		};
		const byId = new Map(snapshot.routes.map((r) => [r.route_id, r]));
		expect(byId.get(`${SITE}:bedrock:opus`)).toEqual({
			route_id: `${SITE}:bedrock:opus`,
			status: "healthy",
			next_trial_in_ms: null,
		});
		expect(byId.get(`${SITE}:codex:sol`)).toEqual({
			route_id: `${SITE}:codex:sol`,
			status: "backoff",
			next_trial_in_ms: 30_000,
		});
	});

	it("answers an empty snapshot on a host with no model router", async () => {
		const id = insertWork("route_health", {});
		const handle = processorFor(null).start(10);
		await Bun.sleep(150);
		handle.stop();
		const response = readDurableResponseByRefId(db, id, SITE);
		expect(response?.kind).toBe("result");
		const envelope = JSON.parse(response?.payload ?? "{}") as { stdout: string };
		expect(JSON.parse(envelope.stdout)).toEqual({ routes: [] });
	});

	it("rejects an unexpected payload field with an error response", async () => {
		const id = insertWork("route_health", { surprise: true });
		const handle = processorFor(null).start(10);
		await Bun.sleep(150);
		handle.stop();
		expect(readDurableResponseByRefId(db, id, SITE)?.kind).toBe("error");
	});
});

describe("RelayProcessor relayed inference records executor route health", () => {
	it("a completed relayed stream restores a backed-off route to healthy", async () => {
		const router = routerWith(new ScriptedBackend("ok"));
		router.recordRouteFailure("opus", { errorKind: "server" });
		expect(router.getRouteHealthState("opus").status).toBe("backoff");
		insertInference();
		const handle = processorFor(router).start(10);
		try {
			await waitFor(() => router.getRouteHealthState("opus").status === "healthy", {
				message: "route did not return to healthy after a relayed success",
			});
		} finally {
			handle.stop();
		}
	});

	it("a provider 5xx trips backoff on the executor", async () => {
		const router = routerWith(new ScriptedBackend(new LLMError("upstream 503", "bedrock", 503)));
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		const state = router.getRouteHealthState("opus");
		expect(state.status).toBe("backoff");
		if (state.status === "backoff") expect(state.last_error_kind).toBe("server");
	});

	it("a 429 honours Retry-After exactly", async () => {
		const router = new ModelRouter(
			new Map([
				["opus", new ScriptedBackend(new LLMError("slow down", "bedrock", 429, undefined, 7_000))],
			]),
			"opus",
			undefined,
			undefined,
			undefined,
			() => 10_000,
		);
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		const state = router.getRouteHealthState("opus");
		expect(state.status).toBe("backoff");
		if (state.status === "backoff") {
			expect(state.last_error_kind).toBe("rate_limit");
			expect(state.next_trial_at).toBe(17_000);
		}
	});

	it("a refusal leaves the route healthy", async () => {
		const refusal = new LLMRefusalError(
			"declined",
			"bedrock",
			{ kind: "refusal", reason: "policy" } as never,
			400,
		);
		const router = routerWith(new ScriptedBackend(refusal));
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		expect(router.getRouteHealthState("opus").status).toBe("healthy");
	});

	it("a transport-class error (no provider status) leaves the route healthy", async () => {
		const router = routerWith(new ScriptedBackend(new Error("socket hang up ECONNRESET")));
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		expect(router.getRouteHealthState("opus").status).toBe("healthy");
	});

	it("an auth failure that a token refresh fixes leaves the route healthy", async () => {
		const backend = new ScriptedBackend(new LLMError("expired", "copilot", 401));
		backend.refreshResult = true;
		const router = routerWith(backend);
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		expect(backend.refreshCalls).toBe(1);
		expect(router.getRouteHealthState("opus").status).toBe("healthy");
	});

	it("an auth failure that survives refresh backs the route off", async () => {
		const backend = new ScriptedBackend(new LLMError("forbidden", "copilot", 403));
		const router = routerWith(backend);
		const { id } = insertInference();
		await runUntilResponse(processorFor(router), id, "error");
		expect(router.getRouteHealthState("opus").status).toBe("backoff");
	});

	it("a requester cancellation records nothing", async () => {
		const router = routerWith(new ScriptedBackend("slow"));
		router.recordRouteFailure("opus", { errorKind: "server" });
		const before = router.getRouteHealthState("opus");
		const { id } = insertInference();
		const handle = processorFor(router).start(10);
		try {
			await Bun.sleep(150);
			insertWork("cancel", {}, null);
			db.run("UPDATE durable_work SET ref_id = ? WHERE kind = 'cancel'", [id]);
			await waitFor(
				() =>
					(
						db
							.query("SELECT COUNT(*) AS n FROM durable_work WHERE ref_id = ? AND kind = 'error'")
							.get(id) as { n: number }
					).n > 0,
				{ message: "no cancel error response" },
			);
		} finally {
			handle.stop();
		}
		expect(router.getRouteHealthState("opus")).toEqual(before);
	});
});
