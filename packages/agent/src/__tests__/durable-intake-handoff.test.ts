// End-to-end producer→consumer handoff on the durable_work store (4C-3).
//
// A REAL producer write (the RSS poller's item-processing, driven by a live
// tick over a mock fetch, with BOUND_DURABLE_INTAKE ON) lands a durable_work
// row. The scheduler's consumer, buildEventWakeupContent, then folds that row
// into the wakeup content, claims it (pending -> processing), and the
// post-persist ack (acknowledgeDurableWork, exactly as scheduler.ts calls it)
// consumes it (-> consumed). A second fold returns nothing. This proves the
// producer and consumer meet on the new store without any hand-inserted row.

import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	acknowledgeDurableWork,
	applySchema,
	getDurableWork,
	insertRow,
	setDurableIntakeEnabledForTesting,
} from "@bound/core";
import { RssPoller } from "@bound/platforms";
import type { Task, TypedEventEmitter } from "@bound/shared";
import { buildEventWakeupContent } from "../event-payload";

const RSS_DOC = `<?xml version="1.0"?>
<rss version="2.0">
	<channel>
		<title>Handoff Feed</title>
		<item>
			<title>Handoff post</title>
			<link>https://example.com/handoff/1</link>
			<guid>handoff-guid-1</guid>
			<pubDate>Mon, 31 Aug 2026 12:00:00 GMT</pubDate>
			<description>Body of the handoff post</description>
		</item>
	</channel>
</rss>`;

const resolvePublicHost = async (): Promise<readonly string[]> => ["93.184.216.34"];

describe("durable intake producer→consumer handoff", () => {
	let db: Database.Database;
	let siteId: string;

	beforeEach(() => {
		setDurableIntakeEnabledForTesting(true);
		db = new Database(":memory:");
		applySchema(db);
		siteId = randomUUID();
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
	});

	afterEach(() => {
		db.close();
		setDurableIntakeEnabledForTesting(true);
	});

	function makeEventTask(threadId: string): Task {
		const now = new Date().toISOString();
		return {
			id: randomUUID(),
			type: "event",
			status: "claimed",
			trigger_spec: "rss:handoff-feed",
			payload: null,
			thread_id: threadId,
			origin_thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			system_prompt_addition: null,
			heartbeat_at: null,
			result: null,
			error: null,
			created_at: now,
			created_by: null,
			modified_at: now,
			deleted: 0,
		} as Task;
	}

	test("real RSS producer write folds, claims, and acks through the durable store", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const taskId = randomUUID();
		// Seed the feed's three-row consist. seen_guids is a non-null empty
		// cursor so the tick is NOT a first-poll seed and actually delivers.
		insertRow(
			db,
			"rss_feeds",
			{
				id: randomUUID(),
				name: "handoff-feed",
				url: "https://example.com/handoff.xml",
				description: null,
				poll_interval_seconds: 900,
				seen_guids: JSON.stringify([]),
				task_id: taskId,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		const emitted: Array<{ event: string; payload: unknown }> = [];
		const eventBus = {
			emit: (event: string, payload: unknown) => {
				emitted.push({ event, payload });
			},
		} as unknown as TypedEventEmitter;

		// ── PRODUCER: a real poller tick over a mock fetch. No hand-inserted row.
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			resolveHost: resolvePublicHost,
			fetchImpl: (async () => new Response(RSS_DOC, { status: 200 })) as unknown as typeof fetch,
		});
		await poller.tick();

		// The producer wrote exactly one durable_work row and emitted the wake.
		const produced = db
			.query("SELECT id, kind, idempotency_key, ref_id, claim_state, payload FROM durable_work")
			.all() as Array<{
			id: string;
			kind: string;
			idempotency_key: string;
			ref_id: string;
			claim_state: string;
			payload: string;
		}>;
		expect(produced.length).toBe(1);
		expect(produced[0].kind).toBe("rss_intake");
		expect(produced[0].idempotency_key).toBe("rss-handoff-feed-handoff-guid-1");
		expect(produced[0].ref_id).toBe(threadId);
		expect(produced[0].claim_state).toBe("pending");
		expect(db.query("SELECT COUNT(*) AS count FROM relay_inbox").get()).toEqual({ count: 0 });
		expect(emitted.some((e) => e.event === "connector:event")).toBe(true);

		// ── CONSUMER: the scheduler folds the produced row into the wakeup.
		const task = makeEventTask(threadId);
		const wakeup = buildEventWakeupContent(db, task, siteId);

		// The folded content carries the producer's payload body.
		expect(wakeup.content).toContain("Body of the handoff post");
		expect(wakeup.content).toContain("handoff-guid-1");
		// One durable claim, no legacy relay ids.
		expect(wakeup.durableClaims.map((c) => c.id)).toEqual([produced[0].id]);
		expect(wakeup.processedIds).toEqual([]);
		// The claim moved the row pending -> processing under a fresh token.
		const claimed = getDurableWork(db, produced[0].id);
		expect(claimed?.claim_state).toBe("processing");
		expect(claimed?.claim_token).toBe(wakeup.durableClaims[0].token);

		// ── POST-PERSIST ACK: exactly what scheduler.ts runs after the wakeup
		// messages persist. Consumes the row (processing -> consumed).
		for (const claim of wakeup.durableClaims) {
			expect(acknowledgeDurableWork(db, claim.id, claim.token)).toBe(true);
		}
		expect(getDurableWork(db, produced[0].id)?.claim_state).toBe("consumed");

		// ── SECOND FOLD: a consumed row no longer folds; nothing to hand off.
		const second = buildEventWakeupContent(db, task, siteId);
		expect(second.content).not.toContain("Body of the handoff post");
		expect(second.durableClaims).toEqual([]);
		expect(second.processedIds).toEqual([]);
		expect(second.content).toBe(task.payload ?? "Execute scheduled task.");
	});
});
