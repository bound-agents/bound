import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	acknowledgeDurableWork,
	applySchema,
	claimLocalDurableWork,
	insertDurableWork,
	listPendingIntakeDurableWorkForRef,
} from "@bound/core";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import { createWorkspoolCommand } from "../workspool-command";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as Logger;
const eventBus = { on() {}, off() {}, emit() {} } as unknown as TypedEventEmitter;

function context(db: Database) {
	return { db, siteId: "local", logger, eventBus };
}

function insert(db: Database, id: string, state: "dead_letter" | "pending" = "dead_letter") {
	insertDurableWork(db, {
		id,
		target_site_id: "local",
		kind: "client_tool",
		payload: JSON.stringify({ message: "x".repeat(600) }),
		idempotency_key: `key:${id}`,
	});
	if (state === "dead_letter") {
		db.run(
			"UPDATE durable_work SET claim_state = 'dead_letter', dead_lettered_at = ?, last_error = 'failed' WHERE id = ?",
			["2026-01-01T00:00:00.000Z", id],
		);
	}
}

describe("workspool command", () => {
	it("lists dead letters without mutating them and bounds payload previews", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "dead");
		const result = await createWorkspoolCommand().handler({ action: "list" }, context(db));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("dead");
		expect(result.stdout).toContain("payload_preview");
		expect(result.stdout).toContain("…");
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'dead'").get()).toEqual({
			claim_state: "dead_letter",
		});
	});

	it("redrives a selected dead letter with a fresh registry TTL and preserves attempts", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "dead");
		db.run("UPDATE durable_work SET attempt_count = 3 WHERE id = 'dead'");
		const result = await createWorkspoolCommand().handler(
			{ action: "redrive", id: "dead" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("redriven");
		const row = db
			.query("SELECT claim_state, attempt_count, expires_at FROM durable_work WHERE id = 'dead'")
			.get() as {
			claim_state: string;
			attempt_count: number;
			expires_at: string;
		};
		expect(row.claim_state).toBe("pending");
		expect(row.attempt_count).toBe(3);
		expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
	});

	it("makes an already consumed redrive a no-op rather than delivering it twice", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "consumed", "pending");
		const claim = claimLocalDurableWork(db, "local");
		if (!claim?.claim_token) throw new Error("expected claim");
		expect(acknowledgeDurableWork(db, claim.id, claim.claim_token)).toBe(true);
		const result = await createWorkspoolCommand().handler(
			{ action: "redrive", id: "consumed" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("not found or already consumed");
		expect(claimLocalDurableWork(db, "local")).toBeNull();
	});
	it("redrives durable intake into the scheduler's pending fold order", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insertDurableWork(db, {
			id: "intake-later",
			target_site_id: "local",
			kind: "webhook_intake",
			payload: "{}",
			idempotency_key: "intake-later",
			ref_id: "thread-intake",
			source_site: "hub",
			received_at: "2026-01-03T00:00:00.000Z",
		});
		insertDurableWork(db, {
			id: "intake-dead",
			target_site_id: "local",
			kind: "webhook_intake",
			payload: "{}",
			idempotency_key: "intake-dead",
			ref_id: "thread-intake",
			source_site: "hub",
			received_at: "2026-01-02T00:00:00.000Z",
		});
		db.run(
			"UPDATE durable_work SET claim_state = 'dead_letter', dead_lettered_at = ? WHERE id = 'intake-dead'",
			["2026-01-04T00:00:00.000Z"],
		);

		const result = await createWorkspoolCommand().handler(
			{ action: "redrive", id: "intake-dead" },
			context(db),
		);

		expect(result.exitCode).toBe(0);
		expect(listPendingIntakeDurableWorkForRef(db, "thread-intake").map((row) => row.id)).toEqual([
			"intake-dead",
			"intake-later",
		]);
	});

	it("lists a stale transferring row so the operator sees a wedged spool transfer", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// A peer-targeted row that has been transferring past the stale threshold
		// (the #253 incident). Staleness is keyed on claimed_at age, not expires_at.
		insertDurableWork(db, {
			id: "wedged",
			target_site_id: "peer",
			kind: "platform_request",
			payload: "{}",
			idempotency_key: "wedged",
			expires_at: "2027-01-01T00:00:00.000Z",
		});
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = '2020-01-01T00:00:00.000Z' WHERE id = 'wedged'",
		);

		const result = await createWorkspoolCommand().handler({ action: "list" }, context(db));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("wedged");
		expect(result.stdout).toContain("transferring");
		// Listing never mutates.
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'wedged'").get()).toEqual({
			claim_state: "transferring",
		});
	});

	it("redrives a stale transferring row back to pending, charging an attempt", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insertDurableWork(db, {
			id: "wedged",
			target_site_id: "peer",
			kind: "platform_request",
			payload: "{}",
			idempotency_key: "wedged",
			expires_at: "2027-01-01T00:00:00.000Z",
		});
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = '2020-01-01T00:00:00.000Z' WHERE id = 'wedged'",
		);

		const result = await createWorkspoolCommand().handler(
			{ action: "redrive", id: "wedged" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("redriven");
		const row = db
			.query("SELECT claim_state, claim_token, attempt_count FROM durable_work WHERE id = 'wedged'")
			.get() as { claim_state: string; claim_token: string | null; attempt_count: number };
		expect(row.claim_state).toBe("pending");
		expect(row.claim_token).toBeNull();
		expect(row.attempt_count).toBe(1);
	});
});
