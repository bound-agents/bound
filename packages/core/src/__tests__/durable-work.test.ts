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
