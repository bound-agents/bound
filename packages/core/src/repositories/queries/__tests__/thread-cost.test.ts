import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Thread, Turn } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { sumTurnCostByThreadAndDirectChildren } from "../thread-cost";

const SITE = "site-test";

let db: Database;

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
	return {
		id: overrides.id,
		user_id: overrides.user_id ?? "user-1",
		interface: overrides.interface ?? "web",
		host_origin: overrides.host_origin ?? "host-a",
		color: overrides.color ?? 0,
		title: overrides.title ?? null,
		summary: overrides.summary ?? null,
		summary_through: overrides.summary_through ?? null,
		summary_model_id: overrides.summary_model_id ?? null,
		extracted_through: overrides.extracted_through ?? null,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		last_message_at: overrides.last_message_at ?? "2026-01-01T00:00:00.000Z",
		modified_at: overrides.modified_at ?? "2026-01-01T00:00:00.000Z",
		deleted: overrides.deleted ?? 0,
		model_hint: overrides.model_hint ?? null,
		parent_thread_id: overrides.parent_thread_id ?? null,
		agent_id: overrides.agent_id ?? null,
	};
}

function seedThread(overrides: Partial<Thread> & { id: string }): void {
	insertRow(db, "threads", makeThread(overrides), SITE);
}

function makeTurn(overrides: Partial<Turn> & { id: string }): Turn {
	return {
		id: overrides.id,
		thread_id: overrides.thread_id ?? null,
		task_id: overrides.task_id ?? null,
		dag_root_id: overrides.dag_root_id ?? null,
		model_id: overrides.model_id ?? "model-a",
		tokens_in: overrides.tokens_in ?? 0,
		tokens_out: overrides.tokens_out ?? 0,
		tokens_cache_write: overrides.tokens_cache_write ?? null,
		tokens_cache_read: overrides.tokens_cache_read ?? null,
		cost_usd: overrides.cost_usd ?? null,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		status: overrides.status ?? null,
		relay_target: overrides.relay_target ?? null,
		relay_latency_ms: overrides.relay_latency_ms ?? null,
		context_debug: overrides.context_debug ?? null,
		host_origin: overrides.host_origin ?? null,
		modified_at: overrides.modified_at ?? null,
	};
}

function seedTurn(overrides: Partial<Turn> & { id: string }): void {
	insertRow(db, "turns", makeTurn(overrides), SITE);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("sumTurnCostByThreadAndDirectChildren", () => {
	it("sums the parent and its direct aux children without including other threads", () => {
		seedThread({ id: "main" });
		seedThread({ id: "aux-a", interface: "aux", parent_thread_id: "main" });
		seedThread({ id: "aux-b", interface: "aux", parent_thread_id: "main" });
		seedThread({ id: "nested", interface: "aux", parent_thread_id: "aux-a" });
		seedThread({ id: "other" });

		seedTurn({ id: "main-turn", thread_id: "main", cost_usd: 0.1 });
		seedTurn({ id: "aux-a-turn", thread_id: "aux-a", cost_usd: 0.2 });
		seedTurn({ id: "aux-b-turn", thread_id: "aux-b", cost_usd: 0.3 });
		seedTurn({ id: "nested-turn", thread_id: "nested", cost_usd: 0.4 });
		seedTurn({ id: "other-turn", thread_id: "other", cost_usd: 0.5 });
		seedTurn({ id: "deleted-turn", thread_id: "aux-a", cost_usd: 0.6 });
		softDelete(db, "turns", "deleted-turn", SITE);

		expect(sumTurnCostByThreadAndDirectChildren(db, "main")).toEqual({ total: 0.6 });
	});

	it("returns null when neither the thread nor a child has a turn", () => {
		seedThread({ id: "main" });
		seedThread({ id: "aux", interface: "aux", parent_thread_id: "main" });

		expect(sumTurnCostByThreadAndDirectChildren(db, "main")).toEqual({ total: null });
	});
});
