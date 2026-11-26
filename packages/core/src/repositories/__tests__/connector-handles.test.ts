import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorHandleRow } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	findActiveConnectorHandleByThreadId,
	findConnectorHandleById,
	findConnectorHandleForSyncNotification,
	findConnectorHandleIncludingDeleted,
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
		db = createCoreTestDb({ metrics: true });
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

	describe("findConnectorHandleIncludingDeleted", () => {
		it("returns a live row", () => {
			seedHandle(db, { id: "h1" });
			expect(findConnectorHandleIncludingDeleted(db, "h1")?.id).toBe("h1");
		});

		it("returns a soft-deleted tombstone (no deleted filter) so creators can resurrect it", () => {
			seedHandle(db, { id: "h1" });
			softDelete(db, "connector_handles", "h1", SITE_ID);
			const row = findConnectorHandleIncludingDeleted(db, "h1");
			expect(row?.id).toBe("h1");
			expect(row?.deleted).toBe(1);
		});

		it("returns null for an id that never existed", () => {
			expect(findConnectorHandleIncludingDeleted(db, "ghost")).toBeNull();
		});
	});

	describe("findActiveConnectorHandleByThreadId", () => {
		function seedTask(
			taskId: string,
			threadId: string,
			opts: { deleted?: number; status?: string } = {},
		): void {
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: opts.status ?? "active",
					trigger_spec: "{}",
					thread_id: threadId,
					created_at: TS,
					deleted: opts.deleted ?? 0,
					modified_at: TS,
				},
				SITE_ID,
			);
		}

		it("resolves the handle whose event task owns the thread, projecting a server:event name", () => {
			seedTask("task-1", "thread-1");
			seedHandle(db, {
				id: "h1",
				server_name: "discord",
				event_name: "message",
				task_id: "task-1",
			});

			const found = findActiveConnectorHandleByThreadId(db, "thread-1");
			expect(found).toEqual({ id: "h1", name: "discord:message", task_id: "task-1" });
		});

		it("returns null when no handle's task owns the thread", () => {
			seedTask("task-1", "thread-1");
			seedHandle(db, { id: "h1", task_id: "task-1" });
			expect(findActiveConnectorHandleByThreadId(db, "other-thread")).toBeNull();
		});

		it("ignores a soft-deleted handle", () => {
			seedTask("task-1", "thread-1");
			seedHandle(db, { id: "h1", task_id: "task-1" });
			softDelete(db, "connector_handles", "h1", SITE_ID);
			expect(findActiveConnectorHandleByThreadId(db, "thread-1")).toBeNull();
		});

		it("ignores a soft-deleted task binding", () => {
			seedTask("task-1", "thread-1", { deleted: 1 });
			seedHandle(db, { id: "h1", task_id: "task-1" });
			expect(findActiveConnectorHandleByThreadId(db, "thread-1")).toBeNull();
		});

		it("ignores a cancelled task binding", () => {
			seedTask("task-1", "thread-1", { status: "cancelled" });
			seedHandle(db, { id: "h1", task_id: "task-1" });
			expect(findActiveConnectorHandleByThreadId(db, "thread-1")).toBeNull();
		});
	});

	describe("findConnectorHandleForSyncNotification", () => {
		it("returns id/server_name/deleted for a live handle", () => {
			seedHandle(db, { id: "h1", server_name: "discord" });
			expect(findConnectorHandleForSyncNotification(db, "h1")).toEqual({
				id: "h1",
				server_name: "discord",
				deleted: 0,
			});
		});

		it("includes tombstones so callers can suppress activation of deleted handles", () => {
			seedHandle(db, { id: "h1", server_name: "slack" });
			softDelete(db, "connector_handles", "h1", SITE_ID);
			expect(findConnectorHandleForSyncNotification(db, "h1")).toEqual({
				id: "h1",
				server_name: "slack",
				deleted: 1,
			});
		});

		it("returns null for an unknown id", () => {
			expect(findConnectorHandleForSyncNotification(db, "ghost")).toBeNull();
		});
	});
});
