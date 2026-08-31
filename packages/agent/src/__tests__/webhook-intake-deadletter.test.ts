import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertDurableWork, insertInbox, insertRow } from "@bound/core";
import { registerConnectorEventDelivery } from "@bound/platforms";
import { type RelayInboxEntry, TypedEventEmitter } from "@bound/shared";
import { applyAdvisory, getPendingAdvisories } from "../advisories";
import { Scheduler } from "../scheduler";
import { reconcileStaleWebhookIntake } from "../webhook-intake-reconciler";

const SITE = "site-a";
const NOW = new Date("2026-06-24T12:00:00.000Z");
const STALE_AFTER_MS = 15 * 60 * 1000; // 15 minutes

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function insertWebhook(
	db: Database,
	opts: { threadId: string; name: string; deleted?: 0 | 1 },
): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"webhooks",
		{
			id: randomUUID(),
			name: opts.name,
			secret: "shh",
			signature_format: "github",
			description: null,
			task_id: randomUUID(),
			thread_id: opts.threadId,
			created_at: now,
			deleted: opts.deleted ?? 0,
			modified_at: now,
		},
		SITE,
	);
}

function insertIntake(
	db: Database,
	opts: { id?: string; refId: string; receivedAt: string; kind?: string; processed?: boolean },
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

function unprocessedCount(db: Database, refId: string): number {
	const row = db
		.query(
			"SELECT COUNT(*) AS c FROM relay_inbox WHERE ref_id = ? AND kind = 'webhook_intake' AND processed = 0",
		)
		.get(refId) as { c: number };
	return row.c;
}

function advisoryCountWithTitle(db: Database, refId: string): number {
	const title = `Webhook intake not draining: handler thread ${refId} is dark`;
	const row = db
		.query("SELECT COUNT(*) AS c FROM advisories WHERE deleted = 0 AND title = ?")
		.get(title) as { c: number };
	return row.c;
}

describe("webhook intake reconciler — recoverable (live binding, dark handler)", () => {
	it("raises one advisory when a live webhook's handler is dark, without draining the intake", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-live", name: "bound" });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(1);
		expect(result.deadLettered).toBe(0);
		const advisories = getPendingAdvisories(db);
		expect(advisories.length).toBe(1);
		expect(advisories[0].detail).toContain("bound");
		// The advisory does NOT drain the queue — reviving the handler does.
		expect(unprocessedCount(db, "thread-live")).toBe(1);
	});

	it("does NOT re-raise after the advisory has been applied (the churn fix)", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-live", name: "bound" });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60) });

		const first = reconcileStaleWebhookIntake(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW });
		expect(first.advisoriesRaised).toBe(1);

		// Operator applies the advisory — it leaves the proposed set but the
		// underlying intake still can't drain (handler still dark).
		const advisoryId = getPendingAdvisories(db)[0].id;
		applyAdvisory(db, advisoryId, SITE);

		const second = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});
		expect(second.advisoriesRaised).toBe(0);
		expect(advisoryCountWithTitle(db, "thread-live")).toBe(1);
	});

	it("groups multiple stale rows for one live handler into a single advisory with the count", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-live", name: "bound" });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60) });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(40) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(1);
		expect(getPendingAdvisories(db)[0].evidence).toContain('"count":2');
	});

	it("raises distinct advisories for distinct live dark handlers", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-a", name: "alpha" });
		insertWebhook(db, { threadId: "thread-b", name: "beta" });
		insertIntake(db, { refId: "thread-a", receivedAt: minutesAgo(60) });
		insertIntake(db, { refId: "thread-b", receivedAt: minutesAgo(45) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(2);
		expect(result.deadLettered).toBe(0);
	});
});

it("re-emits stale live intake so the scheduler drains it, without creating an advisory", () => {
	const db = makeDb();
	insertWebhook(db, { threadId: "thread-live", name: "bound" });
	insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60) });
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const eventBus = {
		emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
	} as TypedEventEmitter;

	const result = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});

	expect(result.advisoriesRaised).toBe(0);
	expect(result.redelivered).toBe(1);
	expect(emitted).toEqual([
		{
			event: "connector:event",
			payload: {
				trigger_key: "webhook:bound",
				handle_id: expect.any(String),
				task_id: expect.any(String),
				batch_size: 1,
			},
		},
	]);
});

it("does not re-emit an already processed intake row", () => {
	const db = makeDb();
	insertWebhook(db, { threadId: "thread-live", name: "bound" });
	insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60), processed: true });
	const emitted: unknown[] = [];
	const eventBus = {
		emit: (_event: string, payload: unknown) => emitted.push(payload),
	} as TypedEventEmitter;

	const result = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	expect(result.redelivered).toBe(0);
	expect(emitted).toEqual([]);
});

it("routes repeated stale re-emissions through scheduler CAS into one durable wakeup", async () => {
	const db = makeDb();
	const threadId = randomUUID();
	const taskId = randomUUID();
	const webhookId = randomUUID();
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, 'event', 'pending', 'webhook:slow', NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, 'results', NULL, 0, 5, 0, 0, 0, NULL, NULL, NULL, ?, 'system', ?, 0)`,
		[taskId, threadId, now, now],
	);
	insertRow(
		db,
		"webhooks",
		{
			id: webhookId,
			name: "slow",
			secret: "shh",
			signature_format: "github",
			description: null,
			task_id: taskId,
			thread_id: threadId,
			created_at: now,
			deleted: 0,
			modified_at: now,
		},
		SITE,
	);
	const inboxId = randomUUID();
	insertIntake(db, { id: inboxId, refId: threadId, receivedAt: minutesAgo(60) });

	const eventBus = new TypedEventEmitter();
	let releaseRun: (() => void) | undefined;
	const runReleased = new Promise<void>((resolve) => {
		releaseRun = resolve;
	});
	let runs = 0;
	const scheduler = new Scheduler(
		{
			db,
			siteId: SITE,
			hostName: "test-host",
			eventBus,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: {
					backends: [
						{
							id: "mock",
							provider: "openai-compatible",
							model: "mock",
							base_url: "http://localhost",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 0,
							price_per_m_output: 0,
						},
					],
					default: "mock",
				},
			},
			optionalConfig: {},
		} as any,
		() =>
			({
				run: async () => {
					runs++;
					await runReleased;
					return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
				},
			}) as any,
	);
	registerConnectorEventDelivery(eventBus, scheduler);

	const first = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	const second = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	expect(first.redelivered).toBe(1);
	expect(second.redelivered).toBe(1);
	expect(
		(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status,
	).toBe("claimed");

	const { stop } = scheduler.start(5);
	try {
		await new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("slow event task did not begin")), 3000);
			const poll = () => {
				if (runs === 1) {
					clearTimeout(deadline);
					resolve();
				} else setTimeout(poll, 5);
			};
			poll();
		});
		const wakeups = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(threadId) as Array<{ content: string }>;
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].content).toContain("action");
		expect(
			(
				db.query("SELECT processed FROM relay_inbox WHERE id = ?").get(inboxId) as {
					processed: number;
				}
			).processed,
		).toBe(1);
		reconcileStaleWebhookIntake(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW, eventBus });
		expect(runs).toBe(1);
	} finally {
		releaseRun?.();
		stop();
	}
});

it("re-emits stale RSS intake with its feed trigger and binding identity", () => {
	const db = makeDb();
	const threadId = randomUUID();
	const taskId = randomUUID();
	const feedId = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"rss_feeds",
		{
			id: feedId,
			name: "vket",
			url: "https://example.test/feed.xml",
			description: null,
			poll_interval_seconds: 900,
			seen_guids: "[]",
			task_id: taskId,
			thread_id: threadId,
			created_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
	insertIntake(db, { refId: threadId, receivedAt: minutesAgo(60), kind: "rss_intake" });
	const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const eventBus = {
		emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
	} as TypedEventEmitter;

	const result = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	expect(result.redelivered).toBe(1);
	expect(emitted).toEqual([
		{
			event: "connector:event",
			payload: { trigger_key: "rss:vket", handle_id: feedId, task_id: taskId, batch_size: 1 },
		},
	]);
});

it("re-emits stale connector intake with its per-handle trigger and binding identity", () => {
	const db = makeDb();
	const threadId = randomUUID();
	const taskId = randomUUID();
	const handleId = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"connector_handles",
		{
			id: handleId,
			server_name: "discord",
			event_name: "interaction.received",
			event_args: "{}",
			delivery_mode: "push",
			cursor: null,
			task_id: taskId,
			created_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
	db.run(
		`INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, 'event', 'pending', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, 'results', NULL, 0, 5, 0, 0, 0, NULL, NULL, NULL, ?, 'system', ?, 0)`,
		[taskId, `connector:event:${handleId}`, threadId, now, now],
	);
	insertIntake(db, { refId: threadId, receivedAt: minutesAgo(60), kind: "connector_intake" });
	const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const eventBus = {
		emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
	} as TypedEventEmitter;

	const result = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});

	expect(result.redelivered).toBe(1);
	expect(emitted).toEqual([
		{
			event: "connector:event",
			payload: {
				trigger_key: `connector:event:${handleId}`,
				handle_id: handleId,
				task_id: taskId,
				batch_size: 1,
			},
		},
	]);

	db.run("UPDATE relay_inbox SET processed = 1 WHERE ref_id = ? AND kind = 'connector_intake'", [
		threadId,
	]);
	const afterProcessing = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	expect(afterProcessing.redelivered).toBe(0);
	expect(emitted).toHaveLength(1);
});

it("dead-letters stale connector intake when its live handle backs a cancelled task", () => {
	const db = makeDb();
	const threadId = randomUUID();
	const taskId = randomUUID();
	const handleId = randomUUID();
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, 'event', 'cancelled', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, 'results', NULL, 0, 5, 0, 0, 0, NULL, NULL, NULL, ?, 'system', ?, 0)`,
		[taskId, `connector:event:${handleId}`, threadId, now, now],
	);
	insertRow(
		db,
		"connector_handles",
		{
			id: handleId,
			server_name: "discord",
			event_name: "interaction.received",
			event_args: "{}",
			delivery_mode: "push",
			cursor: null,
			task_id: taskId,
			created_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
	insertIntake(db, { refId: threadId, receivedAt: minutesAgo(60), kind: "connector_intake" });
	const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const eventBus = {
		emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
	} as TypedEventEmitter;

	const first = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	const second = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});

	expect(first.deadLettered).toBe(1);
	expect(second.deadLettered).toBe(0);
	expect(first.redelivered).toBe(0);
	expect(second.redelivered).toBe(0);
	expect(emitted).toEqual([]);
	expect(
		(
			db
				.query("SELECT processed FROM relay_inbox WHERE ref_id = ? AND kind = 'connector_intake'")
				.get(threadId) as { processed: number }
		).processed,
	).toBe(1);
});

it("dead-letters stale connector intake when its live handle backs a soft-deleted task", () => {
	const db = makeDb();
	const threadId = randomUUID();
	const taskId = randomUUID();
	const handleId = randomUUID();
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, 'event', 'pending', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, 'results', NULL, 0, 5, 0, 0, 0, NULL, NULL, NULL, ?, 'system', ?, 1)`,
		[taskId, `connector:event:${handleId}`, threadId, now, now],
	);
	insertRow(
		db,
		"connector_handles",
		{
			id: handleId,
			server_name: "discord",
			event_name: "interaction.received",
			event_args: "{}",
			delivery_mode: "push",
			cursor: null,
			task_id: taskId,
			created_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
	insertIntake(db, { refId: threadId, receivedAt: minutesAgo(60), kind: "connector_intake" });
	const emitted: unknown[] = [];
	const eventBus = {
		emit: (_event: string, payload: unknown) => emitted.push(payload),
	} as TypedEventEmitter;

	const first = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});
	const second = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
		eventBus,
	});

	expect(first.deadLettered).toBe(1);
	expect(second.deadLettered).toBe(0);
	expect(first.redelivered).toBe(0);
	expect(second.redelivered).toBe(0);
	expect(emitted).toEqual([]);
	expect(
		(
			db
				.query("SELECT processed FROM relay_inbox WHERE ref_id = ? AND kind = 'connector_intake'")
				.get(threadId) as { processed: number }
		).processed,
	).toBe(1);
});

it("dead-letters stale connector intake after its handle is soft-deleted", () => {
	const db = makeDb();
	const threadId = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"connector_handles",
		{
			id: randomUUID(),
			server_name: "discord",
			event_name: "interaction.received",
			event_args: "{}",
			delivery_mode: "push",
			cursor: null,
			task_id: randomUUID(),
			created_at: now,
			modified_at: now,
			deleted: 1,
		},
		SITE,
	);
	insertIntake(db, { refId: threadId, receivedAt: minutesAgo(60), kind: "connector_intake" });

	const result = reconcileStaleWebhookIntake(db, SITE, {
		staleAfterMs: STALE_AFTER_MS,
		now: NOW,
	});

	expect(result.deadLettered).toBe(1);
	expect(getPendingAdvisories(db)).toEqual([]);
	expect(
		(
			db
				.query("SELECT processed FROM relay_inbox WHERE ref_id = ? AND kind = 'connector_intake'")
				.get(threadId) as { processed: number }
		).processed,
	).toBe(1);
});

describe("webhook intake reconciler — orphaned (no live binding)", () => {
	it("dead-letters intake whose webhook was deregistered, raising no advisory", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-gone", name: "bound-v2", deleted: 1 });
		insertIntake(db, { refId: "thread-gone", receivedAt: minutesAgo(60) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(result.deadLettered).toBe(1);
		expect(getPendingAdvisories(db).length).toBe(0);
		expect(unprocessedCount(db, "thread-gone")).toBe(0);
	});

	it("dead-letters intake with no webhook row at all", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-orphan", receivedAt: minutesAgo(60) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(result.deadLettered).toBe(1);
		expect(getPendingAdvisories(db).length).toBe(0);
		expect(unprocessedCount(db, "thread-orphan")).toBe(0);
	});

	it("dead-letters ALL unprocessed rows for an orphaned ref_id once it is surfaced, including sub-threshold ones", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-gone", name: "bound-v2", deleted: 1 });
		insertIntake(db, { refId: "thread-gone", receivedAt: minutesAgo(60) });
		insertIntake(db, { refId: "thread-gone", receivedAt: minutesAgo(1) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.deadLettered).toBe(2);
		expect(unprocessedCount(db, "thread-gone")).toBe(0);
	});

	it("is idempotent across sweeps — drained orphan does not re-trigger", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-gone", name: "bound-v2", deleted: 1 });
		insertIntake(db, { refId: "thread-gone", receivedAt: minutesAgo(60) });
		reconcileStaleWebhookIntake(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW });

		const second = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});
		expect(second.advisoriesRaised).toBe(0);
		expect(second.deadLettered).toBe(0);
	});
});

describe("webhook intake reconciler — non-triggers", () => {
	it("ignores fresh intake still within the threshold", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-live", name: "bound" });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(1) });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(result.deadLettered).toBe(0);
	});

	it("ignores already-processed intake even when old", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "thread-live", name: "bound" });
		insertIntake(db, { refId: "thread-live", receivedAt: minutesAgo(60), processed: true });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(result.deadLettered).toBe(0);
	});

	it("ignores non-webhook_intake relay kinds sharing a ref_id", () => {
		const db = makeDb();
		insertIntake(db, { refId: "thread-x", receivedAt: minutesAgo(60), kind: "intake" });

		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(result.advisoriesRaised).toBe(0);
		expect(result.deadLettered).toBe(0);
	});
});

function insertDurableIntake(
	db: Database,
	opts: { id: string; refId: string; receivedAt: string; kind?: string },
): void {
	insertDurableWork(db, {
		id: opts.id,
		target_site_id: SITE,
		kind: opts.kind ?? "webhook_intake",
		payload: JSON.stringify({ body: '{"action":"opened"}' }),
		idempotency_key: `durable:${opts.id}`,
		ref_id: opts.refId,
		source_site: "hub-site",
		received_at: opts.receivedAt,
	});
}

describe("webhook intake reconciler — durable work store", () => {
	it("re-emits a stale durable intake row for a live binding with the normal connector payload", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "durable-live", name: "bound" });
		insertDurableIntake(db, {
			id: "durable-live-row",
			refId: "durable-live",
			receivedAt: minutesAgo(60),
		});
		const binding = db
			.query("SELECT id, task_id FROM webhooks WHERE thread_id = ?")
			.get("durable-live") as { id: string; task_id: string };
		const emitted: Array<{ event: string; payload: unknown }> = [];
		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
			eventBus: {
				emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
			} as TypedEventEmitter,
		});

		expect(result).toEqual({ advisoriesRaised: 0, redelivered: 1, deadLettered: 0 });
		expect(emitted).toEqual([
			{
				event: "connector:event",
				payload: {
					trigger_key: "webhook:bound",
					handle_id: binding.id,
					task_id: binding.task_id,
					batch_size: 1,
				},
			},
		]);
	});

	it("dead-letters orphaned durable intake without an advisory and does not repeat it", () => {
		const db = makeDb();
		insertDurableIntake(db, {
			id: "durable-orphan-row",
			refId: "durable-orphan",
			receivedAt: minutesAgo(60),
		});
		const first = reconcileStaleWebhookIntake(db, SITE, { staleAfterMs: STALE_AFTER_MS, now: NOW });
		const second = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
		});

		expect(first).toEqual({ advisoriesRaised: 0, redelivered: 0, deadLettered: 1 });
		expect(second).toEqual({ advisoriesRaised: 0, redelivered: 0, deadLettered: 0 });
		expect(getPendingAdvisories(db)).toEqual([]);
		expect(
			db
				.query("SELECT claim_state, last_error FROM durable_work WHERE id = 'durable-orphan-row'")
				.get(),
		).toEqual({
			claim_state: "dead_letter",
			last_error: "orphaned webhook intake binding",
		});
	});

	it("coalesces stale relay and durable rows into one recovery nudge with a combined batch count", () => {
		const db = makeDb();
		insertWebhook(db, { threadId: "mixed-live", name: "bound" });
		insertIntake(db, { refId: "mixed-live", receivedAt: minutesAgo(60) });
		insertDurableIntake(db, {
			id: "mixed-durable-row",
			refId: "mixed-live",
			receivedAt: minutesAgo(45),
		});
		const emitted: Array<{ event: string; payload: { batch_size: number } }> = [];
		const result = reconcileStaleWebhookIntake(db, SITE, {
			staleAfterMs: STALE_AFTER_MS,
			now: NOW,
			eventBus: {
				emit: (event: string, payload: { batch_size: number }) => emitted.push({ event, payload }),
			} as TypedEventEmitter,
		});

		expect(result).toEqual({ advisoriesRaised: 0, redelivered: 1, deadLettered: 0 });
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ event: "connector:event", payload: { batch_size: 2 } });
	});
});
