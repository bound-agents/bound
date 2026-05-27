/**
 * Property tests for the stream:chunk event bus emission in runLocalAgentLoop.
 *
 * Properties:
 *
 *   E1 Emission fidelity — every chunk passed to onStreamChunk by the agent
 *      loop is emitted on the event bus with the correct thread_id and
 *      byte-identical chunk payload.
 *
 *   E2 Thread isolation — chunks emitted carry exactly the thread_id of the
 *      running loop, never any other id.
 *
 *   E3 Timeout reset — stream chunks keep the inactivity timer alive. A loop
 *      that fires onStreamChunk within each timeout window completes without
 *      abort, even if total runtime exceeds the timeout.
 *
 *   E4 No spurious emissions — if onStreamChunk is never called (loop returns
 *      immediately), no stream:chunk events are emitted.
 */

import { describe, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentLoopResult } from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
import type { AgentLoop } from "@bound/agent";
import type { WsStreamChunk } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import fc from "fast-check";
import { runLocalAgentLoop } from "../lib/message-handler";

// Arbitrary for WsStreamChunk variants
const chunkArb: fc.Arbitrary<WsStreamChunk> = fc.oneof(
	fc.record({ type: fc.constant("text" as const), content: fc.string() }),
	fc.record({ type: fc.constant("thinking" as const), content: fc.string() }),
	fc.record({
		type: fc.constant("tool_use_start" as const),
		id: fc.string({ minLength: 1 }),
		name: fc.string({ minLength: 1 }),
	}),
	fc.record({
		type: fc.constant("tool_use_args" as const),
		id: fc.string({ minLength: 1 }),
		partial_json: fc.string(),
	}),
	fc.record({ type: fc.constant("tool_use_end" as const), id: fc.string({ minLength: 1 }) }),
	fc.record({
		type: fc.constant("done" as const),
		usage: fc.record({
			input_tokens: fc.nat(),
			output_tokens: fc.nat(),
			cache_write_tokens: fc.option(fc.nat(), { nil: null }),
			cache_read_tokens: fc.option(fc.nat(), { nil: null }),
			estimated: fc.boolean(),
		}),
	}),
	fc.record({ type: fc.constant("error" as const), error: fc.string({ minLength: 1 }) }),
);

describe("runLocalAgentLoop stream:chunk emission — property tests", () => {
	const controllers = new Map<string, AbortController>();

	it("E1: emission fidelity — chunk on event bus matches what onStreamChunk received", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(chunkArb, { minLength: 1, maxLength: 10 }), async (chunks) => {
				const eventBus = new TypedEventEmitter();
				const threadId = randomUUID();
				const emitted: Array<{ thread_id: string; chunk: WsStreamChunk }> = [];

				eventBus.on("stream:chunk", (data) => emitted.push(data));

				const factory = (config: AgentLoopConfig): AgentLoop =>
					({
						run: async (): Promise<AgentLoopResult> => {
							for (const chunk of chunks) {
								config.onStreamChunk?.(chunk);
							}
							return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
						},
					}) as AgentLoop;

				await runLocalAgentLoop({
					eventBus,
					threadId,
					userId: "u1",
					modelId: "mock",
					activeLoopAbortControllers: controllers,
					agentLoopFactory: factory as any,
				});

				if (emitted.length !== chunks.length) return false;
				return emitted.every((e, i) => JSON.stringify(e.chunk) === JSON.stringify(chunks[i]));
			}),
			{ numRuns: 50 },
		);
	});

	it("E2: thread isolation — every emitted event carries the loop's thread_id", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(chunkArb, { minLength: 1, maxLength: 5 }), async (chunks) => {
				const eventBus = new TypedEventEmitter();
				const threadId = randomUUID();
				const emitted: Array<{ thread_id: string; chunk: WsStreamChunk }> = [];

				eventBus.on("stream:chunk", (data) => emitted.push(data));

				const factory = (config: AgentLoopConfig): AgentLoop =>
					({
						run: async (): Promise<AgentLoopResult> => {
							for (const chunk of chunks) {
								config.onStreamChunk?.(chunk);
							}
							return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
						},
					}) as AgentLoop;

				await runLocalAgentLoop({
					eventBus,
					threadId,
					userId: "u1",
					modelId: "mock",
					activeLoopAbortControllers: controllers,
					agentLoopFactory: factory as any,
				});

				return emitted.every((e) => e.thread_id === threadId);
			}),
			{ numRuns: 50 },
		);
	});

	it("E3: timeout reset — stream chunks within each window prevent abort", async () => {
		// Generate a series of delays that are each LESS than the timeout,
		// but whose total exceeds it. The stream chunks should reset the
		// timer each time so the loop completes.
		const TIMEOUT_MS = 80;

		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 10, max: TIMEOUT_MS - 20 }), { minLength: 2, maxLength: 5 }),
				async (delays) => {
					const eventBus = new TypedEventEmitter();
					const threadId = randomUUID();
					const capturedSignals: AbortSignal[] = [];

					const factory = (config: AgentLoopConfig): AgentLoop => {
						if (config.abortSignal) capturedSignals.push(config.abortSignal);
						return {
							run: async (): Promise<AgentLoopResult> => {
								for (const delay of delays) {
									await new Promise((r) => setTimeout(r, delay));
									config.onStreamChunk?.({ type: "text", content: "tick" });
								}
								return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
							},
						} as AgentLoop;
					};

					await runLocalAgentLoop({
						eventBus,
						threadId,
						userId: "u1",
						modelId: "mock",
						activeLoopAbortControllers: controllers,
						agentLoopFactory: factory as any,
						timeoutMs: TIMEOUT_MS,
					});

					// Signal should NOT have been aborted
					return capturedSignals[0]?.aborted === false;
				},
			),
			{ numRuns: 20 },
		);
	});

	it("E4: no spurious emissions — immediate-return loop emits zero events", async () => {
		await fc.assert(
			fc.asyncProperty(fc.constant(null), async () => {
				const eventBus = new TypedEventEmitter();
				const threadId = randomUUID();
				const emitted: unknown[] = [];

				eventBus.on("stream:chunk", (data) => emitted.push(data));

				const factory = (_config: AgentLoopConfig): AgentLoop =>
					({
						run: async (): Promise<AgentLoopResult> => {
							return { messagesCreated: 0, toolCallsMade: 0, filesChanged: 0 };
						},
					}) as AgentLoop;

				await runLocalAgentLoop({
					eventBus,
					threadId,
					userId: "u1",
					modelId: "mock",
					activeLoopAbortControllers: controllers,
					agentLoopFactory: factory as any,
				});

				return emitted.length === 0;
			}),
			{ numRuns: 10 },
		);
	});
});
