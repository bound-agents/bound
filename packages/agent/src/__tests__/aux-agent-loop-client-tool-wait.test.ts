import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { applySchema, getClientToolCallStatus, insertRow } from "@bound/core";
import type { LoopToolExecutionBatch, ParsedResponse } from "@bound/loop";
import {
	AuxAgentLoop,
	CLIENT_TOOL_TIMEOUT_MS,
	clientToolWaitMs,
	describeClientToolGiveUp,
} from "../aux-agent-loop";
import type { BoundPreparedFrame } from "../bound-agent-loop";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

class WaitProbeLoop extends AuxAgentLoop {
	abortNow(): void {
		this.aborted = true;
	}
	async runDeferred(call: { id: string; name: string; input: Record<string, unknown> }) {
		const frame = { messages: [] } as unknown as BoundPreparedFrame;
		const batch = {
			results: [],
			deferred: [{ toolCall: call }],
		} as unknown as LoopToolExecutionBatch;
		return this.afterToolPersistence({} as ParsedResponse, frame, batch);
	}
}

describe("aux client-tool wait budget (#278)", () => {
	it("derives the wait from the call's own timeout plus grace, floored at the default", () => {
		expect(clientToolWaitMs({})).toBe(CLIENT_TOOL_TIMEOUT_MS);
		expect(clientToolWaitMs({ timeout: 10_000 })).toBe(CLIENT_TOOL_TIMEOUT_MS);
		expect(clientToolWaitMs({ timeout: 600_000 })).toBe(630_000);
		expect(clientToolWaitMs({ timeout: "600000" })).toBe(CLIENT_TOOL_TIMEOUT_MS);
	});

	it("names the real reason a call was given up on", () => {
		expect(
			describeClientToolGiveUp("boundless_bash", "timeout", 630_000, { timeout: 600_000 }),
		).toContain("exceeded its 600s timeout plus 30s grace with the session still connected");
		expect(describeClientToolGiveUp("boundless_bash", "dropped", 300_000, {})).toContain(
			"lost its client session",
		);
		expect(describeClientToolGiveUp("boundless_bash", "aborted", 300_000, {})).toContain(
			"aux loop was aborted",
		);
	});
});

describe("aux client-tool give-up arbitration (#278)", () => {
	let db: Database;
	let bus: EventEmitter;
	let cancels: Array<{ entryId: string; reason: string }>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		bus = new EventEmitter();
		cancels = [];
		bus.on("client_tool_call:cancel", (e: { entryId: string; reason: string }) => cancels.push(e));
	});

	afterEach(() => db.close());

	function makeLoop(): WaitProbeLoop {
		return new WaitProbeLoop(
			{ db, siteId: "site", hostName: "host", logger, eventBus: bus } as never,
			{} as never,
			{} as never,
			{ threadId: "aux-thread", userId: "user", connectionId: "conn-1" },
		);
	}

	function results(callId: string): Array<{ content: string; exit_code: number | null }> {
		return db
			.query(
				"SELECT content, exit_code FROM messages WHERE thread_id = 'aux-thread' AND role = 'tool_result' AND tool_name = ?",
			)
			.all(callId) as Array<{ content: string; exit_code: number | null }>;
	}

	function persistClientResult(callId: string, content: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"messages",
			{
				id: `res-${callId}`,
				thread_id: "aux-thread",
				role: "tool_result",
				content,
				model_id: null,
				tool_name: callId,
				created_at: now,
				modified_at: now,
				host_origin: "site",
				deleted: 0,
				exit_code: 0,
				metadata: null,
			},
			"site",
		);
	}

	it("expires the entry, writes exactly one reasoned result, and cancels the client on give-up", async () => {
		const loop = makeLoop();
		let entryId = "";
		bus.on("client_tool_call:created", (e: { entryId: string }) => {
			entryId = e.entryId;
			loop.abortNow();
		});

		await loop.runDeferred({ id: "call-A", name: "boundless_bash", input: { timeout: 600_000 } });

		expect(getClientToolCallStatus(db, entryId)).toBe("expired");
		const rows = results("call-A");
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toContain("aux loop was aborted");
		expect(cancels).toEqual([expect.objectContaining({ entryId, reason: "aborted" })]);
	});

	it("keeps the real result when the client returns before the give-up claims the entry", async () => {
		const loop = makeLoop();
		bus.on("client_tool_call:created", (e: { entryId: string }) => {
			// The WS handler persists and acks in one step; the abort lands in the
			// same tick, before the aux sees the result.
			persistClientResult("call-A", "real output");
			db.prepare("UPDATE dispatch_queue SET status = 'acknowledged' WHERE message_id = ?").run(
				e.entryId,
			);
			loop.abortNow();
		});

		await loop.runDeferred({ id: "call-A", name: "boundless_bash", input: {} });

		expect(results("call-A").map((r) => r.content)).toEqual(["real output"]);
		expect(cancels).toEqual([]);
	});

	it("reports a dropped session, not a timeout, when a reaper expires the entry without a result", async () => {
		const loop = makeLoop();
		bus.on("client_tool_call:created", (e: { entryId: string }) => {
			db.prepare("UPDATE dispatch_queue SET status = 'expired' WHERE message_id = ?").run(
				e.entryId,
			);
		});

		await loop.runDeferred({ id: "call-A", name: "boundless_bash", input: {} });

		const rows = results("call-A");
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toContain("lost its client session");
		expect(cancels).toEqual([]);
	});
});
