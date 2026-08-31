import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	InvalidDurableWorkRowError,
	acknowledgeDurableWork,
	acknowledgeDurableWorkTransfer,
	beginDurableWorkTransfer,
	claimDurableWorkByIds,
	claimLocalDurableWork,
	deadLetterExpiredDurableWork,
	insertDurableWork,
	pruneConsumedDurableWork,
	pruneExpiredDeadLetters,
	resetProcessingDurableWork,
} from "../durable-work";
import {
	countPendingIntakeDurableWork,
	findDurableWorkByKindAndIdempotencyKeys,
	listPendingIntakeDurableWork,
	listPendingIntakeDurableWorkForRef,
} from "../repositories/durable-work";
import { applySchema } from "../schema";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});
const row = (id: string, target = "local", expires_at: string | null = null) => ({
	id,
	target_site_id: target,
	kind: "client_tool",
	payload: "{}",
	idempotency_key: `key:${id}`,
	expires_at,
});

describe("durable_work", () => {
	it("rejects missing deterministic idempotency keys", () => {
		expect(() => insertDurableWork(db, { ...row("a"), idempotency_key: "" })).toThrow(
			InvalidDurableWorkRowError,
		);
	});
	it("claims locally under one generation and recovers orphaned processing on boot", () => {
		insertDurableWork(db, row("a"));
		const claim = claimLocalDurableWork(db, "local");
		expect(claim?.claim_state).toBe("processing");
		expect(claimLocalDurableWork(db, "local")).toBeNull();
		expect(resetProcessingDurableWork(db, "local")).toBe(1);
		expect(claimLocalDurableWork(db, "local")?.id).toBe("a");
	});
	it("receiver deduplication precedes sender transfer acknowledgement", () => {
		insertDurableWork(db, row("sender", "peer"));
		const token = beginDurableWorkTransfer(db, "sender");
		if (!token) throw new Error("expected transfer token");
		const receiver = new Database(":memory:");
		applySchema(receiver);
		expect(
			insertDurableWork(receiver, { ...row("receiver", "peer"), idempotency_key: "key:sender" }),
		).toBe(true);
		expect(
			insertDurableWork(receiver, {
				...row("receiver-duplicate", "peer"),
				idempotency_key: "key:sender",
			}),
		).toBe(false);
		expect(acknowledgeDurableWorkTransfer(db, "sender", token)).toBe(true);
		expect(db.query("SELECT id FROM durable_work WHERE id = 'sender'").get()).toBeNull();
		expect(claimLocalDurableWork(receiver, "peer")?.id).toBe("receiver");
		receiver.close();
	});
	it("requires the consumer claim token for acknowledgement", () => {
		insertDurableWork(db, row("a"));
		const claim = claimLocalDurableWork(db, "local");
		if (!claim?.claim_token) throw new Error("expected claim token");
		expect(acknowledgeDurableWork(db, "a", "wrong")).toBe(false);
		expect(acknowledgeDurableWork(db, "a", claim.claim_token)).toBe(true);
		expect(
			db.query("SELECT claim_state, consumed_at FROM durable_work WHERE id = 'a'").get(),
		).toEqual({
			claim_state: "consumed",
			consumed_at: expect.any(String),
		});
		expect(pruneConsumedDurableWork(db, "9999-01-01T00:00:00.000Z")).toBe(1);
	});
	it("expires into a retained dead letter then prunes after the seven-day TTL", () => {
		const expired = "2026-01-01T00:00:00.000Z";
		insertDurableWork(db, row("a", "local", expired));
		expect(deadLetterExpiredDurableWork(db, expired)).toBe(1);
		expect(
			db.query("SELECT claim_state, last_error FROM durable_work WHERE id = 'a'").get(),
		).toEqual({ claim_state: "dead_letter", last_error: "expired" });
		expect(pruneExpiredDeadLetters(db, "2026-01-07T00:00:00.000Z")).toBe(0);
		expect(pruneExpiredDeadLetters(db, "2026-01-08T00:00:00.001Z")).toBe(1);
	});
});

describe("durable_work upgrade", () => {
	it("rebuilds a 4A durable_work table, preserves rows, and permits consumed acknowledgements", () => {
		const legacy = new Database(":memory:");
		legacy.exec(`CREATE TABLE durable_work (
			id TEXT PRIMARY KEY, target_site_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'dead_letter')),
			claim_token TEXT, claimed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
			created_at TEXT NOT NULL, expires_at TEXT, dead_lettered_at TEXT
		) STRICT`);
		legacy.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, created_at)
			VALUES ('4a-row', 'local', 'client_tool', '{}', '4a-key', ?)`,
			[new Date().toISOString()],
		);

		applySchema(legacy);
		expect(legacy.query("PRAGMA table_info(durable_work)").all()).toContainEqual(
			expect.objectContaining({ name: "consumed_at" }),
		);
		const claim = claimLocalDurableWork(legacy, "local");
		expect(claim?.id).toBe("4a-row");
		expect(acknowledgeDurableWork(legacy, "4a-row", claim?.claim_token ?? "")).toBe(true);
		expect(legacy.query("SELECT id, claim_state FROM durable_work").get()).toEqual({
			id: "4a-row",
			claim_state: "consumed",
		});
		legacy.close();
	});

	it("adds nullable intake columns to a 4B durable_work table without losing rows", () => {
		const legacy = new Database(":memory:");
		legacy.exec(`CREATE TABLE durable_work (
			id TEXT PRIMARY KEY, target_site_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
			claim_token TEXT, claimed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
			created_at TEXT NOT NULL, expires_at TEXT, dead_lettered_at TEXT, consumed_at TEXT
		) STRICT`);
		legacy.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, created_at) VALUES ('4b-row', 'local', 'webhook_intake', '{}', '4b-key', ?)`,
			[new Date().toISOString()],
		);
		applySchema(legacy);
		expect(legacy.query("PRAGMA table_info(durable_work)").all()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "ref_id" }),
				expect.objectContaining({ name: "source_site" }),
				expect.objectContaining({ name: "received_at" }),
			]),
		);
		expect(
			legacy
				.query("SELECT id, ref_id, source_site, received_at FROM durable_work WHERE id = '4b-row'")
				.get(),
		).toEqual({ id: "4b-row", ref_id: null, source_site: null, received_at: null });
		legacy.close();
	});
});

// 4C-1 intake provenance and read helpers.

describe("durable_work intake reads", () => {
	it("round-trips nullable intake provenance through durable work", () => {
		insertDurableWork(db, {
			...row("intake"),
			ref_id: "thread-1",
			source_site: "site-a",
			received_at: "2026-01-01T00:00:00.000Z",
		});
		insertDurableWork(db, row("dispatch"));
		expect(
			db
				.query("SELECT ref_id, source_site, received_at FROM durable_work WHERE id = 'intake'")
				.get(),
		).toEqual({
			ref_id: "thread-1",
			source_site: "site-a",
			received_at: "2026-01-01T00:00:00.000Z",
		});
		expect(
			db
				.query("SELECT ref_id, source_site, received_at FROM durable_work WHERE id = 'dispatch'")
				.get(),
		).toEqual({ ref_id: null, source_site: null, received_at: null });
	});

	it("orders pending intake by received_at with created_at fallback", () => {
		insertDurableWork(db, {
			...row("late"),
			kind: "webhook_intake",
			ref_id: "thread-1",
			received_at: "2026-01-03T00:00:00.000Z",
		});
		insertDurableWork(db, { ...row("fallback"), kind: "rss_intake", ref_id: "thread-1" });
		db.run("UPDATE durable_work SET created_at = ? WHERE id = 'fallback'", [
			"2026-01-01T00:00:00.000Z",
		]);
		insertDurableWork(db, {
			...row("early"),
			kind: "webhook_intake",
			ref_id: "thread-1",
			received_at: "2026-01-02T00:00:00.000Z",
		});
		expect(
			listPendingIntakeDurableWork(db, "webhook_intake", "thread-1").map((entry) => entry.id),
		).toEqual(["early", "late"]);
		expect(listPendingIntakeDurableWorkForRef(db, "thread-1").map((entry) => entry.id)).toEqual([
			"fallback",
			"early",
			"late",
		]);
		expect(
			findDurableWorkByKindAndIdempotencyKeys(db, [
				["webhook_intake", "key:late"],
				["rss_intake", "missing"],
			]).map((entry) => entry.id),
		).toEqual(["late"]);
		expect(countPendingIntakeDurableWork(db, "thread-1")).toBe(3);
	});

	it("claims specific pending rows by id, fencing each with a fresh token", () => {
		insertDurableWork(db, { ...row("a"), kind: "webhook_intake", ref_id: "thread-1" });
		insertDurableWork(db, { ...row("b"), kind: "connector_intake", ref_id: "thread-1" });
		insertDurableWork(db, { ...row("c"), kind: "rss_intake", ref_id: "thread-1" });

		const claimed = claimDurableWorkByIds(db, ["a", "c"], "local");
		expect(claimed.map((entry) => entry.id).sort()).toEqual(["a", "c"]);
		for (const entry of claimed) {
			expect(entry.claim_state).toBe("processing");
			expect(entry.claim_token).toEqual(expect.any(String));
		}
		// A different fresh token per row keeps generations independent.
		expect(claimed[0].claim_token).not.toBe(claimed[1].claim_token);

		// The unclaimed row stays pending; the claimed rows can be acknowledged
		// only with their own token.
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'b'").get()).toEqual({
			claim_state: "pending",
		});
		const a = claimed.find((entry) => entry.id === "a");
		if (!a?.claim_token) throw new Error("expected claim token for a");
		expect(acknowledgeDurableWork(db, "a", "wrong")).toBe(false);
		expect(acknowledgeDurableWork(db, "a", a.claim_token)).toBe(true);
	});

	it("only claims rows still pending, skipping already-claimed or missing ids", () => {
		insertDurableWork(db, { ...row("a"), kind: "webhook_intake", ref_id: "thread-1" });
		insertDurableWork(db, { ...row("b"), kind: "webhook_intake", ref_id: "thread-1" });
		// Pre-claim b so it is no longer pending.
		claimDurableWorkByIds(db, ["b"], "local");

		const claimed = claimDurableWorkByIds(db, ["a", "b", "missing"], "local");
		expect(claimed.map((entry) => entry.id)).toEqual(["a"]);
	});

	it("returns an empty array for an empty id list", () => {
		expect(claimDurableWorkByIds(db, [], "local")).toEqual([]);
	});

	it("resetProcessingDurableWork returns claimed-by-ids rows to pending on boot", () => {
		insertDurableWork(db, { ...row("a"), kind: "webhook_intake", ref_id: "thread-1" });
		const claimed = claimDurableWorkByIds(db, ["a"], "local");
		expect(claimed[0].claim_state).toBe("processing");
		expect(resetProcessingDurableWork(db, "local")).toBe(1);
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'a'").get()).toEqual({
			claim_state: "pending",
		});
	});
});
