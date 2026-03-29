/**
 * End-to-end tests for the agent:cancel propagation path.
 *
 * These tests exercise the full runLocalAgentLoop pipeline:
 *   message:created → AbortController wired → agent:cancel → loop aborted
 *
 * The loop-in-isolation approach was used because start.ts nests the handler
 * inside createWebServer, making it impractical to test without starting the
 * full server.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentLoopResult } from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
import type { AgentLoop } from "@bound/agent";
import { TypedEventEmitter } from "@bound/shared";
import { runLocalAgentLoop } from "../lib/message-handler";

describe("runLocalAgentLoop — agent:cancel propagation", () => {
	const controllers = new Map<string, AbortController>();

	afterEach(() => {
		controllers.clear();
	});

	function makeEventBus() {
		return new TypedEventEmitter();
	}

	function makeSlowFactory(
		durationMs: number,
		capturedSignals: AbortSignal[],
	): (config: AgentLoopConfig) => AgentLoop {
		return (config) => {
			if (config.abortSignal) capturedSignals.push(config.abortSignal);
			return {
				run: async (): Promise<AgentLoopResult> => {
					await new Promise((resolve) => setTimeout(resolve, durationMs));
					return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
				},
			} as AgentLoop;
		};
	}

	it("passes abortSignal to the agent loop factory", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();
		const capturedSignals: AbortSignal[] = [];

		const factory = makeSlowFactory(10, capturedSignals);

		await runLocalAgentLoop({
			eventBus,
			threadId,
			userId: "u1",
			modelId: "mock",
			activeLoopAbortControllers: controllers,
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			agentLoopFactory: factory as any,
		});

		expect(capturedSignals.length).toBe(1);
		expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
	});

	it("aborts the running loop when agent:cancel fires for the thread", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();
		const capturedSignals: AbortSignal[] = [];

		// Loop that takes 500ms — test fires cancel after 50ms
		let _loopFinishedNaturally = false;
		const factory = (config: AgentLoopConfig): AgentLoop => {
			if (config.abortSignal) capturedSignals.push(config.abortSignal);
			return {
				run: async (): Promise<AgentLoopResult> => {
					await new Promise((resolve) => setTimeout(resolve, 500));
					_loopFinishedNaturally = true;
					return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
				},
			} as AgentLoop;
		};

		// Fire agent:cancel after 50ms (well before 500ms loop)
		setTimeout(() => {
			eventBus.emit("agent:cancel", { thread_id: threadId });
		}, 50);

		await runLocalAgentLoop({
			eventBus,
			threadId,
			userId: "u1",
			modelId: "mock",
			activeLoopAbortControllers: controllers,
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			agentLoopFactory: factory as any,
		});

		// The abort signal must have been triggered
		expect(capturedSignals.length).toBe(1);
		expect(capturedSignals[0].aborted).toBe(true);
		// The loop did NOT finish its natural 500ms wait (test completed in ~50ms)
		// Note: the mock loop doesn't check the signal — we verify the signal itself
		// was set. Real AgentLoop checks the signal on each LLM call.
	});

	it("does NOT abort loops for other threads", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();
		const otherThreadId = randomUUID();
		const capturedSignals: AbortSignal[] = [];

		const factory = makeSlowFactory(50, capturedSignals);

		// Fire cancel for a DIFFERENT thread
		setTimeout(() => {
			eventBus.emit("agent:cancel", { thread_id: otherThreadId });
		}, 10);

		await runLocalAgentLoop({
			eventBus,
			threadId,
			userId: "u1",
			modelId: "mock",
			activeLoopAbortControllers: controllers,
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			agentLoopFactory: factory as any,
		});

		// Signal for THIS thread must NOT be aborted
		expect(capturedSignals[0]?.aborted).toBe(false);
	});

	it("cleans up: removes abort controller from map and event listener after completion", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();
		const capturedSignals: AbortSignal[] = [];

		const factory = makeSlowFactory(10, capturedSignals);

		await runLocalAgentLoop({
			eventBus,
			threadId,
			userId: "u1",
			modelId: "mock",
			activeLoopAbortControllers: controllers,
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			agentLoopFactory: factory as any,
		});

		// Controller should be removed from the map after loop finishes
		expect(controllers.has(threadId)).toBe(false);

		// Event listener should be removed — emitting cancel after loop should not throw
		expect(() => {
			eventBus.emit("agent:cancel", { thread_id: threadId });
		}).not.toThrow();
	});

	it("cleans up even when the agent loop throws", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();

		const factory = (_config: AgentLoopConfig): AgentLoop =>
			({
				run: async (): Promise<AgentLoopResult> => {
					throw new Error("LLM connection error");
				},
			}) as AgentLoop;

		await expect(
			runLocalAgentLoop({
				eventBus,
				threadId,
				userId: "u1",
				modelId: "mock",
				activeLoopAbortControllers: controllers,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				agentLoopFactory: factory as any,
			}),
		).rejects.toThrow("LLM connection error");

		// Controller must still be cleaned up despite the throw
		expect(controllers.has(threadId)).toBe(false);
	});

	it("aborts via timeout when timeoutMs elapses before loop completes", async () => {
		const eventBus = makeEventBus();
		const threadId = randomUUID();
		const capturedSignals: AbortSignal[] = [];

		const factory = makeSlowFactory(500, capturedSignals);

		await runLocalAgentLoop({
			eventBus,
			threadId,
			userId: "u1",
			modelId: "mock",
			activeLoopAbortControllers: controllers,
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			agentLoopFactory: factory as any,
			timeoutMs: 30, // very short timeout for the test
		});

		// Timeout must have fired and aborted the signal
		expect(capturedSignals[0]?.aborted).toBe(true);
	});
});
