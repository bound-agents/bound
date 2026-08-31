import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	InvalidDurableWorkRowError,
	acknowledgeDurableWork,
	acknowledgeDurableWorkTransfer,
	beginDurableWorkTransfer,
	claimLocalDurableWork,
	deadLetterExpiredDurableWork,
	insertDurableWork,
	pruneConsumedDurableWork,
	pruneExpiredDeadLetters,
	resetProcessingDurableWork,
} from "../durable-work";
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
});
