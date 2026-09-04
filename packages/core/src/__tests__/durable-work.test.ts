import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	InvalidDurableWorkRowError,
	TRANSFER_EXHAUSTED_RECLASSIFY_BUDGET,
	acknowledgeDurableWork,
	acknowledgeDurableWorkTransfer,
	beginDurableWorkTransfer,
	claimDurableWorkByIds,
	claimLocalDurableWork,
	deadLetterExpiredDurableWork,
	insertDurableWork,
	pruneConsumedDurableWork,
	pruneExpiredDeadLetters,
	purgeDurableWork,
	readPendingPeerTargetedDurableWork,
	readTransferringDurableWork,
	reclassifyTransferExhaustedDeadLetters,
	resetProcessingDurableWork,
	resetTransferringLocalDurableWork,
	sweepStaleTransferringDurableWork,
} from "../durable-work";
import {
	countPendingIntakeDurableWork,
	countPendingPeerTargetedDurableWork,
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
const rowState = (db: Database, id: string) =>
	db.query("SELECT * FROM durable_work WHERE id = ?").get(id) as {
		claim_state: string;
		claim_token: string | null;
		attempt_count: number;
	} | null;
// The relay attempt cap (DURABLE_RELAY_MAX_ATTEMPTS in @bound/agent) the sweep
// enforces sender-side; core is registry-agnostic so the caller supplies it.
const DEFAULT_ATTEMPT_CAP = 3;

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
	it("counts a transferring peer-targeted row as undrained", () => {
		insertDurableWork(db, row("transfer", "peer"));
		expect(beginDurableWorkTransfer(db, "transfer")).not.toBeNull();
		expect(countPendingPeerTargetedDurableWork(db, "local")).toBe(1);
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

	it("sweeps a transferring row whose transfer timeout lapsed back to pending, charging an attempt", () => {
		// A peer-targeted row began transferring but its SPOOL_TRANSFER_ACK never
		// returned. Staleness is keyed on the transfer clock (claimed_at + the
		// transfer timeout), NOT on expires_at (that is the terminal TTL owned by
		// deadLetterExpiredDurableWork). A dropped ack must be retried while the work
		// is still LIVE, long before its terminal deadline. Nothing else reclaims a
		// peer-targeted 'transferring' row (boot recovery preserves it), so this sweep
		// is the sole running-process recovery path: return it to 'pending' so the
		// drain re-sends it, charging one attempt so a poisoned row eventually caps.
		const farFuture = "2027-01-01T00:00:00.000Z";
		insertDurableWork(db, row("stuck", "peer", farFuture));
		const claimedAt = "2026-01-01T00:00:00.000Z";
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = ? WHERE id = 'stuck'",
			[claimedAt],
		);

		// Within the transfer timeout window (claimed_at + 30s) is a no-op: a
		// slow-but-live ack must not be raced.
		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-01-01T00:00:20.000Z"),
		).toBe(0);
		expect(rowState(db, "stuck")?.claim_state).toBe("transferring");

		// Past the transfer timeout: reclaimed to pending, token cleared, attempt charged.
		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-01-01T00:01:00.000Z"),
		).toBe(1);
		const reclaimed = rowState(db, "stuck");
		expect(reclaimed?.claim_state).toBe("pending");
		expect(reclaimed?.claim_token).toBeNull();
		expect(reclaimed?.attempt_count).toBe(1);
	});

	it("dead-letters a stale transferring row at the attempt cap instead of re-pending it", () => {
		// Objection 3: the runbook promise 'marches toward dead letter' must be true.
		// A row that has already been re-sent to its cap and still never acked is
		// poisoned; the sweep dead-letters it (with a transfer-exhaustion last_error)
		// rather than re-pending it a fourth time.
		const farFuture = "2027-01-01T00:00:00.000Z";
		insertDurableWork(db, row("poisoned", "peer", farFuture));
		const claimedAt = "2026-01-01T00:00:00.000Z";
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = ?, attempt_count = ? WHERE id = 'poisoned'",
			[claimedAt, DEFAULT_ATTEMPT_CAP],
		);

		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-01-01T00:01:00.000Z"),
		).toBe(1);
		const dead = db
			.query("SELECT claim_state, last_error FROM durable_work WHERE id = 'poisoned'")
			.get() as { claim_state: string; last_error: string | null };
		expect(dead.claim_state).toBe("dead_letter");
		expect(dead.last_error).toContain("transfer");
	});

	it("never requeues a transferring row already past its terminal expiry — dead-letter owns it", () => {
		// Objection 1: a row past terminal expires_at must NOT be requeued by the
		// transfer sweep; deadLetterExpiredDurableWork owns terminal expiry. The two
		// sweeps must not race over the same row.
		const pastTerminal = "2026-01-01T00:00:00.000Z";
		insertDurableWork(db, row("expired", "peer", pastTerminal));
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = ? WHERE id = 'expired'",
			["2025-12-31T00:00:00.000Z"],
		);

		// now is well past both the transfer timeout AND the terminal expiry, yet the
		// transfer sweep leaves the row untouched: it is not re-pended.
		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-06-01T00:00:00.000Z"),
		).toBe(0);
		expect(rowState(db, "expired")?.claim_state).toBe("transferring");
		// The terminal sweep is what dead-letters it.
		expect(deadLetterExpiredDurableWork(db, "2026-06-01T00:00:00.000Z")).toBe(1);
		expect(rowState(db, "expired")?.claim_state).toBe("dead_letter");
	});

	it("sweeps a transferring row with a null expires_at once its transfer timeout lapses", () => {
		// dispatch_message / task_fire carry no terminal TTL (ttlMs=null), but they
		// still transfer peer-to-peer and can wedge on a dropped ack. With staleness
		// keyed on claimed_at (not expires_at), a null terminal TTL no longer blocks
		// recovery — there is no terminal deadline to defer to, so the transfer clock
		// is the only clock. It is still gated by the transfer timeout, not by age.
		insertDurableWork(db, row("forever", "peer", null));
		db.run(
			"UPDATE durable_work SET claim_state = 'transferring', claim_token = 'tok', claimed_at = ? WHERE id = 'forever'",
			["2026-01-01T00:00:00.000Z"],
		);

		// Within the transfer window: untouched.
		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-01-01T00:00:10.000Z"),
		).toBe(0);
		expect(rowState(db, "forever")?.claim_state).toBe("transferring");
		// Past the transfer window: reclaimed.
		expect(
			sweepStaleTransferringDurableWork(db, DEFAULT_ATTEMPT_CAP, "2026-01-01T00:01:00.000Z"),
		).toBe(1);
		expect(rowState(db, "forever")?.claim_state).toBe("pending");
	});

	it("reclassifies exactly the recent transfer-exhausted dead letters targeted at the reconnected peer", () => {
		// #253 blocking objection: the 30s dead-socket detector bounds the phantom-
		// success window but cannot provably beat the sweep's 3-attempt dead-letter cap
		// under independent timer phases. A row that dead-lettered via that race is
		// recoverable on reconnect: reclassifyTransferExhaustedDeadLetters returns rows
		// that (a) dead-lettered with the transfer-exhaustion last_error, (b) target the
		// reconnected peer, and (c) dead-lettered inside a bounded recent window — back
		// to pending with attempt_count reset. It must touch NOTHING else.
		const TRANSFER_EXHAUSTED = "transfer retries exhausted (no SPOOL_TRANSFER_ACK)";
		const now = "2026-01-01T00:20:00.000Z";
		const recent = "2026-01-01T00:15:00.000Z"; // 5 min ago — inside the 15-min window
		const old = "2026-01-01T00:00:00.000Z"; // 20 min ago — outside the window
		const seed = (
			id: string,
			target: string,
			lastError: string,
			deadLetteredAt: string,
			attempt: number,
			reclassifyCount = 0,
		) => {
			insertDurableWork(db, row(id, target, "2027-01-01T00:00:00.000Z"));
			db.run(
				`UPDATE durable_work SET claim_state = 'dead_letter', claim_token = NULL, claimed_at = NULL,
				 last_error = ?, dead_lettered_at = ?, attempt_count = ?, reclassify_count = ? WHERE id = ?`,
				[lastError, deadLetteredAt, attempt, reclassifyCount, id],
			);
		};
		// (1) recent + peer-targeted + transfer-exhausted → reclassified.
		seed("recent-peer", "peerA", TRANSFER_EXHAUSTED, recent, 3);
		// (2) old (outside window) → untouched.
		seed("old-peer", "peerA", TRANSFER_EXHAUSTED, old, 3);
		// (3) recent + peerA but a DIFFERENT last_error (real terminal expiry) → untouched.
		seed("recent-expired", "peerA", "expired", recent, 3);
		// (4) recent + transfer-exhausted but a DIFFERENT target peer → untouched.
		seed("recent-otherpeer", "peerB", TRANSFER_EXHAUSTED, recent, 3);
		// (5) recent + peer-targeted + transfer-exhausted but already at the reclassify
		// budget → NOT reclassified (the per-row budget is exhausted; it stays a
		// dead_letter for operator workspool redrive).
		seed(
			"recent-peer-budget",
			"peerA",
			TRANSFER_EXHAUSTED,
			recent,
			3,
			TRANSFER_EXHAUSTED_RECLASSIFY_BUDGET,
		);

		const windowMs = 15 * 60 * 1000;
		expect(reclassifyTransferExhaustedDeadLetters(db, "peerA", windowMs, now)).toBe(1);

		const reclassified = rowState(db, "recent-peer");
		expect(reclassified?.claim_state).toBe("pending");
		expect(reclassified?.claim_token).toBeNull();
		expect(reclassified?.attempt_count).toBe(0);
		const full = db
			.query(
				"SELECT dead_lettered_at, last_error, claimed_at FROM durable_work WHERE id = 'recent-peer'",
			)
			.get() as {
			dead_lettered_at: string | null;
			last_error: string | null;
			claimed_at: string | null;
		};
		expect(full.dead_lettered_at).toBeNull();
		expect(full.last_error).toBeNull();
		expect(full.claimed_at).toBeNull();

		// The three ineligible rows stay dead-lettered.
		expect(rowState(db, "old-peer")?.claim_state).toBe("dead_letter");
		expect(rowState(db, "recent-expired")?.claim_state).toBe("dead_letter");
		expect(rowState(db, "recent-otherpeer")?.claim_state).toBe("dead_letter");
		expect(rowState(db, "recent-peer-budget")?.claim_state).toBe("dead_letter");

		// Idempotent: a second run finds nothing eligible.
		expect(reclassifyTransferExhaustedDeadLetters(db, "peerA", windowMs, now)).toBe(0);
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

describe("durable_work LOCAL_WORK_TARGET sentinel", () => {
	it("peer-transfer selectors exclude local-targeted rows", () => {
		insertDurableWork(db, { ...row("local-row", "local") });
		insertDurableWork(db, { ...row("peer-row", "peer-site") });

		const pending = readPendingPeerTargetedDurableWork(db, "own-site");
		expect(pending.map((r) => r.id)).toEqual(["peer-row"]);

		// Even asked for explicitly, the sentinel never reads as peer-targeted.
		expect(readPendingPeerTargetedDurableWork(db, "own-site", "local")).toEqual([]);

		beginDurableWorkTransfer(db, "local-row");
		beginDurableWorkTransfer(db, "peer-row");
		expect(readTransferringDurableWork(db).map((r) => r.id)).toEqual(["peer-row"]);
		expect(readTransferringDurableWork(db, "local")).toEqual([]);
	});

	it("local-targeted rows do not count toward the hub-switch drain gate", () => {
		insertDurableWork(db, { ...row("local-row", "local") });
		insertDurableWork(db, { ...row("peer-row", "peer-site") });
		expect(countPendingPeerTargetedDurableWork(db, "own-site")).toBe(1);
	});

	it("resetTransferringLocalDurableWork recovers hijacked local rows to pending on boot", () => {
		insertDurableWork(db, { ...row("hijacked", "local") });
		insertDurableWork(db, { ...row("real-transfer", "peer-site") });
		beginDurableWorkTransfer(db, "hijacked");
		beginDurableWorkTransfer(db, "real-transfer");

		expect(resetTransferringLocalDurableWork(db)).toBe(1);

		// The hijacked wakeup is claimable again; the genuine peer transfer keeps
		// its retained token so the sender resumes it on reconnect.
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'hijacked'").get()).toEqual({
			claim_state: "pending",
		});
		expect(
			db.query("SELECT claim_state FROM durable_work WHERE id = 'real-transfer'").get(),
		).toEqual({ claim_state: "transferring" });
	});
});

describe("durable_work purge — dead-letter age filtering under --all-unclaimed", () => {
	const HOUR_MS = 3_600_000;
	// Backdate created_at so age-based purge predicates have something to bite on.
	const backdate = (id: string, ageMs: number) =>
		db.run("UPDATE durable_work SET created_at = ? WHERE id = ?", [
			new Date(Date.now() - ageMs).toISOString(),
			id,
		]);
	const deadLetter = (id: string) =>
		db.run("UPDATE durable_work SET claim_state = 'dead_letter' WHERE id = ?", [id]);

	it("age-filters peer dead letters under --all-unclaimed --older-than (the old one purges, the young one survives)", () => {
		// A 3h-old and a 10-min-old dead letter, both peer-targeted. Under
		// { mode: all-unclaimed, olderThanMs: 1h }, only the old one should purge —
		// the supplied age must narrow dead letters, not pass every one through.
		insertDurableWork(db, row("old-dead", "peer-site"));
		insertDurableWork(db, row("young-dead", "peer-site"));
		backdate("old-dead", 3 * HOUR_MS);
		backdate("young-dead", 10 * 60_000);
		deadLetter("old-dead");
		deadLetter("young-dead");

		const purged = purgeDurableWork(db, { mode: "all-unclaimed", olderThanMs: HOUR_MS });

		expect(purged).toBe(1);
		expect(rowState(db, "old-dead")).toBeNull();
		expect(rowState(db, "young-dead")?.claim_state).toBe("dead_letter");
	});
});
