import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorHandleRow } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findConnectorHandleById,
	findConnectorHandleServerNameByTaskId,
	listActiveConnectorHandles,
	listConnectorHandlesByServer,
} from "../connector-handles";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedHandle(db: Database, overrides: Partial<ConnectorHandleRow> & { id: string }): void {
	const row: ConnectorHandleRow = {
		id: overrides.id,
		server_name: overrides.server_name ?? "discord",
		event_name: overrides.event_name ?? "message",
		event_args: overrides.event_args ?? "{}",
		delivery_mode: overrides.delivery_mode ?? "push",
		cursor: overrides.cursor ?? null,
		task_id: overrides.task_id ?? null,
		created_at: overrides.created_at ?? TS,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? TS,
	};
	insertRow(db, "connector_handles", row, SITE_ID);
}

describe("connector-handles repository", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("findConnectorHandleById", () => {
		it("returns the row for a live id", () => {
			seedHandle(db, {
				id: "h1",
				server_name: "discord",
				event_name: "message_create",
				event_args: '{"channel":"123"}',
				delivery_mode: "push",
				cursor: "cur-9",
				task_id: "task-1",
			});

			const found = findConnectorHandleById(db, "h1");
			expect(found).not.toBeNull();
			expect(found?.id).toBe("h1");
			expect(found?.server_name).toBe("discord");
			expect(found?.event_name).toBe("message_create");
			expect(found?.event_args).toBe('{"channel":"123"}');
			expect(found?.delivery_mode).toBe("push");
			expect(found?.cursor).toBe("cur-9");
			expect(found?.task_id).toBe("task-1");
			expect(found?.deleted).toBe(0);
		});

		it("returns null for an absent id", () => {
			seedHandle(db, { id: "h1" });
			expect(findConnectorHandleById(db, "nope")).toBeNull();
		});

		it("omits soft-deleted rows (deleted = 0 filter)", () => {
			seedHandle(db, { id: "live" });
			seedHandle(db, { id: "dead" });
			softDelete(db, "connector_handles", "dead", SITE_ID);

			expect(findConnectorHandleById(db, "live")?.id).toBe("live");
			// The tombstoned row is invisible to this finder.
			expect(findConnectorHandleById(db, "dead")).toBeNull();
		});
	});

	describe("listConnectorHandlesByServer", () => {
		it("returns only live handles for the named server", () => {
			seedHandle(db, { id: "d1", server_name: "discord" });
			seedHandle(db, { id: "d2", server_name: "discord" });
			seedHandle(db, { id: "s1", server_name: "slack" });

			const discord = listConnectorHandlesByServer(db, "discord");
			expect(discord.map((r) => r.id).sort()).toEqual(["d1", "d2"]);

			const slack = listConnectorHandlesByServer(db, "slack");
			expect(slack.map((r) => r.id)).toEqual(["s1"]);
		});

		it("excludes soft-deleted rows and returns [] when none match", () => {
			seedHandle(db, { id: "d1", server_name: "discord" });
			seedHandle(db, { id: "d2", server_name: "discord" });
			softDelete(db, "connector_handles", "d2", SITE_ID);

			expect(listConnectorHandlesByServer(db, "discord").map((r) => r.id)).toEqual(["d1"]);
			expect(listConnectorHandlesByServer(db, "unknown")).toEqual([]);
		});
	});

	describe("listActiveConnectorHandles", () => {
		it("returns all live handles across servers", () => {
			seedHandle(db, { id: "a", server_name: "discord" });
			seedHandle(db, { id: "b", server_name: "slack" });
			seedHandle(db, { id: "c", server_name: "github" });

			const active = listActiveConnectorHandles(db);
			expect(active.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
		});

		it("excludes soft-deleted rows; returns [] when table empty", () => {
			expect(listActiveConnectorHandles(db)).toEqual([]);

			seedHandle(db, { id: "a" });
			seedHandle(db, { id: "b" });
			softDelete(db, "connector_handles", "a", SITE_ID);

			expect(listActiveConnectorHandles(db).map((r) => r.id)).toEqual(["b"]);
		});
	});

	describe("findConnectorHandleServerNameByTaskId", () => {
		it("returns the server_name projection for a live handle bound to the task", () => {
			seedHandle(db, { id: "h1", server_name: "discord", task_id: "task-42" });

			const found = findConnectorHandleServerNameByTaskId(db, "task-42");
			expect(found).not.toBeNull();
			expect(found?.server_name).toBe("discord");
			// Projection finder: it selects only server_name, not the whole row.
			expect(Object.keys(found ?? {})).toEqual(["server_name"]);
		});

		it("returns null when no handle is bound to the task id", () => {
			seedHandle(db, { id: "h1", task_id: "task-42" });
			expect(findConnectorHandleServerNameByTaskId(db, "task-99")).toBeNull();
		});

		it("returns null once the bound handle is soft-deleted (deleted = 0 filter)", () => {
			seedHandle(db, { id: "h1", server_name: "slack", task_id: "task-7" });
			expect(findConnectorHandleServerNameByTaskId(db, "task-7")?.server_name).toBe("slack");

			softDelete(db, "connector_handles", "h1", SITE_ID);
			expect(findConnectorHandleServerNameByTaskId(db, "task-7")).toBeNull();
		});

		it("ignores a soft-deleted handle and finds a live sibling with the same task_id", () => {
			// A task could be re-bound to a new handle row; the live one must win.
			seedHandle(db, { id: "old", server_name: "discord", task_id: "task-5" });
			seedHandle(db, { id: "new", server_name: "slack", task_id: "task-5" });
			softDelete(db, "connector_handles", "old", SITE_ID);

			expect(findConnectorHandleServerNameByTaskId(db, "task-5")?.server_name).toBe("slack");
		});
	});
});
