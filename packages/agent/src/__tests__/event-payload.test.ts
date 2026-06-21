import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertInbox } from "@bound/core";
import type { Task } from "@bound/shared";
import { buildEventWakeupContent } from "../event-payload";

/**
 * Reproduces the bug observed on 2026-05-18: webhook fires for thread
 * d0372be6 → task wakes up with developer="[Task wakeup] Scheduled event
 * task X triggered." and tool_result body="Execute scheduled task." —
 * the relay_inbox envelope written by webhook-handler.ts never reaches
 * the agent context.
 */
describe("buildEventWakeupContent", () => {
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		siteId = randomUUID();
	});

	function makeTask(overrides: Partial<Task> = {}): Task {
		const id = overrides.id ?? randomUUID();
		const now = new Date().toISOString();
		return {
			id,
			type: "event",
			status: "claimed",
			trigger_spec: "webhook:bound",
			payload: null,
			thread_id: randomUUID(),
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
			...overrides,
		} as Task;
	}

	function insertEnvelope(
		threadId: string,
		body: string,
		receivedAt: string,
		kind: "webhook_intake" | "intake" = "webhook_intake",
	): string {
		const id = randomUUID();
		insertInbox(db, {
			id,
			source_site_id: siteId,
			kind,
			ref_id: threadId,
			idempotency_key: randomUUID(),
			stream_id: null,
			payload: body,
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
			received_at: receivedAt,
			processed: 0,
		});
		return id;
	}

	test("returns default fallback when task has no thread_id", () => {
		const task = makeTask({ thread_id: null });
		const result = buildEventWakeupContent(db, task);
		expect(result.content).toBe("Execute scheduled task.");
		expect(result.processedIds).toEqual([]);
	});

	test("returns task.payload when task has no inbox entries", () => {
		const task = makeTask({ payload: "Standing instruction" });
		const result = buildEventWakeupContent(db, task);
		expect(result.content).toBe("Standing instruction");
		expect(result.processedIds).toEqual([]);
	});

	test("returns default fallback when task has no payload and no inbox entries", () => {
		const task = makeTask({ payload: null });
		const result = buildEventWakeupContent(db, task);
		expect(result.content).toBe("Execute scheduled task.");
		expect(result.processedIds).toEqual([]);
	});

	test("includes single envelope content when one is queued", () => {
		const threadId = randomUUID();
		const envelopeJson = JSON.stringify({
			method: "POST",
			path: "/webhook/bound",
			headers: { "x-github-event": "issues", "x-github-delivery": "abc-123" },
			content_type: "application/json",
			body: '{"action":"opened","issue":{"number":42}}',
		});
		const inboxId = insertEnvelope(threadId, envelopeJson, "2026-05-18T21:02:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		// The agent must see the trigger spec + delivery info + body. Body
		// is a JSON string nested inside the envelope JSON, so its quotes
		// are escaped — assert on substrings that don't straddle a quote.
		expect(result.content).toContain("webhook:bound");
		expect(result.content).toContain("x-github-event");
		expect(result.content).toContain("issues");
		expect(result.content).toContain("action");
		expect(result.content).toContain("opened");
		expect(result.content).toContain("number");
		expect(result.content).toContain("42");
		expect(result.processedIds).toEqual([inboxId]);
	});

	test("orders multiple envelopes by received_at (oldest first)", () => {
		const threadId = randomUUID();
		const id1 = insertEnvelope(threadId, "envelope-A", "2026-05-18T21:00:00Z");
		const id2 = insertEnvelope(threadId, "envelope-B", "2026-05-18T21:01:00Z");
		const id3 = insertEnvelope(threadId, "envelope-C", "2026-05-18T21:02:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("envelope-A");
		expect(result.content).toContain("envelope-B");
		expect(result.content).toContain("envelope-C");
		expect(result.content.indexOf("envelope-A")).toBeLessThan(result.content.indexOf("envelope-B"));
		expect(result.content.indexOf("envelope-B")).toBeLessThan(result.content.indexOf("envelope-C"));
		expect(result.processedIds).toEqual([id1, id2, id3]);
	});

	test("ignores already-processed entries", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "stale-envelope", "2026-05-18T20:00:00Z");
		db.run("UPDATE relay_inbox SET processed = 1 WHERE ref_id = ?", [threadId]);
		const newId = insertEnvelope(threadId, "fresh-envelope", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("fresh-envelope");
		expect(result.content).not.toContain("stale-envelope");
		expect(result.processedIds).toEqual([newId]);
	});

	test("does not fetch entries for other threads", () => {
		const myThreadId = randomUUID();
		const otherThreadId = randomUUID();
		insertEnvelope(otherThreadId, "wrong-thread-envelope", "2026-05-18T20:00:00Z");
		const myId = insertEnvelope(myThreadId, "my-envelope", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: myThreadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("my-envelope");
		expect(result.content).not.toContain("wrong-thread-envelope");
		expect(result.processedIds).toEqual([myId]);
	});

	test("non-event task types ignore the inbox path", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "shouldnt-show", "2026-05-18T21:00:00Z");

		const task = makeTask({ type: "cron", thread_id: threadId, payload: "cron payload" });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toBe("cron payload");
		expect(result.processedIds).toEqual([]);
	});

	test("preserves task.payload as standing context when also folding envelopes", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "envelope-body", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId, payload: "Standing context" });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("envelope-body");
		expect(result.content).toContain("Standing context");
	});

	test("wraps folded envelopes in a <connector-events> envelope, one <event> node each", () => {
		const threadId = randomUUID();
		const id1 = insertEnvelope(threadId, "body-one", "2026-05-18T21:00:00Z");
		const id2 = insertEnvelope(threadId, "body-two", "2026-05-18T21:01:00Z");

		const task = makeTask({ thread_id: threadId, trigger_spec: "connector:github" });
		const result = buildEventWakeupContent(db, task);

		// Parent envelope carries the trigger + event count.
		expect(result.content).toContain('<connector-events trigger="connector:github" count="2">');
		expect(result.content).toContain("</connector-events>");

		// Each event is its own node with attributes drawn from the inbox row.
		expect(result.content).toMatch(
			/<event index="1" received="2026-05-18T21:00:00Z" kind="webhook_intake" source-site="[^"]+">/,
		);
		expect(result.content).toMatch(/<event index="2" received="2026-05-18T21:01:00Z"/);
		expect((result.content.match(/<event /g) || []).length).toBe(2);
		expect((result.content.match(/<\/event>/g) || []).length).toBe(2);

		// Bodies live inside the nodes, in order.
		expect(result.content).toContain("body-one");
		expect(result.content).toContain("body-two");
		expect(result.content.indexOf("body-one")).toBeLessThan(result.content.indexOf("body-two"));
		expect(result.processedIds).toEqual([id1, id2]);
	});

	test('wraps a single envelope with count=1 and one <event index="1"> node', () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "solo-body", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId, trigger_spec: "connector:stripe" });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain('<connector-events trigger="connector:stripe" count="1">');
		expect(result.content).toMatch(/<event index="1" received="2026-05-18T21:00:00Z"/);
		expect((result.content.match(/<\/event>/g) || []).length).toBe(1);
		expect(result.content).toContain("solo-body");
	});

	test("escapes special characters in connector-events attribute values", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "body", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId, trigger_spec: 'weird"&<spec>' });
		const result = buildEventWakeupContent(db, task);

		// The raw, unescaped trigger must never reach the attribute.
		expect(result.content).not.toContain('trigger="weird"&<spec>"');
		expect(result.content).toContain("&quot;");
		expect(result.content).toContain("&amp;");
		expect(result.content).toContain("&lt;");
		expect(result.content).toContain("&gt;");
	});

	test("keeps the standing task payload outside the connector-events envelope", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "envelope-body", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId, payload: "Standing context" });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("Standing context");
		// Standing payload sits after the closed envelope, not nested in it.
		expect(result.content.indexOf("</connector-events>")).toBeLessThan(
			result.content.indexOf("Standing context"),
		);
	});

	test("ignores rows of other kinds even when they share the ref_id", () => {
		// Pre-fix the helper queried only by ref_id, so a stray platform-MCP
		// `intake` row (entirely different payload schema) on the same thread
		// would be folded as if it were a webhook envelope. The kind filter
		// scopes the helper to its own mailbox kind.
		const threadId = randomUUID();
		insertEnvelope(threadId, "platform-mcp-payload", "2026-05-18T20:00:00Z", "intake");
		insertEnvelope(threadId, "real-webhook-payload", "2026-05-18T21:00:00Z", "webhook_intake");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("real-webhook-payload");
		expect(result.content).not.toContain("platform-mcp-payload");
		// processedIds is exclusively the webhook_intake row id; the stray
		// intake row stays processed=0 for the relay-processor to handle on
		// its own dispatch path.
		expect(result.processedIds.length).toBe(1);
	});

	test("inlines a JSON request body so the envelope isn't double-escaped (#177)", () => {
		const threadId = randomUUID();
		const githubEvent = {
			action: "opened",
			issue: { number: 42, title: "Bug", body: "repro steps" },
		};
		const envelope = JSON.stringify({
			method: "POST",
			path: "/webhook/bound",
			headers: { "x-github-event": "issues" },
			content_type: "application/json",
			body: JSON.stringify(githubEvent),
		});
		insertEnvelope(threadId, envelope, "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		// The double-escaped form must NOT survive into the wakeup.
		expect(result.content).not.toContain('\\"action\\"');
		// The event lands as structured JSON the agent can read directly.
		expect(result.content).toContain('"action":"opened"');
		expect(result.content).toContain('"number":42');
		expect(result.content).toContain('"body":"repro steps"');
	});

	test("leaves a non-JSON request body verbatim (#177)", () => {
		const threadId = randomUUID();
		const envelope = JSON.stringify({
			method: "POST",
			path: "/webhook/forms",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			content_type: "application/x-www-form-urlencoded",
			body: "name=foo&value=bar",
		});
		insertEnvelope(threadId, envelope, "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("name=foo&value=bar");
	});

	test("leaves a payload that isn't a JSON envelope verbatim (#177)", () => {
		const threadId = randomUUID();
		insertEnvelope(threadId, "not json at all", "2026-05-18T21:00:00Z");

		const task = makeTask({ thread_id: threadId });
		const result = buildEventWakeupContent(db, task);

		expect(result.content).toContain("not json at all");
	});
});
