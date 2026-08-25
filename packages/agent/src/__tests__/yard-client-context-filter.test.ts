/**
 * Yard client-tool bookkeeping rows must never reach LLM context.
 *
 * Incident (thread adb65d85, 2026-08-16): Yard's awaitable client dispatch
 * (`dispatchAwaitableClientTool`) persists one `tool_result` row per effect
 * with `tool_name = yard-client-<uuid>` and NO declaring tool_call — the
 * aggregate `yard` tool_result already carries their content. On cold
 * reassembly the Stage 5 annotator's fallback stamped each such orphan with
 * the LAST tool_call's first tool_use id, producing N tool_results for one
 * tool_use — Bedrock 400 "each tool_use must have a single result", and
 * every retry rebuilt the same poisoned context.
 *
 * Contract pinned here:
 *   F1 Cold path (assembleContext Stage 1) drops bookkeeping rows and never
 *      emits two tool_results with the same tool_use_id.
 *   F2 Warm path (convertDeltaMessages) drops bookkeeping rows without
 *      breaking parallel tool_result runs.
 *   F3 Delegation codec: the range covers the full filtered history (the
 *      producer/consumer loaders apply the same filter) and round-trips
 *      byte-equal.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	applyMetricsSchema,
	applySchema,
	listLiveMessageProjectionByThreadNewestFirst,
} from "@bound/core";
import { type DbMessageRow, convertDeltaMessages } from "../agent-loop-utils";
import { annotateMessages } from "../annotation/annotate";
import { assembleContext } from "../context-assembly";
import { resolveSegments, segmentAssembledMessages } from "../delegation-segments";
import { isYardClientBookkeepingRow } from "../yard-client-rows";

const NOW_MS = new Date("2026-08-16T07:00:00.000Z").getTime();

describe("Yard client bookkeeping rows are filtered from LLM context", () => {
	let db: Database;
	let threadId: string;
	let userId: string;

	const insertMessage = (
		role: string,
		content: string,
		toolName: string | null,
		createdAt: string,
	): string => {
		const id = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[id, threadId, role, content, null, toolName, createdAt, createdAt, "local"],
		);
		return id;
	};

	beforeAll(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);

		userId = randomUUID();
		threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, now, now, 0],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, userId, "web", "local", now, now, now, 0],
		);

		// Incident shape: think pair, then Yard bookkeeping results, then the
		// yard aggregate pair, then a user follow-up.
		insertMessage("user", "run the yard program", null, "2026-08-16T06:40:00.000Z");
		insertMessage(
			"tool_call",
			JSON.stringify([{ type: "tool_use", id: "toolu_think1", name: "think", input: {} }]),
			null,
			"2026-08-16T06:40:35.000Z",
		);
		insertMessage(
			"tool_result",
			"Thinking complete - please continue your work.",
			"toolu_think1",
			"2026-08-16T06:40:35.100Z",
		);
		for (let i = 0; i < 3; i++) {
			insertMessage(
				"tool_result",
				JSON.stringify([{ type: "text", text: `bookkeeping probe output ${i}` }]),
				`yard-client-${randomUUID()}`,
				`2026-08-16T06:40:5${i}.000Z`,
			);
		}
		insertMessage(
			"tool_call",
			JSON.stringify([{ type: "tool_use", id: "toolu_yard1", name: "yard", input: {} }]),
			null,
			"2026-08-16T06:41:00.000Z",
		);
		insertMessage(
			"tool_result",
			JSON.stringify({ result: "aggregate yard output" }),
			"toolu_yard1",
			"2026-08-16T06:41:00.100Z",
		);
		insertMessage("user", "thanks, looks good", null, "2026-08-16T06:41:30.000Z");
	});

	afterAll(() => {
		db.close();
	});

	it("predicate matches only yard-client tool_results", () => {
		expect(isYardClientBookkeepingRow({ role: "tool_result", tool_name: "yard-client-abc" })).toBe(
			true,
		);
		expect(isYardClientBookkeepingRow({ role: "tool_result", tool_name: "toolu_x" })).toBe(false);
		expect(isYardClientBookkeepingRow({ role: "tool_result", tool_name: null })).toBe(false);
		expect(isYardClientBookkeepingRow({ role: "tool_call", tool_name: "yard-client-abc" })).toBe(
			false,
		);
	});

	it("F1: cold assembly drops bookkeeping rows and never duplicates a tool_use_id", () => {
		const { messages } = assembleContext({ db, threadId, userId });

		const serialized = JSON.stringify(messages);
		expect(serialized).not.toContain("bookkeeping probe output");
		expect(serialized).not.toContain("yard-client-");

		const resultIds = messages
			.filter((m) => m.role === "tool_result")
			.map((m) => m.tool_use_id)
			.filter((id): id is string => typeof id === "string");
		expect(new Set(resultIds).size).toBe(resultIds.length);
	});

	it("F2: warm delta conversion drops bookkeeping rows without breaking the run", () => {
		const t = "2026-08-16T06:50:00.000Z";
		const mkRow = (role: string, content: string, toolName: string | null): DbMessageRow => ({
			id: randomUUID(),
			thread_id: threadId,
			role,
			content,
			model_id: null,
			tool_name: toolName,
			created_at: t,
			modified_at: t,
			host_origin: "local",
			deleted: 0,
		});
		const rows = [
			mkRow(
				"tool_call",
				JSON.stringify([
					{ type: "tool_use", id: "tuA", name: "x", input: {} },
					{ type: "tool_use", id: "tuB", name: "x", input: {} },
				]),
				null,
			),
			mkRow("tool_result", "result A", "tuA"),
			mkRow("tool_result", "[bookkeeping]", `yard-client-${randomUUID()}`),
			mkRow("tool_result", "result B", "tuB"),
		];
		const out = convertDeltaMessages(rows);
		expect(out).toHaveLength(3);
		expect(out.map((m) => m.tool_use_id ?? null)).toEqual([null, "tuA", "tuB"]);
	});

	it("F3: delegation range covers the full filtered history and round-trips byte-equal", () => {
		const filteredRows = listLiveMessageProjectionByThreadNewestFirst(db, threadId, 100000)
			.reverse()
			.filter((row) => !isYardClientBookkeepingRow(row));
		const producerMessages = annotateMessages({ messages: filteredRows, nowMs: NOW_MS });

		const segments = segmentAssembledMessages({
			db,
			threadId,
			producerMessages,
			nowMs: NOW_MS,
			isRangeCoverable: () => true,
		});

		expect(segments[0]?.kind).toBe("range");
		if (segments[0]?.kind === "range") {
			expect(segments[0].count).toBe(filteredRows.length);
		}

		const resolved = resolveSegments(segments, db, NOW_MS);
		expect(JSON.stringify(resolved)).toBe(JSON.stringify(producerMessages));
	});
});
