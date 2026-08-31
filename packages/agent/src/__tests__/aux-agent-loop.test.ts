import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
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

	placeCacheMarkerForRequest(messages: LLMMessage[], cacheCapable: boolean) {
		return this.prepareAuxCacheMarker(
			messages,
			cacheCapable ? ({ cache: true } as never) : undefined,
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

	it("places and records a cache marker for a cache-capable aux request frame", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "inspect the prompt cache path" },
			{ role: "assistant", content: "I will inspect it." },
			{ role: "user", content: "report the result" },
		];

		const placement = makeLoop().placeCacheMarkerForRequest(messages, true);

		expect(messages.some((message) => message.role === "cache")).toBe(true);
		expect(placement.placed).toBe(true);
	});

	it("does not place a marker when the aux backend cannot cache", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "hello" }];

		const placement = makeLoop().placeCacheMarkerForRequest(messages, false);

		expect(messages.some((message) => message.role === "cache")).toBe(false);
		expect(placement.placed).toBe(false);
	});
});
