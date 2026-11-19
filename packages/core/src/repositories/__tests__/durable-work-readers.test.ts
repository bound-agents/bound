import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertDurableWork } from "../../durable-work";
import {
	findStalePendingIntakeDurableWork,
	getDurableWork,
	listDeadLetterDurableWork,
	listDurableWorkForInspection,
} from "../durable-work";

let db: Database;
beforeEach(() => {
	db = createCoreTestDb();
});

/** Insert a durable_work row with sensible defaults, then force state/timestamps the
 *  readers key off of (claim_state, created_at, received_at, claimed_at). */
function seed(opts: {
	id: string;
	kind?: string;
	target?: string;
	refId?: string | null;
	claimState?: string;
	createdAt?: string;
	receivedAt?: string | null;
	claimedAt?: string | null;
}): void {
	insertDurableWork(db, {
		id: opts.id,
		target_site_id: opts.target ?? "local",
		kind: opts.kind ?? "webhook_intake",
		payload: "{}",
		idempotency_key: `key:${opts.id}`,
		ref_id: opts.refId ?? null,
		received_at: opts.receivedAt ?? null,
		expires_at: null,
	});
	db.run(
		`UPDATE durable_work
		    SET claim_state = ?,
		        created_at = ?,
		        received_at = COALESCE(?, received_at),
		        claimed_at = ?
		  WHERE id = ?`,
		[
			opts.claimState ?? "pending",
			opts.createdAt ?? "2026-01-01T00:00:00.000Z",
			opts.receivedAt ?? null,
			opts.claimedAt ?? null,
			opts.id,
		],
	);
}

describe("getDurableWork", () => {
	it("returns the row by id", () => {
		seed({ id: "a" });
		const row = getDurableWork(db, "a");
		expect(row?.id).toBe("a");
		expect(row?.kind).toBe("webhook_intake");
	});

	it("returns null for an unknown id", () => {
		expect(getDurableWork(db, "nope")).toBeNull();
	});
});

describe("listDeadLetterDurableWork", () => {
	it("returns only dead_letter rows of the given kind, oldest first", () => {
		seed({ id: "live", kind: "connector_intake", claimState: "pending" });
		seed({
			id: "dead2",
			kind: "connector_intake",
			claimState: "dead_letter",
			createdAt: "2026-01-03T00:00:00.000Z",
		});
		seed({
			id: "dead1",
			kind: "connector_intake",
			claimState: "dead_letter",
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		// Different kind — excluded.
		seed({ id: "other", kind: "rss_intake", claimState: "dead_letter" });

		const rows = listDeadLetterDurableWork(db, "connector_intake");
		expect(rows.map((r) => r.id)).toEqual(["dead1", "dead2"]);
	});

	it("returns [] when no dead-letter rows of that kind exist", () => {
		seed({ id: "a", kind: "webhook_intake", claimState: "pending" });
		expect(listDeadLetterDurableWork(db, "webhook_intake")).toEqual([]);
	});
});

describe("listDurableWorkForInspection", () => {
	const STALE = "2026-06-01T00:00:00.000Z";

	it("includes every dead_letter row regardless of age", () => {
		seed({
			id: "dead-recent",
			claimState: "dead_letter",
			createdAt: "2026-12-31T00:00:00.000Z",
		});
		const rows = listDurableWorkForInspection(db, STALE);
		expect(rows.map((r) => r.id)).toContain("dead-recent");
	});

	it("includes pending/processing rows older than the stale cutoff but not fresh ones", () => {
		seed({ id: "old-pending", claimState: "pending", createdAt: "2026-05-01T00:00:00.000Z" });
		seed({ id: "old-processing", claimState: "processing", createdAt: "2026-05-01T00:00:00.000Z" });
		seed({ id: "fresh-pending", claimState: "pending", createdAt: "2026-12-01T00:00:00.000Z" });

		const ids = listDurableWorkForInspection(db, STALE).map((r) => r.id);
		expect(ids).toContain("old-pending");
		expect(ids).toContain("old-processing");
		expect(ids).not.toContain("fresh-pending");
	});

	it("includes transferring rows whose claimed_at is older than the cutoff", () => {
		seed({
			id: "stuck-transfer",
			target: "peer",
			claimState: "transferring",
			claimedAt: "2026-05-01T00:00:00.000Z",
		});
		seed({
			id: "fresh-transfer",
			target: "peer",
			claimState: "transferring",
			claimedAt: "2026-12-01T00:00:00.000Z",
		});

		const ids = listDurableWorkForInspection(db, STALE).map((r) => r.id);
		expect(ids).toContain("stuck-transfer");
		expect(ids).not.toContain("fresh-transfer");
	});

	it("projects an age_ms column computed from created_at", () => {
		seed({ id: "dead", claimState: "dead_letter", createdAt: "2026-01-01T00:00:00.000Z" });
		const [row] = listDurableWorkForInspection(db, STALE);
		expect(row.id).toBe("dead");
		expect(typeof row.age_ms).toBe("number");
		expect(row.age_ms).toBeGreaterThan(0);
	});

	it("orders results oldest-first by created_at", () => {
		seed({ id: "b", claimState: "dead_letter", createdAt: "2026-02-02T00:00:00.000Z" });
		seed({ id: "a", claimState: "dead_letter", createdAt: "2026-02-01T00:00:00.000Z" });
		expect(listDurableWorkForInspection(db, STALE).map((r) => r.id)).toEqual(["a", "b"]);
	});
});

describe("findStalePendingIntakeDurableWork", () => {
	const STALE = "2026-06-01T00:00:00.000Z";

	it("groups pending intake rows by ref_id and counts them", () => {
		seed({
			id: "r1-a",
			kind: "webhook_intake",
			refId: "thread-1",
			claimState: "pending",
			receivedAt: "2026-05-01T00:00:00.000Z",
		});
		seed({
			id: "r1-b",
			kind: "webhook_intake",
			refId: "thread-1",
			claimState: "pending",
			receivedAt: "2026-05-02T00:00:00.000Z",
		});
		seed({
			id: "r2",
			kind: "webhook_intake",
			refId: "thread-2",
			claimState: "pending",
			receivedAt: "2026-05-03T00:00:00.000Z",
		});

		const groups = findStalePendingIntakeDurableWork(db, "webhook_intake", STALE);
		const byRef = new Map(groups.map((g) => [g.ref_id, g]));
		expect(byRef.get("thread-1")?.count).toBe(2);
		expect(byRef.get("thread-1")?.oldest_received_at).toBe("2026-05-01T00:00:00.000Z");
		expect(byRef.get("thread-2")?.count).toBe(1);
	});

	it("excludes rows fresher than the cutoff", () => {
		seed({
			id: "fresh",
			kind: "webhook_intake",
			refId: "thread-1",
			claimState: "pending",
			receivedAt: "2026-12-01T00:00:00.000Z",
		});
		expect(findStalePendingIntakeDurableWork(db, "webhook_intake", STALE)).toEqual([]);
	});

	it("excludes non-pending rows and rows of other kinds", () => {
		seed({
			id: "processing",
			kind: "webhook_intake",
			refId: "thread-1",
			claimState: "processing",
			receivedAt: "2026-05-01T00:00:00.000Z",
		});
		seed({
			id: "other-kind",
			kind: "rss_intake",
			refId: "thread-1",
			claimState: "pending",
			receivedAt: "2026-05-01T00:00:00.000Z",
		});
		expect(findStalePendingIntakeDurableWork(db, "webhook_intake", STALE)).toEqual([]);
	});

	it("falls back to created_at when received_at is null (pre-provenance rows)", () => {
		seed({
			id: "no-received",
			kind: "webhook_intake",
			refId: "thread-9",
			claimState: "pending",
			receivedAt: null,
			createdAt: "2026-05-01T00:00:00.000Z",
		});
		const groups = findStalePendingIntakeDurableWork(db, "webhook_intake", STALE);
		expect(groups).toHaveLength(1);
		expect(groups[0].ref_id).toBe("thread-9");
		expect(groups[0].oldest_received_at).toBe("2026-05-01T00:00:00.000Z");
	});

	it("orders groups by their oldest received_at ascending", () => {
		seed({
			id: "late",
			kind: "webhook_intake",
			refId: "thread-late",
			claimState: "pending",
			receivedAt: "2026-05-20T00:00:00.000Z",
		});
		seed({
			id: "early",
			kind: "webhook_intake",
			refId: "thread-early",
			claimState: "pending",
			receivedAt: "2026-05-01T00:00:00.000Z",
		});
		const groups = findStalePendingIntakeDurableWork(db, "webhook_intake", STALE);
		expect(groups.map((g) => g.ref_id)).toEqual(["thread-early", "thread-late"]);
	});
});
