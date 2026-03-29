/**
 * Extracted, testable core of the message:created handler's local-run path.
 *
 * This module contains the AbortController setup, timeout, agent:cancel wiring,
 * and cleanup so the behaviour can be verified in unit tests without starting
 * the full web server.
 */
import type { AgentLoopResult } from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
import type { AgentLoop } from "@bound/agent";
import type { TypedEventEmitter } from "@bound/shared";

export interface RunLocalLoopParams {
	eventBus: TypedEventEmitter;
	threadId: string;
	userId: string;
	modelId: string;
	activeLoopAbortControllers: Map<string, AbortController>;
	agentLoopFactory: (config: AgentLoopConfig) => AgentLoop;
	/** Override for the 5-minute LLM timeout (milliseconds). Defaults to 300_000. */
	timeoutMs?: number;
}

export interface RunLocalLoopResult {
	agentResult: AgentLoopResult;
	/** AbortSignal that was handed to the agent loop. */
	signal: AbortSignal;
}

/**
 * Runs a single agent loop locally with AbortController wiring for:
 * - agent:cancel events targeted at the thread
 * - a configurable LLM-response timeout
 *
 * Guarantees cleanup (clearTimeout, off("agent:cancel"), map.delete) even on
 * error via a finally block.
 */
export async function runLocalAgentLoop(
	params: RunLocalLoopParams,
): Promise<RunLocalLoopResult> {
	const {
		eventBus,
		threadId,
		userId,
		modelId,
		activeLoopAbortControllers,
		agentLoopFactory,
		timeoutMs = 5 * 60 * 1000,
	} = params;

	const abortController = new AbortController();
	activeLoopAbortControllers.set(threadId, abortController);

	const timeoutId = setTimeout(() => {
		abortController.abort(new Error("LLM response timeout"));
	}, timeoutMs);

	const onCancel = (payload: { thread_id: string }): void => {
		if (payload.thread_id === threadId) {
			abortController.abort();
		}
	};
	eventBus.on("agent:cancel", onCancel);

	try {
		const agentLoop = agentLoopFactory({
			threadId,
			userId,
			modelId,
			abortSignal: abortController.signal,
		});
		const agentResult = await agentLoop.run();
		return { agentResult, signal: abortController.signal };
	} finally {
		clearTimeout(timeoutId);
		eventBus.off("agent:cancel", onCancel);
		activeLoopAbortControllers.delete(threadId);
	}
}
