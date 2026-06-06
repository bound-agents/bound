import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { connectorHandleId } from "../connector-handle-id.js";
import {
	createConnectorHandle,
	deleteConnectorHandle,
	getAllActiveConnectorHandles,
	getConnectorHandle,
	getConnectorHandlesByServer,
	linkConnectorHandleTask,
	updateConnectorHandleCursor,
} from "../connector-handle.js";

describe("connector-handle CRUD", () => {
	let db: Database;
	const siteId = "test-site-001";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates a handle with deterministic ID", () => {
		const id = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "123" },
			deliveryMode: "push",
			taskId: null,
		});

		const expected = connectorHandleId("discord", "message.received", { channel_id: "123" });
		expect(id).toBe(expected);

		const row = getConnectorHandle(db, id);
		expect(row).not.toBeNull();
		if (!row) throw new Error("row should not be null");
		expect(row.server_name).toBe("discord");
		expect(row.event_name).toBe("message.received");
		expect(row.delivery_mode).toBe("push");
		expect(row.deleted).toBe(0);
	});

	it("produces same ID regardless of event_args key order", () => {
		const id1 = connectorHandleId("discord", "message.received", { a: 1, b: 2 });
		const id2 = connectorHandleId("discord", "message.received", { b: 2, a: 1 });
		expect(id1).toBe(id2);
	});

	it("updates cursor", () => {
		const id = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "456" },
			deliveryMode: "push",
			taskId: null,
		});

		updateConnectorHandleCursor(db, siteId, id, "cursor-abc");
		const row = getConnectorHandle(db, id);
		if (!row) throw new Error("row should not be null");
		expect(row.cursor).toBe("cursor-abc");
	});

	it("links task to handle", () => {
		const id = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "789" },
			deliveryMode: "poll",
			taskId: null,
		});

		linkConnectorHandleTask(db, siteId, id, "task-001");
		const row = getConnectorHandle(db, id);
		if (!row) throw new Error("row should not be null");
		expect(row.task_id).toBe("task-001");
	});

	it("soft-deletes a handle", () => {
		const id = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "999" },
			deliveryMode: "push",
			taskId: null,
		});

		deleteConnectorHandle(db, siteId, id);
		const row = getConnectorHandle(db, id);
		expect(row).toBeNull(); // hidden by deleted=0 filter
	});

	it("lists handles by server", () => {
		createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "aaa" },
			deliveryMode: "push",
			taskId: null,
		});
		createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "interaction.received",
			eventArgs: { channel_id: "bbb" },
			deliveryMode: "push",
			taskId: null,
		});
		createConnectorHandle(db, siteId, {
			serverName: "slack",
			eventName: "message.received",
			eventArgs: { channel_id: "ccc" },
			deliveryMode: "poll",
			taskId: null,
		});

		const discordHandles = getConnectorHandlesByServer(db, "discord");
		expect(discordHandles.length).toBe(2);

		const slackHandles = getConnectorHandlesByServer(db, "slack");
		expect(slackHandles.length).toBe(1);
	});

	it("lists all active handles", () => {
		createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "111" },
			deliveryMode: "push",
			taskId: null,
		});
		const deletedId = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "222" },
			deliveryMode: "push",
			taskId: null,
		});
		deleteConnectorHandle(db, siteId, deletedId);

		const all = getAllActiveConnectorHandles(db);
		expect(all.length).toBe(1);
	});

	it("generates changelog entries (outbox pattern)", () => {
		createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "message.received",
			eventArgs: { channel_id: "changelog-test" },
			deliveryMode: "push",
			taskId: null,
		});

		const entries = db
			.query("SELECT * FROM change_log WHERE table_name = 'connector_handles'")
			.all();
		expect(entries.length).toBeGreaterThan(0);
	});
});
