import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Webhook } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../index";
import {
	findWebhookByName,
	findWebhookDeletedFlagById,
	findWebhookIdAndTaskIdByName,
	findWebhookIdById,
	findWebhookIdByName,
	findWebhookIdsById,
	findWebhookIdsByName,
	findWebhookNameById,
	findWebhookTaskIdById,
} from "../webhooks";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
	return {
		id: "wh-1",
		name: "deploy",
		secret: "shhh",
		signature_format: "github",
		description: null,
		task_id: "task-1",
		thread_id: "thread-1",
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
}

describe("webhooks repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("findWebhookByName", () => {
		it("returns the full live row by name", () => {
			insertRow(
				db,
				"webhooks",
				makeWebhook({
					id: "wh-a",
					name: "ci-hook",
					secret: "topsecret",
					signature_format: "stripe",
					description: "CI trigger",
					task_id: "task-ci",
					thread_id: "thread-ci",
				}),
				SITE_ID,
			);

			const row = findWebhookByName(db, "ci-hook");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("wh-a");
			expect(row?.name).toBe("ci-hook");
			expect(row?.secret).toBe("topsecret");
			expect(row?.signature_format).toBe("stripe");
			expect(row?.description).toBe("CI trigger");
			expect(row?.task_id).toBe("task-ci");
			expect(row?.thread_id).toBe("thread-ci");
			expect(row?.created_at).toBe(TS);
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an absent name", () => {
			expect(findWebhookByName(db, "nope")).toBeNull();
		});

		it("does NOT return a soft-deleted row (deleted=0 filter)", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-del", name: "gone" }), SITE_ID);
			softDelete(db, "webhooks", "wh-del", SITE_ID);
			expect(findWebhookByName(db, "gone")).toBeNull();
		});
	});

	describe("findWebhookIdByName", () => {
		it("returns the id for a live row", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-b", name: "by-name-id" }), SITE_ID);
			expect(findWebhookIdByName(db, "by-name-id")).toEqual({ id: "wh-b" });
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdAndTaskIdByName", () => {
		it("returns id and task_id for a live row", () => {
			insertRow(
				db,
				"webhooks",
				makeWebhook({ id: "wh-c", name: "id-task", task_id: "task-xyz" }),
				SITE_ID,
			);
			expect(findWebhookIdAndTaskIdByName(db, "id-task")).toEqual({
				id: "wh-c",
				task_id: "task-xyz",
			});
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdAndTaskIdByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdsByName", () => {
		it("returns id, task_id, thread_id for a live row", () => {
			insertRow(
				db,
				"webhooks",
				makeWebhook({
					id: "wh-d",
					name: "all-ids",
					task_id: "task-d",
					thread_id: "thread-d",
				}),
				SITE_ID,
			);
			expect(findWebhookIdsByName(db, "all-ids")).toEqual({
				id: "wh-d",
				task_id: "task-d",
				thread_id: "thread-d",
			});
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdsByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdsById", () => {
		it("returns id, task_id, thread_id for a live row", () => {
			insertRow(
				db,
				"webhooks",
				makeWebhook({
					id: "wh-e",
					name: "ids-by-id",
					task_id: "task-e",
					thread_id: "thread-e",
				}),
				SITE_ID,
			);
			expect(findWebhookIdsById(db, "wh-e")).toEqual({
				id: "wh-e",
				task_id: "task-e",
				thread_id: "thread-e",
			});
		});

		it("returns null for an absent id", () => {
			expect(findWebhookIdsById(db, "no-such-id")).toBeNull();
		});
	});

	describe("findWebhookIdById", () => {
		it("returns the id for a live row", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-f", name: "id-by-id" }), SITE_ID);
			expect(findWebhookIdById(db, "wh-f")).toEqual({ id: "wh-f" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookIdById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookNameById", () => {
		it("returns the name for a live row", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-g", name: "named" }), SITE_ID);
			expect(findWebhookNameById(db, "wh-g")).toEqual({ name: "named" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookNameById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookTaskIdById", () => {
		it("returns the task_id for a live row", () => {
			insertRow(
				db,
				"webhooks",
				makeWebhook({ id: "wh-h", name: "task-by-id", task_id: "task-h" }),
				SITE_ID,
			);
			expect(findWebhookTaskIdById(db, "wh-h")).toEqual({ task_id: "task-h" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookTaskIdById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookDeletedFlagById (deleted-filter OMISSION)", () => {
		it("returns the tombstoned row's deleted flag while deleted=0 siblings do not", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-tomb", name: "tomb" }), SITE_ID);
			softDelete(db, "webhooks", "wh-tomb", SITE_ID);

			// The omission finder sees the soft-deleted row.
			expect(findWebhookDeletedFlagById(db, "wh-tomb")).toEqual({ deleted: 1 });

			// Its deleted=0 siblings do NOT.
			expect(findWebhookIdById(db, "wh-tomb")).toBeNull();
			expect(findWebhookNameById(db, "wh-tomb")).toBeNull();
			expect(findWebhookByName(db, "tomb")).toBeNull();
		});

		it("returns deleted=0 for a live row", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-live", name: "live" }), SITE_ID);
			expect(findWebhookDeletedFlagById(db, "wh-live")).toEqual({ deleted: 0 });
		});

		it("returns null for an absent id (row never existed)", () => {
			expect(findWebhookDeletedFlagById(db, "never")).toBeNull();
		});

		it("reflects an updated deleted flag after restore via updateRow", () => {
			insertRow(db, "webhooks", makeWebhook({ id: "wh-restore", name: "restore" }), SITE_ID);
			softDelete(db, "webhooks", "wh-restore", SITE_ID);
			expect(findWebhookDeletedFlagById(db, "wh-restore")).toEqual({ deleted: 1 });

			updateRow(db, "webhooks", "wh-restore", { deleted: 0 }, SITE_ID);
			expect(findWebhookDeletedFlagById(db, "wh-restore")).toEqual({ deleted: 0 });
			// And now the deleted=0 siblings see it again.
			expect(findWebhookByName(db, "restore")?.id).toBe("wh-restore");
		});
	});
});
