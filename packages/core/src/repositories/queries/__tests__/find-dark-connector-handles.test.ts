import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorHandleRow } from "@bound/shared";
import { applySchema, insertRow } from "../../../index";
import { findDarkConnectorHandles } from "../find-dark-connector-handles";

const SITE = "site-test";
const NOW = new Date("2026-07-02T12:00:00.000Z");
const STALE_BEFORE = new Date(NOW.getTime() - 15 * 60 * 1000).toISOString();

/** A handle modified well before the stale window (settled, not a replay race). */
const OLD = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
/** A handle modified inside the stale window (possibly mid-replay). */
const FRESH = new Date(NOW.getTime() - 60 * 1000).toISOString();

function seedHandle(db: Database, overrides: Partial<ConnectorHandleRow> & { id: string }): void {
	const row: ConnectorHandleRow = {
		id: overrides.id,
		server_name: overrides.server_name ?? "discord",
		event_name: overrides.event_name ?? "interaction.received",
		event_args: overrides.event_args ?? "{}",
		delivery_mode: overrides.delivery_mode ?? "push",
		cursor: overrides.cursor ?? null,
		task_id: overrides.task_id ?? null,
		created_at: overrides.created_at ?? OLD,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? OLD,
	};
	insertRow(db, "connector_handles", row, SITE);
}

function seedTask(
	db: Database,
	opts: { id: string; status: string; deleted?: 0 | 1; threadId?: string },
): void {
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
			thread_id: opts.threadId ?? `thread-${opts.id}`,
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

describe("findDarkConnectorHandles", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => db.close());

	it("flags a live handle whose task is cancelled", () => {
		seedHandle(db, { id: "h1", task_id: "t1" });
		seedTask(db, { id: "t1", status: "cancelled", threadId: "thread-x" });

		const dark = findDarkConnectorHandles(db, STALE_BEFORE);
		expect(dark).toHaveLength(1);
		expect(dark[0].handle_id).toBe("h1");
		expect(dark[0].reason).toBe("cancelled");
		expect(dark[0].thread_id).toBe("thread-x");
		expect(dark[0].event_name).toBe("interaction.received");
	});

	it("flags a live handle whose task was soft-deleted", () => {
		seedHandle(db, { id: "h2", task_id: "t2" });
		seedTask(db, { id: "t2", status: "pending", deleted: 1 });

		const dark = findDarkConnectorHandles(db, STALE_BEFORE);
		expect(dark).toHaveLength(1);
		expect(dark[0].reason).toBe("deleted");
	});

	it("flags a live handle whose task row is missing entirely", () => {
		seedHandle(db, { id: "h3", task_id: "gone" });

		const dark = findDarkConnectorHandles(db, STALE_BEFORE);
		expect(dark).toHaveLength(1);
		expect(dark[0].reason).toBe("missing");
		expect(dark[0].thread_id).toBeNull();
	});

	it("does NOT flag a healthy pending event task", () => {
		seedHandle(db, { id: "h4", task_id: "t4" });
		seedTask(db, { id: "t4", status: "pending" });

		expect(findDarkConnectorHandles(db, STALE_BEFORE)).toHaveLength(0);
	});

	it("does NOT flag a failed event task (scheduler healer reschedules it)", () => {
		seedHandle(db, { id: "h5", task_id: "t5" });
		seedTask(db, { id: "t5", status: "failed" });

		expect(findDarkConnectorHandles(db, STALE_BEFORE)).toHaveLength(0);
	});

	it("does NOT flag a soft-deleted handle (sanctioned teardown)", () => {
		seedHandle(db, { id: "h6", task_id: "t6", deleted: 1 });
		seedTask(db, { id: "t6", status: "cancelled" });

		expect(findDarkConnectorHandles(db, STALE_BEFORE)).toHaveLength(0);
	});

	it("does NOT flag a freshly-modified handle whose task is not yet visible (replay race guard)", () => {
		seedHandle(db, { id: "h7", task_id: "not-yet-synced", modified_at: FRESH });

		expect(findDarkConnectorHandles(db, STALE_BEFORE)).toHaveLength(0);
	});

	it("does NOT flag a handle with a null task_id", () => {
		seedHandle(db, { id: "h8", task_id: null });

		expect(findDarkConnectorHandles(db, STALE_BEFORE)).toHaveLength(0);
	});

	it("returns one row per distinct dark handle", () => {
		seedHandle(db, { id: "h9", task_id: "t9" });
		seedTask(db, { id: "t9", status: "cancelled" });
		seedHandle(db, { id: "h10", task_id: "gone10" });

		const dark = findDarkConnectorHandles(db, STALE_BEFORE);
		expect(dark.map((d) => d.handle_id).sort()).toEqual(["h10", "h9"]);
	});
});
