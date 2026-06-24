import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertInbox } from "@bound/core";
import type { RelayInboxEntry } from "@bound/shared";
import { getPendingAdvisories } from "../advisories";
import { reconcileStaleWebhookIntake } from "../webhook-intake-reconciler";

const SITE = "site-a";
const NOW = new Date("2026-06-24T12:00:00.000Z");
const STALE_AFTER_MS = 15 * 60 * 1000; // 15 minutes

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function insertIntake(
	db: Database,
	opts: {
		id?: string;
		refId: string;
		receivedAt: string;
		kind?: string;
		processed?: boolean;
	},
): void {
	const id = opts.id ?? randomUUID();
	const entry: RelayInboxEntry = {
		id,
		source_site_id: "hub-site",
		kind: (opts.kind ?? "webhook_intake") as RelayInboxEntry["kind"],
		ref_id: opts.refId,
		idempotency_key: id,
		stream_id: null,
		payload: JSON.stringify({ body: '{"action":"opened"}' }),
		expires_at: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		received_at: opts.receivedAt,
		processed: 0,
		trace_context: null,
	};
	insertInbox(db, entry);
	if (opts.processed) {
		db.run("UPDATE relay_inbox SET processed = 1 WHERE id = ?", [id]);
	}
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

describe("webhook intake dead-letter reconciler", () => {
	it("raises an advisory for unprocessed webhook_intake older than the stale threshold", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(60) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(1);
		const advisories = getPendingAdvisories(db);
		expect(advisories.length).toBe(1);
		expect(advisories[0].title).toContain("thread-x");
		expect(advisories[0].type).toBe("general");
	});

	it("ignores fresh intake still within the threshold", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-y", receivedAt: minutesAgo(1) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(getPendingAdvisories(db).length).toBe(0);
	});

	it("ignores already-processed intake even when old", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-z", receivedAt: minutesAgo(60), processed: true });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(getPendingAdvisories(db).length).toBe(0);
	});

	it("ignores non-webhook_intake relay kinds sharing a ref_id", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-w", receivedAt: minutesAgo(60), kind: "intake" });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(getPendingAdvisories(db).length).toBe(0);
	});

	it("does not duplicate an advisory across repeated sweeps for the same ref_id", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(60) });
		reconcileStaleWebhookIntake(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW });

		// A second event lands for the same dark handler; still unprocessed.
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(30) });
		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(getPendingAdvisories(db).length).toBe(1);
	});

	it("groups multiple stale rows for one ref_id into a single advisory carrying the count", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(60) });
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(40) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(1);
		const advisories = getPendingAdvisories(db);
		expect(advisories.length).toBe(1);
		expect(advisories[0].evidence).toContain('"count":2');
		// oldest row drives the age reported in the evidence
		expect(advisories[0].evidence).toContain(minutesAgo(60));
	});

	it("raises distinct advisories for distinct dark handlers", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(60) });
		insertIntake(db, { refId: "thread-q", receivedAt: minutesAgo(45) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(2);
		expect(getPendingAdvisories(db).length).toBe(2);
	});
});
