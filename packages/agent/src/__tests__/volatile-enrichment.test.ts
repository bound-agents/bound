import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, softDelete } from "@bound/core";
import {
	buildCrossThreadDigest,
	buildVolatileEnrichment,
	computeBaseline,
} from "../summary-extraction.js";

let db: Database;
let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("computeBaseline", () => {
	it("AC4.1: returns the most-recent user-role message timestamp when newer than the 24h floor", () => {
		// Post-2026-05-24 contract change: baseline anchors to the
		// last user-role message (the real conversational boundary)
		// rather than thread.last_message_at. The latter advances on
		// every persisted assistant/tool/developer row, which on
		// self-driving threads collapses L3 recency to "nothing newer
		// than seconds ago" and excludes any memorize that landed
		// between wakeups (live evidence: thread d0372be6).
		const threadId = randomBytes(8).toString("hex");
		const userId = randomBytes(8).toString("hex");
		const siteId = randomBytes(8).toString("hex");

		// Pin nowMs so the 24h floor is deterministic. We pick a
		// recent user message (5 minutes before nowMs), which is
		// strictly newer than the floor → baseline = user message.
		const nowMs = Date.parse("2026-05-24T12:00:00.000Z");
		const userMessageAt = "2026-05-24T11:55:00.000Z"; // 5 min before nowMs

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread",
				created_at: "2026-03-01T00:00:00.000Z",
				last_message_at: userMessageAt,
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"messages",
			{
				id: randomBytes(8).toString("hex"),
				thread_id: threadId,
				role: "user",
				content: "test user message",
				model_id: null,
				tool_name: null,
				created_at: userMessageAt,
				modified_at: userMessageAt,
				host_origin: "test",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);

		const baseline = computeBaseline(db, threadId, undefined, false, nowMs);
		expect(baseline).toBe(userMessageAt);
	});

	it("AC4.2: returns the 24h wallclock floor when no user message has landed within the last 24h", () => {
		// Autonomous threads (webhook handlers, scheduler-driven
		// tasks) and dormant user threads where the user hasn't typed
		// in over a day collapse to thread.created_at under the
		// fallback chain. The floor caps how far back recency reaches
		// — preventing autonomous threads from rendering days or
		// weeks of stale memory delta.
		const threadId = randomBytes(8).toString("hex");
		const userId = randomBytes(8).toString("hex");
		const siteId = randomBytes(8).toString("hex");
		const nowMs = Date.parse("2026-05-24T12:00:00.000Z");
		const floor = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
		const ancientCreatedAt = "2026-03-01T00:00:00.000Z"; // way before floor

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "webhook",
				host_origin: "test",
				color: 0,
				title: "Autonomous Thread",
				created_at: ancientCreatedAt,
				last_message_at: ancientCreatedAt,
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		const baseline = computeBaseline(db, threadId, undefined, false, nowMs);
		expect(baseline).toBe(floor);
	});

	it("AC4.3: returns task.last_run_at when noHistory is true and taskId given", () => {
		const taskId = randomBytes(8).toString("hex");
		const siteId = randomBytes(8).toString("hex");
		const lastRunAt = "2026-03-15T12:00:00.000Z";

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: "2026-03-01T00:00:00.000Z",
				modified_at: new Date().toISOString(),
				last_run_at: lastRunAt,
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		const baseline = computeBaseline(db, "", taskId, true);
		expect(baseline).toBe(lastRunAt);
	});

	it("AC4.4: returns task.created_at when last_run_at is null (first run)", () => {
		const taskId = randomBytes(8).toString("hex");
		const siteId = randomBytes(8).toString("hex");
		const createdAt = "2026-03-01T00:00:00.000Z";

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: createdAt,
				modified_at: new Date().toISOString(),
				last_run_at: null,
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		const baseline = computeBaseline(db, "", taskId, true);
		expect(baseline).toBe(createdAt);
	});

	it("AC4.5: returns epoch when noHistory is true and no taskId", () => {
		const baseline = computeBaseline(db, "", undefined, true);
		expect(baseline).toBe("1970-01-01T00:00:00.000Z");
	});
});

describe("buildVolatileEnrichment — memory delta", () => {
	const baseline = "2026-03-01T00:00:00.000Z";
	const siteId = randomBytes(8).toString("hex");

	it("AC2.1: includes entry with modified_at after baseline", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain("- test-key:");
	});

	it("AC2.2: excludes entry with modified_at before baseline", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(0);
	});

	it("AC2.3: renders tombstoned entry as [forgotten]", () => {
		const memId = randomBytes(8).toString("hex");
		insertRow(
			db,
			"semantic_memory",
			{
				id: memId,
				key: "test-key",
				value: "test-value",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		softDelete(db, "semantic_memory", memId, siteId);

		// Set baseline before the soft delete to ensure the modified_at is after it
		const earlyBaseline = "2026-01-01T00:00:00.000Z";
		const enrichment = buildVolatileEnrichment(db, earlyBaseline);

		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain("[forgotten]");
		expect(enrichment.memoryDeltaLines[0]).not.toContain("test-value");
	});

	it("AC2.4: shows overflow line when more than maxMemory entries changed", () => {
		for (let i = 0; i < 11; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `key-${i}`,
					value: `value-${i}`,
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
				},
				siteId,
			);
		}

		const enrichment = buildVolatileEnrichment(db, baseline, 10);
		expect(enrichment.memoryDeltaLines.length).toBe(11);
		expect(enrichment.memoryDeltaLines[10]).toContain("... and 1 more");
		expect(enrichment.memoryDeltaLines[10]).toContain("query semantic_memory for full list");
	});

	it("AC2.5: truncates value longer than 200 chars", () => {
		const longValue = "x".repeat(210);
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: longValue,
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain("...");
		expect(enrichment.memoryDeltaLines[0]).not.toContain(longValue);
	});
});

describe("buildVolatileEnrichment — _internal key filtering", () => {
	const baseline = "2026-03-01T00:00:00.000Z";
	const siteId = randomBytes(8).toString("hex");

	it("excludes _internal.* keys from L3 recency surface", () => {
		// Insert an _internal.file_thread entry recent enough to normally surface via L3
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_internal.file_thread./workspace/some/file.ts",
				value: "some-thread-id",
				source: "/workspace/some/file.ts",
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		const hasInternal = enrichment.memoryDeltaLines.some((l) =>
			l.includes("_internal.file_thread"),
		);
		expect(hasInternal).toBe(false);
	});

	it("does not count _internal.* keys in the 'N more' overflow line", () => {
		// Seed 3 real default-tier entries AND 5 _internal entries, all recent.
		// With maxMemory=2, overflow should count only the 3 real entries (1 more after 2 shown),
		// not 8 (3 real + 5 internal).
		for (let i = 0; i < 3; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `real-key-${i}`,
					value: `real-value-${i}`,
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
				},
				siteId,
			);
		}
		for (let i = 0; i < 5; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `_internal.file_thread./workspace/noise-${i}.ts`,
					value: "thread-id",
					source: `/workspace/noise-${i}.ts`,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
				},
				siteId,
			);
		}

		const enrichment = buildVolatileEnrichment(db, baseline, 2);
		const overflowLine = enrichment.memoryDeltaLines.find((l) => l.includes("... and"));
		expect(overflowLine).toBeDefined();
		expect(overflowLine).toContain("... and 1 more");
	});
});

describe("buildVolatileEnrichment — pinned/policy entries", () => {
	const siteId = randomBytes(8).toString("hex");

	it("always includes pinned-tier entries regardless of recency", () => {
		// Insert a pinned-tier entry with a very old modified_at
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "policy_research_guidelines",
				value: "Always cite sources when researching",
				source: null,
				tier: "pinned",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Baseline well after the entry
		const enrichment = buildVolatileEnrichment(db, "2026-03-28T00:00:00.000Z");
		const policyLine = enrichment.memoryDeltaLines.find((l) =>
			l.includes("policy_research_guidelines"),
		);
		expect(policyLine).toBeDefined();
		expect(policyLine).toContain("Always cite sources");
	});

	it("ignores legacy underscore-prefixed entries that lack tier='pinned'", () => {
		// Pre-removal contract: "_pinned_*" prefix would auto-pin. Post-removal: it does NOT.
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_operator_name",
				value: "Kara is the operator",
				source: null,
				// no explicit tier — defaults to 'default'
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, "2026-03-28T00:00:00.000Z");
		const pinnedLine = enrichment.memoryDeltaLines.find((l) => l.includes("_pinned_operator_name"));
		// The entry is not pinned and was modified before baseline, so it must NOT appear.
		expect(pinnedLine).toBeUndefined();
	});

	it("pinned-tier entries do not count against maxMemory limit", () => {
		// Insert a pinned entry (tier='pinned' is the only thing that pins)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "important_rule",
				value: "This is pinned",
				source: null,
				tier: "pinned",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Insert maxMemory regular entries after baseline
		for (let i = 0; i < 3; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `regular-entry-${Date.now()}-${i}`,
					value: `value ${i}`,
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-29T12:00:00.000Z",
					deleted: 0,
				},
				siteId,
			);
		}

		// maxMemory=3: all 3 regular entries + pinned should appear
		const enrichment = buildVolatileEnrichment(db, "2026-03-28T00:00:00.000Z", 3);
		const hasPinned = enrichment.memoryDeltaLines.some((l) => l.includes("important_rule"));
		const regularCount = enrichment.memoryDeltaLines.filter((l) =>
			l.includes("regular-entry"),
		).length;
		expect(hasPinned).toBe(true);
		expect(regularCount).toBe(3);
	});
});

describe("buildVolatileEnrichment — relevance boosting", () => {
	const siteId = randomBytes(8).toString("hex");

	it("boosts matching memory entries when userMessage is provided", () => {
		// Insert an old entry (before baseline) that matches the user's question
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "scheduler_cron_patterns",
				value: "Cron tasks use standard crontab syntax with 5 fields",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Insert a recent unrelated entry (after baseline)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "music_preferences",
				value: "User likes jazz",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-29T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// User asks about the scheduler — the old scheduler entry should be boosted in
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"How does the scheduler handle cron tasks?",
		);

		const hasScheduler = enrichment.memoryDeltaLines.some((l) =>
			l.includes("scheduler_cron_patterns"),
		);
		expect(hasScheduler).toBe(true);
	});

	it("does not boost entries that do not match the user message", () => {
		// Insert an old unrelated entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "favorite_color_blue",
				value: "The sky is blue",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// User asks about something completely unrelated
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"What is the sync protocol?",
		);

		const hasColor = enrichment.memoryDeltaLines.some((l) => l.includes("favorite_color_blue"));
		expect(hasColor).toBe(false);
	});
});

describe("buildVolatileEnrichment — assistant message keyword seeding", () => {
	const siteId = randomBytes(8).toString("hex");

	it("surfaces entries matching assistant-message keywords when the user message is keyword-barren", () => {
		// The tool-loop case: the user said "continue", but the assistant's prior
		// turn (output + reasoning) is dense with the topic vocabulary. Seeding L2
		// from the assistant turn should surface the matching entry.
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "kafka_rebalance_protocol",
				value: "Kafka consumer rebalance uses a cooperative sticky assignor",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// User message is keyword-barren ("continue"); assistant message carries
		// the topic vocabulary (kafka, rebalance).
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"continue",
			undefined,
			"I traced the kafka consumer rebalance path and the sticky assignor logic",
		);

		const hasKafka = enrichment.memoryDeltaLines.some((l) =>
			l.includes("kafka_rebalance_protocol"),
		);
		expect(hasKafka).toBe(true);
	});

	it("does not surface the entry when no assistant message is provided (control)", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "kafka_rebalance_protocol",
				value: "Kafka consumer rebalance uses a cooperative sticky assignor",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Same keyword-barren user message, but no assistant seed — nothing matches.
		const enrichment = buildVolatileEnrichment(db, "2026-03-28T00:00:00.000Z", 10, 5, "continue");

		const hasKafka = enrichment.memoryDeltaLines.some((l) =>
			l.includes("kafka_rebalance_protocol"),
		);
		expect(hasKafka).toBe(false);
	});
});

describe("buildVolatileEnrichment — thread summary keyword seeding", () => {
	const siteId = randomBytes(8).toString("hex");

	it("surfaces entries matching thread summary keywords when user message has no matching keywords", () => {
		// Memory about agent detection — only matches "agent" and "detection" keywords
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "agent_detection_research",
				value: "Agent detection techniques using behavioral fingerprinting",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Memory about MCP spec — only matches "mcp" and "protocol" keywords
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "mcp_spec_notes",
				value: "MCP protocol uses JSON-RPC for tool invocation",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// User says "memory coherence check" — no keywords match agent/detection/mcp/protocol
		// But thread summary mentions both topics
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"memory coherence check",
			"We discussed agent detection techniques and MCP protocol implementation details",
		);

		const hasAgentDetection = enrichment.memoryDeltaLines.some((l) =>
			l.includes("agent_detection_research"),
		);
		const hasMcpSpec = enrichment.memoryDeltaLines.some((l) => l.includes("mcp_spec_notes"));
		expect(hasAgentDetection).toBe(true);
		expect(hasMcpSpec).toBe(true);
	});

	it("deduplicates keywords — message keywords take priority over summary keywords", () => {
		// Entry that matches "scheduler" — present in both message and summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "scheduler_internals",
				value: "Scheduler uses cron expressions for task timing",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// Both message and summary mention "scheduler" — should not cause duplicates
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"How does the scheduler work?",
			"We explored the scheduler implementation and sync protocol",
		);

		const schedulerLines = enrichment.memoryDeltaLines.filter((l) =>
			l.includes("scheduler_internals"),
		);
		// Should appear exactly once, not duplicated
		expect(schedulerLines.length).toBe(1);
	});

	it("works when threadSummary is undefined (backward compatible)", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "basic_entry",
				value: "Just a regular memory entry",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-29T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// No threadSummary — should still work as before
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			"some user message",
		);

		expect(enrichment.memoryDeltaLines.length).toBeGreaterThanOrEqual(1);
	});

	it("thread summary surfaces entries even when user message is empty", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "bluesky_tooling",
				value: "Bluesky AT Protocol uses DIDs for identity",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		// No user message but thread summary has relevant keywords
		const enrichment = buildVolatileEnrichment(
			db,
			"2026-03-28T00:00:00.000Z",
			10,
			5,
			undefined,
			"Discussed bluesky tooling and AT protocol integration",
		);

		const hasBluesky = enrichment.memoryDeltaLines.some((l) => l.includes("bluesky_tooling"));
		expect(hasBluesky).toBe(true);
	});
});

describe("buildVolatileEnrichment — task digest", () => {
	const baseline = "2026-03-01T00:00:00.000Z";
	const siteId = randomBytes(8).toString("hex");

	it("AC3.1: shows 'ran' for task with consecutive_failures=0", () => {
		insertRow(
			db,
			"tasks",
			{
				id: randomBytes(8).toString("hex"),
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-15T12:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(1);
		expect(enrichment.taskDigestLines[0]).toContain(" ran ");
	});

	it("AC3.2: shows 'failed' for task with consecutive_failures>0", () => {
		insertRow(
			db,
			"tasks",
			{
				id: randomBytes(8).toString("hex"),
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-15T12:00:00.000Z",
				consecutive_failures: 2,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(1);
		expect(enrichment.taskDigestLines[0]).toContain(" failed ");
	});

	it("AC3.3: resolves host_name from hosts table", () => {
		const siteIdHost = "test-site-id-12345678";
		insertRow(
			db,
			"hosts",
			{
				site_id: siteIdHost,
				host_name: "my-host",
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"tasks",
			{
				id: randomBytes(8).toString("hex"),
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-15T12:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: siteIdHost,
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(1);
		expect(enrichment.taskDigestLines[0]).toContain("my-host");
	});

	it("AC3.4: falls back to claimed_by[0:8] when no hosts row", () => {
		const claimedBy = "abcdef1234567890";
		insertRow(
			db,
			"tasks",
			{
				id: randomBytes(8).toString("hex"),
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-15T12:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: claimedBy,
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(1);
		expect(enrichment.taskDigestLines[0]).toContain("abcdef12");
	});

	it("AC3.5: shows overflow line when more than maxTasks tasks ran", () => {
		for (let i = 0; i < 6; i++) {
			insertRow(
				db,
				"tasks",
				{
					id: randomBytes(8).toString("hex"),
					type: "cron",
					status: "active",
					trigger_spec: `test-task-${i}`,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					last_run_at: "2026-03-15T12:00:00.000Z",
					consecutive_failures: 0,
					claimed_by: null,
					deleted: 0,
				},
				siteId,
			);
		}

		const enrichment = buildVolatileEnrichment(db, baseline, 10, 5);
		expect(enrichment.taskDigestLines.length).toBe(6);
		expect(enrichment.taskDigestLines[5]).toContain("... and 1 more");
		expect(enrichment.taskDigestLines[5]).toContain("query tasks for full list");
	});

	it("AC3.6: excludes task with last_run_at before baseline", () => {
		insertRow(
			db,
			"tasks",
			{
				id: randomBytes(8).toString("hex"),
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-02-15T12:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(0);
	});

	it("AC3.7: excludes soft-deleted tasks", () => {
		const taskId = randomBytes(8).toString("hex");
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "active",
				trigger_spec: "test-task",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-15T12:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		softDelete(db, "tasks", taskId, siteId);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.taskDigestLines.length).toBe(0);
	});
});

describe("buildVolatileEnrichment — source resolution", () => {
	const baseline = "2026-03-01T00:00:00.000Z";
	const siteId = randomBytes(8).toString("hex");

	it("AC5.1: resolves source matching task id to task name", () => {
		const taskId = randomBytes(8).toString("hex");
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "active",
				trigger_spec: "my_cron",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_run_at: "2026-03-01T00:00:00.000Z",
				consecutive_failures: 0,
				claimed_by: null,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: taskId,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain('via task "my_cron"');
	});

	it("AC5.2: resolves source matching active thread id to thread title", () => {
		const threadId = randomBytes(8).toString("hex");
		const userId = randomBytes(8).toString("hex");

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "My Thread",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: threadId,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain('via thread "My Thread"');
	});

	it("AC5.3: resolves untitled thread source to thread id prefix", () => {
		const threadId = randomBytes(8).toString("hex");
		const userId = randomBytes(8).toString("hex");

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: null,
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: threadId,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain(`via thread "${threadId.slice(0, 8)}"`);
	});

	it("AC5.4: falls back to id prefix for deleted thread source", () => {
		const threadId = randomBytes(8).toString("hex");
		const userId = randomBytes(8).toString("hex");

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "My Thread",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: threadId,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		softDelete(db, "threads", threadId, siteId);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain(threadId.slice(0, 8));
		expect(enrichment.memoryDeltaLines[0]).not.toContain('thread "');
	});

	it("AC5.5: falls back to source[0:8] for unmatched source", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: "zzzzzzzz1234",
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain("via zzzzzzzz");
	});

	it("AC5.6: resolves null source to 'unknown'", () => {
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test-key",
				value: "test-value",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline);
		expect(enrichment.memoryDeltaLines.length).toBe(1);
		expect(enrichment.memoryDeltaLines[0]).toContain("via unknown");
	});
});

// buildCrossThreadDigest was only showing thread title + message count, silently
// ignoring threads.summary even though extractSummaryAndMemories() populates it.
// Cross-thread conversational continuity depends on seeing those summaries.
describe("buildCrossThreadDigest — includes thread summaries", () => {
	const userId = `diag-user-${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date().toISOString();

	beforeEach(() => {
		db.run(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
			[userId, "Digest User", now, now, 0],
		);
	});

	afterEach(() => {
		db.run("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ?)", [
			userId,
		]);
		db.run("DELETE FROM threads WHERE user_id = ?", [userId]);
		db.run("DELETE FROM users WHERE id = ?", [userId]);
	});

	function addMessage(threadId: string): void {
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				`msg-${Math.random().toString(36).slice(2, 10)}`,
				threadId,
				"user",
				"test",
				null,
				now,
				now,
				"local",
				0,
			],
		);
	}

	it("includes thread title and message count when populated", () => {
		const threadId = `digest-thread-${Math.random().toString(36).slice(2, 8)}`;
		const summary = "The user and assistant discussed cross-thread memory persistence.";
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Memory Discussion",
				summary,
				now,
				null,
				null,
				now,
				now,
				now,
				0,
			],
		);
		addMessage(threadId);

		const { text, sources, entries } = buildCrossThreadDigest(db, userId);

		// Thread title must appear in the digest
		expect(text).toContain("Memory Discussion");
		// Should NOT contain the summary excerpt (R-VC23)
		expect(text).not.toContain("Summary:");
		// Verify sources array contains the thread
		expect(sources).toHaveLength(1);
		expect(sources[0].threadId).toBe(threadId);
		expect(sources[0].title).toBe("Memory Discussion");
		expect(sources[0].color).toBe(0);
		expect(sources[0]).toHaveProperty("messageCount");
		expect(sources[0]).toHaveProperty("lastMessageAt");
		// Verify structured entries are populated
		expect(entries).toHaveLength(1);
		expect(entries[0].title).toBe("Memory Discussion");
		expect(entries[0].messageCount).toBe(1);
		expect(entries[0].lastUpdatedAt).toBe(now);
	});

	it("still works when thread has no summary (null)", () => {
		const threadId = `digest-thread-nosummary-${Math.random().toString(36).slice(2, 8)}`;
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				3,
				"Untitled Thread",
				null,
				null,
				null,
				null,
				now,
				now,
				now,
				0,
			],
		);
		addMessage(threadId);

		const { text, sources, entries } = buildCrossThreadDigest(db, userId);
		expect(text).toContain("Untitled Thread");
		// No crash when summary is null
		expect(text).not.toBeNull();
		// Should NOT contain summary excerpt line
		expect(text).not.toContain("Summary:");
		// Thread without summary appears in text but NOT in sources
		// (only threads with summaries contribute real cross-thread context)
		expect(sources).toHaveLength(0);
		// But it DOES appear in entries (structured rows)
		expect(entries).toHaveLength(1);
		expect(entries[0].title).toBe("Untitled Thread");
	});

	it("returns array with correct color values for different threads", () => {
		// Create threads with different color values
		const threadId1 = `digest-thread-color1-${Math.random().toString(36).slice(2, 8)}`;
		const threadId2 = `digest-thread-color2-${Math.random().toString(36).slice(2, 8)}`;
		const threadId3 = `digest-thread-color3-${Math.random().toString(36).slice(2, 8)}`;

		const ts1 = new Date(Date.now() + 1000).toISOString();
		const ts2 = new Date(Date.now() + 2000).toISOString();
		const ts3 = new Date(Date.now() + 3000).toISOString();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId1,
				userId,
				"web",
				"local",
				0,
				"Thread Color 0",
				"Summary for thread 0",
				null,
				null,
				null,
				now,
				ts1,
				now,
				0,
			],
		);
		addMessage(threadId1);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId2,
				userId,
				"web",
				"local",
				3,
				"Thread Color 3",
				"Summary for thread 3",
				null,
				null,
				null,
				now,
				ts2,
				now,
				0,
			],
		);
		addMessage(threadId2);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId3,
				userId,
				"web",
				"local",
				7,
				"Thread Color 7",
				"Summary for thread 7",
				null,
				null,
				null,
				now,
				ts3,
				now,
				0,
			],
		);
		addMessage(threadId3);

		const { sources, entries, text } = buildCrossThreadDigest(db, userId);
		expect(sources).toHaveLength(3);
		// Most recent first (by last_message_at DESC)
		expect(sources[0].color).toBe(7);
		expect(sources[1].color).toBe(3);
		expect(sources[2].color).toBe(0);
		// Verify entries are populated
		expect(entries).toHaveLength(3);
		// Verify no Summary lines in text (R-VC23)
		expect(text).not.toContain("Summary:");
	});

	it("returns empty sources when no threads exist", () => {
		const { text, sources, entries } = buildCrossThreadDigest(db, userId);
		expect(text).toBe("No recent activity.");
		expect(sources).toHaveLength(0);
		expect(entries).toHaveLength(0);
	});

	it("excludes specified thread when excludeThreadId is provided", () => {
		const threadIdA = `digest-thread-a-${Math.random().toString(36).slice(2, 8)}`;
		const threadIdB = `digest-thread-b-${Math.random().toString(36).slice(2, 8)}`;

		const tsA = new Date(Date.now() + 1000).toISOString();
		const tsB = new Date(Date.now() + 2000).toISOString();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadIdA,
				userId,
				"web",
				"local",
				1,
				"Thread A",
				"Summary A",
				null,
				null,
				null,
				now,
				tsA,
				now,
				0,
			],
		);
		addMessage(threadIdA);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadIdB,
				userId,
				"web",
				"local",
				2,
				"Thread B",
				"Summary B",
				null,
				null,
				null,
				now,
				tsB,
				now,
				0,
			],
		);
		addMessage(threadIdB);

		// Call with excludeThreadId set to threadIdA
		const { sources, entries } = buildCrossThreadDigest(db, userId, threadIdA);
		// Should only return threadIdB
		expect(sources).toHaveLength(1);
		expect(sources[0].threadId).toBe(threadIdB);
		expect(sources[0].title).toBe("Thread B");
		expect(sources[0].color).toBe(2);
		// Entries should also exclude the thread
		expect(entries).toHaveLength(1);
		expect(entries[0].title).toBe("Thread B");
	});
});
