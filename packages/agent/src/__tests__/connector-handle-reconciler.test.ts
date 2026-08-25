import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import { applyAdvisory, getPendingAdvisories } from "../advisories";
import { reconcileDarkConnectorHandles } from "../connector-handle-reconciler";

const SITE = "site-a";
const NOW = new Date("2026-07-02T12:00:00.000Z");
const STALE_AFTER_MS = 15 * 60 * 1000;
const OLD = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const FRESH = new Date(NOW.getTime() - 60 * 1000).toISOString();

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function insertHandle(
	db: Database,
	opts: {
		id: string;
		taskId: string | null;
		serverName?: string;
		eventName?: string;
		deleted?: 0 | 1;
		modifiedAt?: string;
	},
): void {
	insertRow(
		db,
		"connector_handles",
		{
			id: opts.id,
			server_name: opts.serverName ?? "discord",
			event_name: opts.eventName ?? "interaction.received",
			event_args: "{}",
			delivery_mode: "push",
			cursor: null,
			task_id: opts.taskId,
			created_at: OLD,
			deleted: opts.deleted ?? 0,
			modified_at: opts.modifiedAt ?? OLD,
		},
		SITE,
	);
}

function insertTask(db: Database, opts: { id: string; status: string; deleted?: 0 | 1 }): void {
	insertRow(
		db,
		"tasks",
		{
			id: opts.id,
			type: "event",
			status: opts.status,
			trigger_spec: "connector:event:x",
			payload: "{}",
			created_at: OLD,
			created_by: SITE,
			thread_id: `thread-${opts.id}`,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 0,
			inject_mode: null,
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: OLD,
			deleted: opts.deleted ?? 0,
			origin_thread_id: null,
			system_prompt_addition: null,
		},
		SITE,
	);
}

describe("connector-handle reconciler — dark handle detection", () => {
	it("raises one advisory for a live handle whose task was cancelled", () => {
		const db = makeDb();
		insertHandle(db, { id: randomUUID(), taskId: "t1" });
		insertTask(db, { id: "t1", status: "cancelled" });

		const result = reconcileDarkConnectorHandles(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(1);
		const advisories = getPendingAdvisories(db);
		expect(advisories.length).toBe(1);
		expect(advisories[0].detail).toContain("cancelled");
		expect(advisories[0].evidence).toContain('"reason":"cancelled"');
	});

	it("does not re-raise after the advisory has been applied (churn fix)", () => {
		const db = makeDb();
		insertHandle(db, { id: "h-stable", taskId: "t2" });
		insertTask(db, { id: "t2", status: "cancelled" });

		const first = reconcileDarkConnectorHandles(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});
		expect(first.advisoriesRaised).toBe(1);

		const advisoryId = getPendingAdvisories(db)[0].id;
		applyAdvisory(db, advisoryId, SITE);

		const second = reconcileDarkConnectorHandles(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});
		expect(second.advisoriesRaised).toBe(0);
	});

	it("raises distinct advisories for distinct dark handles", () => {
		const db = makeDb();
		insertHandle(db, { id: "h-a", taskId: "ta", eventName: "interaction.received" });
		insertHandle(db, { id: "h-b", taskId: "tb", eventName: "message.received" });
		insertTask(db, { id: "ta", status: "cancelled" });
		// tb missing entirely

		const result = reconcileDarkConnectorHandles(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(2);
	});

	it("does not raise for a healthy pending task", () => {
		const db = makeDb();
		insertHandle(db, { id: "h-ok", taskId: "t-ok" });
		insertTask(db, { id: "t-ok", status: "pending" });

		expect(
			reconcileDarkConnectorHandles(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW })
				.advisoriesRaised,
		).toBe(0);
	});

	it("does not raise for a failed task (scheduler heals it)", () => {
		const db = makeDb();
		insertHandle(db, { id: "h-fail", taskId: "t-fail" });
		insertTask(db, { id: "t-fail", status: "failed" });

		expect(
			reconcileDarkConnectorHandles(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW })
				.advisoriesRaised,
		).toBe(0);
	});

	it("does not raise for a freshly-modified handle (replay race guard)", () => {
		const db = makeDb();
		insertHandle(db, { id: "h-fresh", taskId: "not-synced-yet", modifiedAt: FRESH });

		expect(
			reconcileDarkConnectorHandles(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW })
				.advisoriesRaised,
		).toBe(0);
	});
});
