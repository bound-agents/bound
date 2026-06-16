import { describe, expect, it } from "bun:test";
import { insertRow } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	countAssistantMessages,
	createHarnessEnvironment,
	latestAssistantText,
	latestTurnMetrics,
	silentEventBus,
	silentLogger,
} from "../environment";

/**
 * A minimal raw `model_backends.json`-shaped config. Only the fields the
 * harness environment reads (`backends`, `default`) need to be present;
 * everything downstream that consumes `ctx.config.modelBackends` does so
 * during inference, which these tests never trigger.
 */
const RAW_BACKENDS = {
	default: "stub",
	backends: [{ id: "stub", driver: "openai-compatible", model: "stub-model" }],
} as unknown as Parameters<typeof createHarnessEnvironment>[0]["rawBackends"];

/** A router that is never actually called (no test here runs a loop). */
const STUB_ROUTER = {} as unknown as ModelRouter;

function makeEnv(overrides?: Partial<Parameters<typeof createHarnessEnvironment>[0]>) {
	return createHarnessEnvironment({
		rawBackends: RAW_BACKENDS,
		router: STUB_ROUTER,
		...overrides,
	});
}

describe("createHarnessEnvironment", () => {
	it("applies the full schema (synced tables + metrics turns table exist)", () => {
		const env = makeEnv();
		try {
			const tables = env.db
				.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((r) => r.name);
			expect(tables).toContain("threads");
			expect(tables).toContain("messages");
			expect(tables).toContain("semantic_memory");
			// metrics schema
			expect(tables).toContain("turns");
		} finally {
			env.close();
		}
	});

	it("seeds exactly one user and one thread, carrying title + summary", () => {
		const env = makeEnv({ threadTitle: "my-fixture", threadSummary: "a summary" });
		try {
			const users = env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM users").get();
			const threads = env.db
				.query<{ n: number; title: string; summary: string; summary_through: string | null }, []>(
					"SELECT COUNT(*) n, title, summary, summary_through FROM threads",
				)
				.get();
			expect(users?.n).toBe(1);
			expect(threads?.n).toBe(1);
			expect(threads?.title).toBe("my-fixture");
			expect(threads?.summary).toBe("a summary");
			// summary_through is stamped only when a summary is present.
			expect(threads?.summary_through).not.toBeNull();
		} finally {
			env.close();
		}
	});

	it("leaves summary_through null when no summary is given", () => {
		const env = makeEnv({ threadSummary: null });
		try {
			const row = env.db
				.query<{ summary: string | null; summary_through: string | null }, []>(
					"SELECT summary, summary_through FROM threads",
				)
				.get();
			expect(row?.summary).toBeNull();
			expect(row?.summary_through).toBeNull();
		} finally {
			env.close();
		}
	});

	it("builds a ctx whose allowlist contains the seeded user and carries host identity", () => {
		const env = makeEnv({ hostName: "test-host" });
		try {
			expect(env.ctx.siteId).toBe(env.siteId);
			expect(env.ctx.hostName).toBe("test-host");
			expect(env.hostName).toBe("test-host");
			expect(env.ctx.config.allowlist.users).toEqual([env.userId]);
			// The picked backends config is threaded through for cost calculation.
			expect(env.ctx.config.modelBackends).toBe(RAW_BACKENDS);
		} finally {
			env.close();
		}
	});

	it("close() closes the underlying database", () => {
		const env = makeEnv();
		env.close();
		expect(() => env.db.query("SELECT 1").get()).toThrow();
	});
});

describe("emitted-content helpers", () => {
	function seedAssistant(
		env: ReturnType<typeof createHarnessEnvironment>,
		content: string,
		at: string,
	) {
		insertRow(
			env.db,
			"messages",
			{
				id: crypto.randomUUID(),
				thread_id: env.threadId,
				role: "assistant",
				content,
				model_id: null,
				tool_name: null,
				host_origin: env.hostName,
				created_at: at,
				modified_at: at,
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			env.siteId,
		);
	}

	it("counts assistant rows and returns the latest by created_at", () => {
		const env = makeEnv();
		try {
			expect(countAssistantMessages(env.db)).toBe(0);
			expect(latestAssistantText(env.db)).toBe("(empty)");

			seedAssistant(env, "first", "2026-01-01T00:00:00.000Z");
			seedAssistant(env, "second", "2026-01-01T00:00:01.000Z");

			expect(countAssistantMessages(env.db)).toBe(2);
			expect(latestAssistantText(env.db)).toBe("second");
		} finally {
			env.close();
		}
	});

	it("returns the latest turn metrics row or null when none exist", () => {
		const env = makeEnv();
		try {
			expect(latestTurnMetrics(env.db)).toBeNull();

			insertRow(
				env.db,
				"turns",
				{
					id: crypto.randomUUID(),
					thread_id: env.threadId,
					model_id: "stub",
					tokens_in: 10,
					tokens_out: 5,
					cost_usd: 0.5,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
				},
				env.siteId,
			);

			const m = latestTurnMetrics(env.db);
			expect(m?.cost_usd).toBe(0.5);
			expect(m?.tokens_in).toBe(10);
			expect(m?.tokens_out).toBe(5);
		} finally {
			env.close();
		}
	});
});

describe("silent observers", () => {
	it("silentLogger reports no level enabled and child returns itself", () => {
		const l = silentLogger();
		expect(l.isLevelEnabled("error")).toBe(false);
		expect(l.child({})).toBe(l);
		// methods are callable noops
		expect(() => l.info("x")).not.toThrow();
	});

	it("silentEventBus methods are callable noops", () => {
		const bus = silentEventBus();
		expect(() => bus.emit("file:changed", {} as never)).not.toThrow();
	});
});
