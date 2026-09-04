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

function insert(
	db: Database,
	id: string,
	state: "dead_letter" | "pending" = "dead_letter",
	target = "local",
) {
	insertDurableWork(db, {
		id,
		target_site_id: target,
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

	it("purges dead-letter rows of a kind", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "dl-1");
		insert(db, "dl-2");
		// A peer-targeted dead letter — the actual backlog this command exists to clear.
		// It must be purged too; the sentinel target restriction (OBJECTION 1) is gone.
		insert(db, "dl-peer", "dead_letter", "peer");
		insert(db, "live", "pending");
		const result = await createWorkspoolCommand().handler(
			{ action: "purge", kind: "client_tool", "dead-lettered": "true" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("3");
		// Dead letters gone (local AND peer), the live pending row untouched.
		expect(
			(db.query("SELECT id FROM durable_work ORDER BY id").all() as Array<{ id: string }>).map(
				(r) => r.id,
			),
		).toEqual(["live"]);
	});

	it("refuses to purge pending rows younger than the 1h floor without --force", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "fresh", "pending");
		// A peer-targeted fresh pending row (spool-transfer queue) is protected by the same floor.
		insert(db, "fresh-peer", "pending", "peer");
		const result = await createWorkspoolCommand().handler(
			{ action: "purge", kind: "client_tool", "all-unclaimed": "true" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("0");
		// Both fresh pending rows survived the floor.
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 2 });
	});

	it("purges a peer-targeted dead letter under --all-unclaimed (target sentinel is not a boundary)", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// The real 7.2k backlog is peer-targeted dead letters (result/inference/platform_request).
		insert(db, "dl-peer", "dead_letter", "peer");
		const result = await createWorkspoolCommand().handler(
			{ action: "purge", kind: "client_tool", "all-unclaimed": "true" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("1");
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 0 });
	});

	it("treats the pending floor as a hard gate: --older-than cannot narrow below it without --force", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// A pending row aged 30min — inside the 1h floor.
		insert(db, "young-pending", "pending");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'young-pending'", [
			new Date(Date.now() - 30 * 60 * 1000).toISOString(),
		]);
		// A peer-targeted pending row of the same age — the spool-transfer queue. It is
		// doubly protected: by the floor AND (OBJECTION 1) by the peer-pending exclusion.
		insert(db, "young-peer", "pending", "peer");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'young-peer'", [
			new Date(Date.now() - 30 * 60 * 1000).toISOString(),
		]);
		// --older-than 0 must NOT drop the floor: without --force the row survives.
		const survived = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true", "older-than": "0" },
			context(db),
		);
		expect(survived.exitCode).toBe(0);
		expect(survived.stdout).toContain("0");
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 2 });
		// With --force, --older-than 0 applies as given and the row is deleted.
		const forced = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true", "older-than": "0", force: "true" },
			context(db),
		);
		expect(forced.exitCode).toBe(0);
		expect(forced.stdout).toContain("2");
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 0 });
	});

	it("purges unclaimed rows older than the floor and never touches claimed or transferring rows", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// An old pending row (past the default 1h floor).
		insert(db, "old-pending", "pending");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'old-pending'", [
			new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
		]);
		// A processing (claimed) row of the same age must be left alone.
		insert(db, "claimed", "pending");
		db.run(
			"UPDATE durable_work SET claim_state = 'processing', claim_token = 'tok', created_at = ? WHERE id = 'claimed'",
			[new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()],
		);
		// A transferring row must be left alone.
		insertDurableWork(db, {
			id: "transferring",
			target_site_id: "peer",
			kind: "client_tool",
			payload: "{}",
			idempotency_key: "transferring",
		});
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', created_at = ? WHERE id = 'transferring'",
			[new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()],
		);

		const result = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(
			(db.query("SELECT id FROM durable_work ORDER BY id").all() as Array<{ id: string }>).map(
				(r) => r.id,
			),
		).toEqual(["claimed", "transferring"]);
	});

	it("purges fresh pending rows when --force is set", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		insert(db, "fresh", "pending");
		// A peer-targeted fresh pending row: --force makes it eligible too (OBJECTION 1).
		insert(db, "fresh-peer", "pending", "peer");
		const result = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true", force: "true" },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("2");
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 0 });
	});

	it("excludes peer-targeted pending rows from --all-unclaimed without --force, includes them with --force (OBJECTION 1)", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// An hour-and-a-half-old peer-targeted pending row: past the 1h floor, but it is the
		// durable spool-transfer queue. The MSI outage proved peer pending can be healthy for
		// DAYS and deliver on reconnect, so --all-unclaimed alone must NOT destroy it.
		insert(db, "peer-pending", "pending", "peer");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'peer-pending'", [
			new Date(Date.now() - 90 * 60 * 1000).toISOString(),
		]);
		// A local-targeted pending row of the same age IS eligible — a stale local wakeup.
		insert(db, "local-pending", "pending", "local");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'local-pending'", [
			new Date(Date.now() - 90 * 60 * 1000).toISOString(),
		]);
		const survived = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true" },
			context(db),
		);
		expect(survived.exitCode).toBe(0);
		expect(survived.stdout).toContain("1");
		// The local wakeup was purged; the peer spool-transfer row survived.
		expect(
			(db.query("SELECT id FROM durable_work ORDER BY id").all() as Array<{ id: string }>).map(
				(r) => r.id,
			),
		).toEqual(["peer-pending"]);
		// With --force, the peer pending row becomes eligible too.
		const forced = await createWorkspoolCommand().handler(
			{ action: "purge", "all-unclaimed": "true", force: "true" },
			context(db),
		);
		expect(forced.exitCode).toBe(0);
		expect(forced.stdout).toContain("1");
		expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 0 });
	});

	it("never purges processing/transferring/consumed rows of either target under either selector, even with --force", async () => {
		for (const selector of [
			{ "dead-lettered": "true" },
			{ "all-unclaimed": "true" },
			{ "all-unclaimed": "true", force: "true" },
		] as const) {
			const db = new Database(":memory:");
			applySchema(db);
			// The six protected combinations: {processing, transferring, consumed} × {local, peer}.
			const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
			for (const [state, target] of [
				["processing", "local"],
				["processing", "peer"],
				["transferring", "local"],
				["transferring", "peer"],
				["consumed", "local"],
				["consumed", "peer"],
			] as const) {
				const id = `${state}-${target}`;
				insert(db, id, "pending", target);
				db.run(
					"UPDATE durable_work SET claim_state = ?, claim_token = 'tok', created_at = ? WHERE id = ?",
					[state, old, id],
				);
			}
			const result = await createWorkspoolCommand().handler(
				{ action: "purge", ...selector },
				context(db),
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("0");
			expect(db.query("SELECT COUNT(*) AS c FROM durable_work").get()).toEqual({ c: 6 });
		}
	});

	it("applies --older-than to dead letters of every target without floor interference", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		// Old and young dead letters, both peer-targeted; --older-than sits between their ages.
		insert(db, "old-dl", "dead_letter", "peer");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'old-dl'", [
			new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
		]);
		insert(db, "young-dl", "dead_letter", "peer");
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'young-dl'", [
			new Date(Date.now() - 10 * 60 * 1000).toISOString(),
		]);
		// --dead-lettered --older-than 1h: dead letters carry no floor, so the age filter
		// applies cleanly to both targets and only the old one is purged.
		const result = await createWorkspoolCommand().handler(
			{ action: "purge", "dead-lettered": "true", "older-than": String(60 * 60 * 1000) },
			context(db),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("1");
		expect(
			(db.query("SELECT id FROM durable_work ORDER BY id").all() as Array<{ id: string }>).map(
				(r) => r.id,
			),
		).toEqual(["young-dl"]);
	});

	it("requires a purge selector", async () => {
		const db = new Database(":memory:");
		applySchema(db);
		const result = await createWorkspoolCommand().handler({ action: "purge" }, context(db));
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("--dead-lettered");
	});
});
