import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applySchema,
	enqueueNotification,
	enqueueToolResult,
	insertRow,
	setDurableDispatchEnqueueEnabledForTesting,
} from "@bound/core";
import { AuxAgentLoop, isAuxLoopRunning, registerRunningAuxLoop } from "../aux-agent-loop";
import type { BoundPreparedFrame } from "../bound-agent-loop";
import { createNotifyTool } from "../tools/notify";
import type { ToolContext } from "../types";

const STOP = new Error("stop-after-drain");

class DrainProbeLoop extends AuxAgentLoop {
	drain(): number {
		return this.drainPendingNotifications();
	}
	// Stop prepareFrame right after its drain step; the rest needs a router.
	protected override prepareSharedFrameInputs(): never {
		throw STOP;
	}
	buildFrame(): Promise<unknown> {
		return this.prepareFrame({ resolution: {} as BoundPreparedFrame["resolution"] });
	}
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function insertThread(db: Database, id: string, agentId: string | null): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: "user",
			interface: agentId ? "aux" : "web",
			host_origin: "site",
			title: "t",
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			agent_id: agentId,
		},
		"site",
	);
}

describe("aux loop notification delivery (#294)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		setDurableDispatchEnqueueEnabledForTesting(true);
		insertThread(db, "aux-thread", "agent-1");
		insertThread(db, "main-thread", null);
	});

	afterEach(() => {
		db.close();
	});

	function makeLoop(): DrainProbeLoop {
		return new DrainProbeLoop(
			{ db, siteId: "site", hostName: "host", logger } as never,
			{} as never,
			{} as never,
			{ threadId: "aux-thread", userId: "user" },
		);
	}

	function developerRows(): string[] {
		return (
			db
				.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'developer'")
				.all("aux-thread") as Array<{ content: string }>
		).map((r) => r.content);
	}

	function workStates(): Array<{ event_type: string; claim_state: string }> {
		return db
			.query(
				"SELECT json_extract(payload, '$.event_type') AS event_type, claim_state FROM durable_work WHERE json_extract(payload, '$.thread_id') = 'aux-thread' ORDER BY event_type",
			)
			.all() as Array<{ event_type: string; claim_state: string }>;
	}

	it("injects a pending notification before the next model call and consumes the row", async () => {
		enqueueNotification(db, "aux-thread", { type: "proactive", content: "batch your tool calls" });

		await expect(makeLoop().buildFrame()).rejects.toBe(STOP);

		const rows = developerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("batch your tool calls");
		expect(workStates()).toEqual([{ event_type: "notification", claim_state: "consumed" }]);
	});

	it("never claims tool_result wakeups owned by the inline client-tool resolver", () => {
		enqueueToolResult(db, "aux-thread", "call-1");
		enqueueNotification(db, "aux-thread", { type: "proactive", content: "steer" });

		expect(makeLoop().drain()).toBe(1);

		expect(workStates()).toEqual([
			{ event_type: "notification", claim_state: "consumed" },
			{ event_type: "tool_result", claim_state: "pending" },
		]);
	});

	describe("notify tool", () => {
		function notifyCtx(): ToolContext {
			return {
				db,
				siteId: "site",
				eventBus: { on() {}, off() {}, emit() {}, once() {} } as never,
				logger,
				threadId: "main-thread",
			};
		}

		it("refuses an aux thread with no running loop instead of claiming delivery", async () => {
			const out = await createNotifyTool(notifyCtx()).execute({
				thread_id: "aux-thread",
				message: "stop doing X",
			});

			expect(String(out)).toStartWith("Error:");
			expect(workStates()).toEqual([]);
		});

		it("queues for a running aux loop and says the loop delivers it", async () => {
			const release = registerRunningAuxLoop("aux-thread");
			try {
				expect(isAuxLoopRunning("aux-thread")).toBe(true);
				const out = await createNotifyTool(notifyCtx()).execute({
					thread_id: "aux-thread",
					message: "stop doing X",
				});
				expect(String(out)).toContain("running aux thread");
				expect(workStates()).toEqual([{ event_type: "notification", claim_state: "pending" }]);
				expect(makeLoop().drain()).toBe(1);
			} finally {
				release();
			}
			expect(isAuxLoopRunning("aux-thread")).toBe(false);
		});
	});
});
