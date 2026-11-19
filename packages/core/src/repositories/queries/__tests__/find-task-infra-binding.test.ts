import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorHandleRow, Webhook } from "@bound/shared";
import { createCoreTestDb } from "../../../__tests__/test-database";
import { insertRow, softDelete } from "../../../index";
import { findTaskInfraBinding } from "../find-task-infra-binding";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedWebhook(
	db: Database,
	overrides: Partial<Webhook> & { id: string; name: string },
): void {
	const base: Webhook = {
		id: overrides.id,
		name: overrides.name,
		secret: "shhh",
		signature_format: "github",
		description: null,
		task_id: overrides.task_id ?? null,
		thread_id: overrides.thread_id ?? "thread-default",
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
	insertRow(db, "webhooks", base, SITE_ID);
}

function seedHandle(db: Database, overrides: Partial<ConnectorHandleRow> & { id: string }): void {
	const row: ConnectorHandleRow = {
		id: overrides.id,
		server_name: overrides.server_name ?? "discord",
		event_name: overrides.event_name ?? "message",
		event_args: overrides.event_args ?? "{}",
		delivery_mode: overrides.delivery_mode ?? "push",
		cursor: overrides.cursor ?? null,
		task_id: overrides.task_id ?? null,
		created_at: TS,
		deleted: overrides.deleted ?? 0,
		modified_at: TS,
	};
	insertRow(db, "connector_handles", row, SITE_ID);
}

describe("findTaskInfraBinding", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	it("returns null when no binding references the task", () => {
		expect(findTaskInfraBinding(db, "task-x")).toBeNull();
	});

	it("returns a webhook binding with the webhook name as label", () => {
		seedWebhook(db, { id: "wh-1", name: "deploy-hook", task_id: "task-1" });
		expect(findTaskInfraBinding(db, "task-1")).toEqual({
			kind: "webhook",
			label: "deploy-hook",
		});
	});

	it("returns a connector binding labelled server:event when no webhook matches", () => {
		seedHandle(db, {
			id: "h-1",
			server_name: "discord",
			event_name: "message_create",
			task_id: "task-2",
		});
		expect(findTaskInfraBinding(db, "task-2")).toEqual({
			kind: "connector",
			label: "discord:message_create",
		});
	});

	it("prefers the webhook binding when both a webhook and a connector reference the task", () => {
		seedWebhook(db, { id: "wh-both", name: "priority", task_id: "task-3" });
		seedHandle(db, { id: "h-both", task_id: "task-3" });
		expect(findTaskInfraBinding(db, "task-3")).toEqual({
			kind: "webhook",
			label: "priority",
		});
	});

	it("ignores a soft-deleted webhook binding (deleted=0 filter) and falls through", () => {
		seedWebhook(db, { id: "wh-dead", name: "gone", task_id: "task-4" });
		softDelete(db, "webhooks", "wh-dead", SITE_ID);
		// no live binding remains
		expect(findTaskInfraBinding(db, "task-4")).toBeNull();
	});

	it("ignores a soft-deleted connector binding (deleted=0 filter)", () => {
		seedHandle(db, { id: "h-dead", task_id: "task-5" });
		softDelete(db, "connector_handles", "h-dead", SITE_ID);
		expect(findTaskInfraBinding(db, "task-5")).toBeNull();
	});

	it("falls through to the connector when the webhook for the task is soft-deleted", () => {
		seedWebhook(db, { id: "wh-dead2", name: "gone2", task_id: "task-6" });
		softDelete(db, "webhooks", "wh-dead2", SITE_ID);
		seedHandle(db, { id: "h-live", server_name: "slack", event_name: "msg", task_id: "task-6" });
		expect(findTaskInfraBinding(db, "task-6")).toEqual({
			kind: "connector",
			label: "slack:msg",
		});
	});
});
