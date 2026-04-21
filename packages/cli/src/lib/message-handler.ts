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
	/** Cooperative cancellation: checked at yield points in the agent loop. */
	shouldYield?: () => boolean;
	/** Platform identifier for platform-scoped threads (e.g. "discord"). */
	platform?: string;
	/** Platform-specific tools (e.g. discord_send_message). */
	platformTools?: AgentLoopConfig["platformTools"];
	/** Client tools from WS connections subscribed to this thread. */
	clientTools?: AgentLoopConfig["clientTools"];
	/** Connection ID for the WS connection that provided client tools. */
	connectionId?: string;
	/** Optional system prompt addition from the WebSocket connection. */
	systemPromptAddition?: string;
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
/**
 * Resolves the model to use for a thread by reading threads.model_hint.
 * Falls back to nodeDefault when model_hint is NULL or thread doesn't exist.
 */
export function resolveThreadModel(
	db: import("bun:sqlite").Database,
	threadId: string,
	nodeDefault: string,
): string {
	const row = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
		model_hint: string | null;
	} | null;
	return row?.model_hint ?? nodeDefault;
}

export async function runLocalAgentLoop(params: RunLocalLoopParams): Promise<RunLocalLoopResult> {
	const {
		eventBus,
		threadId,
		userId,
		modelId,
		activeLoopAbortControllers,
		agentLoopFactory,
		// Outer inactivity timeout. Must be longer than the inner stream-level
		// silence budget in agent-loop.ts (SILENCE_TIMEOUT_MS * MAX_SILENCE_RETRIES
		// = 10min * 3 = 30min worst case) so the inner retry logic gets a chance
		// to recover before we tear down the whole request. Default 35min = 30min
		// inner budget + 5min grace for pre-stream context assembly, capability
		// resolution, and tool execution between turns.
		timeoutMs = 35 * 60 * 1000,
		shouldYield,
		platform,
		platformTools,
		clientTools,
		connectionId,
		systemPromptAddition,
	} = params;

	const abortController = new AbortController();
	activeLoopAbortControllers.set(threadId, abortController);

	// Resettable inactivity timeout — restarted each time the loop signals activity.
	let timeoutId = setTimeout(() => {
		abortController.abort(new Error("LLM response timeout"));
	}, timeoutMs);

	const resetTimeout = (): void => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => {
			abortController.abort(new Error("LLM response timeout"));
		}, timeoutMs);
	};

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
			onActivity: resetTimeout,
			shouldYield,
			platform,
			platformTools,
			clientTools,
			connectionId,
			systemPromptAddition,
		});
		const agentResult = await agentLoop.run();
		return { agentResult, signal: abortController.signal };
	} finally {
		clearTimeout(timeoutId);
		eventBus.off("agent:cancel", onCancel);
		activeLoopAbortControllers.delete(threadId);
	}
}
