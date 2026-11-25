import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { applySchema, findToolResultByThreadAndCallId } from "@bound/core";
import type {
	LoopToolExecutionBatch,
	ParsedResponse,
	ParsedToolCall,
	ToolExecutionResult,
} from "@bound/loop";
import { AuxAgentLoop } from "../aux-agent-loop";
import type { BoundPreparedFrame } from "../bound-agent-loop";
import type { EligibleHost } from "../delegation";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Records the relay hop instead of writing a real relay request. */
class RelayProbeLoop extends AuxAgentLoop {
	relayed: Array<{ callId: string; host: string }> = [];
	sessionWaits: Array<number | undefined> = [];
	protected override async relayDeferredClientTool(
		toolCall: ParsedToolCall,
		sessionHost: EligibleHost,
		sessionWaitMs?: number,
	): Promise<ToolExecutionResult> {
		this.relayed.push({ callId: toolCall.id, host: sessionHost.site_id });
		this.sessionWaits.push(sessionWaitMs);
		return { content: "relayed output", exitCode: 0, durationMs: 0 };
	}
	run1(call: { id: string; name: string; input: Record<string, unknown> }) {
		const frame = { messages: [] } as unknown as BoundPreparedFrame;
		const batch = {
			results: [],
			deferred: [{ toolCall: call }],
		} as unknown as LoopToolExecutionBatch;
		return this.afterToolPersistence({} as ParsedResponse, frame, batch).then(() => frame);
	}
}

describe("aux client tools relay to the parent's session host (#295)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, agent_id, parent_thread_id) VALUES ('aux', 'u', 'aux', 'local', ?, ?, ?, 0, 'agent', 'parent')",
			[now, now, now],
		);
		db.run(
			"INSERT INTO hosts (site_id, host_name, modified_at, online_at, deleted, work_spool_capable) VALUES ('msi', 'MSI', ?, ?, 0, 1)",
			[now, now],
		);
	});

	afterEach(() => db.close());

	function makeLoop(): RelayProbeLoop {
		return new RelayProbeLoop(
			{ db, siteId: "local", hostName: "local", logger, eventBus: new EventEmitter() } as never,
			{} as never,
			{} as never,
			{ threadId: "aux", userId: "u" },
		);
	}

	function addParentSession(siteId: string): void {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, deleted, modified_at) VALUES (?, 'conn', 'parent', ?, ?, 0, ?)",
			[`s-${siteId}`, siteId, now, now],
		);
	}

	it("relays a client tool to the parent's remote session host when no local connection exists", async () => {
		addParentSession("msi");
		const loop = makeLoop();

		const frame = await loop.run1({ id: "c1", name: "boundless_read", input: { path: "x" } });

		expect(loop.relayed).toEqual([{ callId: "c1", host: "msi" }]);
		expect(findToolResultByThreadAndCallId(db, "aux", "c1")?.content).toBe("relayed output");
		expect(frame.messages).toHaveLength(1);
	});

	it("sizes the relayed call's session-host wait from the call's own timeout (#278)", async () => {
		addParentSession("msi");
		const loop = makeLoop();

		await loop.run1({
			id: "c1",
			name: "boundless_bash",
			input: { command: "x", timeout: 600_000 },
		});
		await loop.run1({ id: "c2", name: "boundless_read", input: { path: "x" } });

		expect(loop.sessionWaits).toEqual([600_000 + 30_000, 300_000]);
	});

	it("still fails the call with a clear error when the parent has no session anywhere", async () => {
		const loop = makeLoop();

		await loop.run1({ id: "c1", name: "boundless_read", input: {} });

		expect(loop.relayed).toEqual([]);
		expect(findToolResultByThreadAndCallId(db, "aux", "c1")?.content).toContain(
			"needs a live client session",
		);
	});
});
