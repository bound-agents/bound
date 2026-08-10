import { describe, expect, it } from "bun:test";
import type { LoopToolExecutionBatch, ParsedResponse } from "@bound/loop";
import { AuxAgentLoop } from "../aux-agent-loop";
import type { BoundPreparedFrame } from "../bound-agent-loop";

class TestAuxAgentLoop extends AuxAgentLoop {
	invokeAfterToolPersistence(batch: LoopToolExecutionBatch) {
		return this.afterToolPersistence(
			{} as ParsedResponse,
			{ messages: [] } as unknown as BoundPreparedFrame,
			batch,
		);
	}
}

function makeLoop(): TestAuxAgentLoop {
	return new TestAuxAgentLoop(
		{
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		} as never,
		{} as never,
		{} as never,
		{ threadId: "aux-thread", userId: "user" },
	);
}

describe("AuxAgentLoop context rebuild", () => {
	it("requests a cold frame rebuild after a completed tool round", async () => {
		const loop = makeLoop();
		const decision = await loop.invokeAfterToolPersistence({
			deferred: [],
			results: [
				{
					toolCall: {
						id: "call-1",
						name: "query",
						input: { sql: "SELECT 1" },
					},
					result: { content: "1", exitCode: 0 },
				},
			],
		});

		expect(decision).toEqual({ action: "retry", rebuildFrame: true });
	});
});
