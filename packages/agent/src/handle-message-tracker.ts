/**
 * In-memory tracker for two long-lived span families that survive across
 * `web.handle-message` invocations:
 *
 * - `agent.handle-message` — one per logical message-handling cycle. Opened
 *   when the trigger is a user message / scheduler tick / notification /
 *   webhook; closed when the agent loop terminates AND no rows remain in
 *   `dispatch_queue` for the thread. Survives the gap between handler
 *   invocations created by client tool dispatches.
 *
 * - `tool.dispatch` — one per pending out-of-process tool dispatch (currently
 *   client tools delivered over WS). Opened when the agent enqueues a client
 *   tool call; carries the carrier injected into `tool:call`, so
 *   `client-tool.execute` (re-exported from bound-client) parents under it.
 *   Closed when the WS handler persists the matching `tool:result`, or when
 *   a cancellation path fires.
 *
 * Both families live only on the host that opened them. Process restart wipes
 * the tracker; spans in flight are dropped (BatchSpanProcessor cannot flush
 * what it doesn't have). This is intentional — see plan
 * `agent-handle-message-span.md` for the rationale on choosing in-memory
 * over DB-persisted SpanContext.
 */

import type { Database } from "bun:sqlite";
import type { Context, Span } from "@opentelemetry/api";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

/** Default watchdog timeout: spans inactive longer than this are closed with ERROR. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000;
/** Default watchdog poll cadence. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 60 * 1000;

interface OpenTurnState {
	span: Span;
	context: Context;
	threadId: string;
	openedAt: number;
	lastActivityAt: number;
}

interface OpenDispatchState {
	span: Span;
	context: Context;
	threadId: string;
	callId: string;
	openedAt: number;
	lastActivityAt: number;
}

export interface HandleMessageTrackerOptions {
	/** Override watchdog timeout for tests. */
	watchdogTimeoutMs?: number;
	/** Override watchdog poll interval. Set to 0 to disable the periodic sweep. */
	watchdogIntervalMs?: number;
	/** Test seam: override the tracer (default: `bound.agent-loop`). */
	tracerName?: string;
}

export class HandleMessageTracker {
	private readonly turns = new Map<string, OpenTurnState>();
	private readonly dispatches = new Map<string, OpenDispatchState>();
	private readonly watchdogTimeoutMs: number;
	private readonly watchdogIntervalMs: number;
	private readonly tracerName: string;
	private watchdogHandle: ReturnType<typeof setInterval> | null = null;

	constructor(options: HandleMessageTrackerOptions = {}) {
		this.watchdogTimeoutMs = options.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;
		this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
		this.tracerName = options.tracerName ?? "bound.agent-loop";
	}

	/** Start the periodic watchdog sweep. Idempotent. */
	startWatchdog(): void {
		if (this.watchdogHandle !== null) return;
		if (this.watchdogIntervalMs <= 0) return;
		this.watchdogHandle = setInterval(() => this.sweep(), this.watchdogIntervalMs);
		// Keep the process eligible for shutdown even if a watchdog is scheduled.
		this.watchdogHandle.unref?.();
	}

	/** Stop the watchdog. Idempotent. */
	stopWatchdog(): void {
		if (this.watchdogHandle !== null) {
			clearInterval(this.watchdogHandle);
			this.watchdogHandle = null;
		}
	}

	/**
	 * Get the currently-open `agent.handle-message` span context for a thread,
	 * or null if no cycle is open. Use to parent `web.handle-message` under it.
	 */
	getTurnContext(threadId: string): Context | null {
		const state = this.turns.get(threadId);
		if (!state) return null;
		state.lastActivityAt = Date.now();
		return state.context;
	}

	/**
	 * Open a fresh `agent.handle-message` span for this thread. If one is
	 * already open, close it first with status OK — this happens when a new
	 * user message arrives while a prior cycle's tool dispatches are still
	 * settling: the prior cycle is logically done, and the new user message
	 * starts a new logical cycle.
	 *
	 * The optional `parentContext` lets the caller propagate inbound trace
	 * context (e.g. from `client.send-message` carried on `message:send`)
	 * so the new span is parented under the originating trace.
	 */
	openTurn(threadId: string, parentContext?: Context): Context {
		const existing = this.turns.get(threadId);
		if (existing) {
			existing.span.setStatus({ code: SpanStatusCode.OK });
			existing.span.end();
			this.turns.delete(threadId);
		}
		const tracer = trace.getTracer(this.tracerName);
		const baseCtx = parentContext ?? context.active();
		const span = tracer.startSpan(
			"agent.handle-message",
			{ attributes: { "thread.id": threadId } },
			baseCtx,
		);
		const ctx = trace.setSpan(baseCtx, span);
		const now = Date.now();
		this.turns.set(threadId, {
			span,
			context: ctx,
			threadId,
			openedAt: now,
			lastActivityAt: now,
		});
		return ctx;
	}

	/**
	 * Touch the last-activity timestamp on the turn for this thread, if open.
	 * No-op when no turn is open. Use from `web.handle-message` enter/exit.
	 */
	touchTurn(threadId: string): void {
		const state = this.turns.get(threadId);
		if (state) state.lastActivityAt = Date.now();
	}

	/**
	 * End the `agent.handle-message` span for this thread. No-op if none open.
	 * `status: "ok" | "error"` controls the OTel status code; `reason` is set
	 * as `error.reason` attribute when status is error.
	 */
	closeTurn(threadId: string, status: "ok" | "error" = "ok", reason?: string): void {
		const state = this.turns.get(threadId);
		if (!state) return;
		if (status === "error") {
			state.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: reason,
			});
			if (reason) state.span.setAttribute("error.reason", reason);
		} else {
			state.span.setStatus({ code: SpanStatusCode.OK });
		}
		state.span.end();
		this.turns.delete(threadId);
	}

	/**
	 * Open a `tool.dispatch` span as a child of the open turn (or unparented
	 * if no turn is open — the tracker logs but proceeds). Returns the span's
	 * context so the caller can `injectTraceContext()` for the WS carrier.
	 *
	 * `callId` is the LLM-assigned tool_use id; uniquely identifies the
	 * dispatch for later close. Calling open with an in-flight callId
	 * replaces (and closes with ERROR) the prior state — guards against
	 * double-dispatch bugs.
	 */
	openDispatch(threadId: string, callId: string, toolName: string): Context {
		const existing = this.dispatches.get(callId);
		if (existing) {
			existing.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: "dispatch_replaced",
			});
			existing.span.setAttribute("error.reason", "dispatch_replaced");
			existing.span.end();
			this.dispatches.delete(callId);
		}
		const tracer = trace.getTracer(this.tracerName);
		const turn = this.turns.get(threadId);
		const parentCtx = turn?.context ?? context.active();
		const span = tracer.startSpan(
			"tool.dispatch",
			{
				attributes: {
					"thread.id": threadId,
					"tool.call_id": callId,
					"tool.name": toolName,
				},
			},
			parentCtx,
		);
		const ctx = trace.setSpan(parentCtx, span);
		const now = Date.now();
		this.dispatches.set(callId, {
			span,
			context: ctx,
			threadId,
			callId,
			openedAt: now,
			lastActivityAt: now,
		});
		if (turn) turn.lastActivityAt = now;
		return ctx;
	}

	/**
	 * Get the dispatch's context for a given callId, or null. Used when
	 * capturing the carrier for `tool:call` so the carrier identifies
	 * `tool.dispatch` (not `agent-loop.tool-execute`) as the parent.
	 */
	getDispatchContext(callId: string): Context | null {
		const state = this.dispatches.get(callId);
		if (!state) return null;
		state.lastActivityAt = Date.now();
		return state.context;
	}

	/**
	 * Close a `tool.dispatch` span. Status defaults to OK. No-op if not open.
	 */
	closeDispatch(callId: string, status: "ok" | "error" = "ok", reason?: string): void {
		const state = this.dispatches.get(callId);
		if (!state) return;
		if (status === "error") {
			state.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: reason,
			});
			if (reason) state.span.setAttribute("error.reason", reason);
		} else {
			state.span.setStatus({ code: SpanStatusCode.OK });
		}
		state.span.end();
		this.dispatches.delete(callId);
	}

	/**
	 * Close ALL open dispatches whose threadId matches. Used on thread
	 * cancellation paths where individual call IDs may be unknown to the
	 * caller. Status is always ERROR with the supplied reason.
	 */
	closeDispatchesForThread(threadId: string, reason: string): number {
		let count = 0;
		for (const [callId, state] of this.dispatches) {
			if (state.threadId !== threadId) continue;
			state.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
			state.span.setAttribute("error.reason", reason);
			state.span.end();
			this.dispatches.delete(callId);
			count++;
		}
		return count;
	}

	/**
	 * Close the `agent.handle-message` for `threadId` only if the cycle is
	 * idle: the dispatch_queue has no rows in `pending` or `processing` state
	 * for the thread.
	 *
	 * `client_tool_call` rows are INCLUDED in the count. They sit `pending`
	 * from the moment the agent enqueues a client tool until
	 * `acknowledgeClientToolCall` flips them to `acknowledged` — exactly the
	 * in-flight window during which the cycle must remain open. (An earlier
	 * incarnation of this query excluded them, which closed the turn the
	 * instant the first handler returned, fragmenting one logical message
	 * cycle into one trace per dispatch.) `tool_result` rows enqueued by
	 * the WS handler are flushed by `acknowledgeBatch` immediately before
	 * the resumed handler reaches this probe, so they don't keep the cycle
	 * open spuriously after the resumed handler completes its terminal turn.
	 *
	 * Returns true if the turn was closed, false otherwise.
	 */
	maybeCloseTurnIfIdle(
		db: Database,
		threadId: string,
		status: "ok" | "error" = "ok",
		errorReason?: string,
	): boolean {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS pending FROM dispatch_queue
				 WHERE thread_id = ?
				   AND status IN ('pending', 'processing')`,
			)
			.get(threadId) as { pending: number } | null;
		const pending = row?.pending ?? 0;
		if (pending > 0) return false;
		this.closeTurn(threadId, status, errorReason);
		return true;
	}

	/**
	 * Close every open span (turns and dispatches) with status OK. Used on
	 * graceful shutdown so `BatchSpanProcessor.forceFlush` exports them.
	 */
	endAllOpenSpans(reason = "shutdown"): void {
		for (const [callId, state] of this.dispatches) {
			state.span.setStatus({ code: SpanStatusCode.OK });
			state.span.setAttribute("end.reason", reason);
			state.span.end();
			this.dispatches.delete(callId);
		}
		for (const [threadId, state] of this.turns) {
			state.span.setStatus({ code: SpanStatusCode.OK });
			state.span.setAttribute("end.reason", reason);
			state.span.end();
			this.turns.delete(threadId);
		}
	}

	/** Test seam: enumerate currently-open turns. */
	listOpenTurns(): string[] {
		return [...this.turns.keys()];
	}

	/** Test seam: enumerate currently-open dispatches. */
	listOpenDispatches(): string[] {
		return [...this.dispatches.keys()];
	}

	/**
	 * Force-run the watchdog sweep. Returns the number of spans closed.
	 * Exposed for tests; production calls happen via the interval scheduler.
	 */
	sweep(now: number = Date.now()): number {
		let closed = 0;
		for (const [callId, state] of this.dispatches) {
			if (now - state.lastActivityAt > this.watchdogTimeoutMs) {
				state.span.setStatus({
					code: SpanStatusCode.ERROR,
					message: "watchdog_timeout",
				});
				state.span.setAttribute("error.reason", "watchdog_timeout");
				state.span.end();
				this.dispatches.delete(callId);
				closed++;
			}
		}
		for (const [threadId, state] of this.turns) {
			if (now - state.lastActivityAt > this.watchdogTimeoutMs) {
				state.span.setStatus({
					code: SpanStatusCode.ERROR,
					message: "watchdog_timeout",
				});
				state.span.setAttribute("error.reason", "watchdog_timeout");
				state.span.end();
				this.turns.delete(threadId);
				closed++;
			}
		}
		return closed;
	}
}
