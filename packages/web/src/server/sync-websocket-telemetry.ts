import { counter, histogram, upDownCounter } from "@bound/shared/telemetry-api";
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.web");

const upgrades = counter("bound.sync.websocket.upgrades", {
	description: "Inbound sync WebSocket upgrade attempts",
});
const accepted = counter("bound.sync.websocket.accepted", {
	description: "Accepted inbound sync WebSocket connections",
});
const rejected = counter("bound.sync.websocket.rejected", {
	description: "Rejected inbound sync WebSocket upgrade attempts",
});
const active = upDownCounter("bound.sync.websocket.active", {
	description: "Active inbound sync WebSocket connections",
});
const terminal = counter("bound.sync.websocket.terminal", {
	description: "Terminal outcomes for inbound sync WebSocket connections",
});
const duration = histogram("bound.sync.websocket.duration", {
	description: "Inbound sync WebSocket connection lifetime",
	unit: "s",
});

export interface SyncWebSocketAttempt {
	span: Span;
	startedAt: number;
	accepted: boolean;
	finalized: boolean;
}

export function startSyncWebSocketAttempt(now = performance.now()): SyncWebSocketAttempt {
	upgrades.add(1);
	return {
		span: tracer.startSpan("sync.websocket.connection", { kind: SpanKind.SERVER }),
		startedAt: now,
		accepted: false,
		finalized: false,
	};
}

export function acceptSyncWebSocketAttempt(attempt: SyncWebSocketAttempt, siteId: string): void {
	if (attempt.accepted || attempt.finalized) return;
	attempt.accepted = true;
	attempt.span.setAttribute("bound.sync.peer.site_id", siteId);
	accepted.add(1);
	active.add(1);
}

export function rejectSyncWebSocketAttempt(
	attempt: SyncWebSocketAttempt,
	outcome: "authentication" | "upgrade",
	error?: unknown,
	now = performance.now(),
): void {
	rejected.add(1, { outcome });
	finalize(attempt, `rejected_${outcome}`, error, now);
}

export function closeSyncWebSocketAttempt(
	attempt: SyncWebSocketAttempt,
	code: number,
	now = performance.now(),
): void {
	const outcome = code === 1000 || code === 1001 ? "closed_cleanly" : "closed_error";
	finalize(
		attempt,
		outcome,
		outcome === "closed_error" ? new Error(`WebSocket closed: ${code}`) : undefined,
		now,
	);
}

export function markSyncWebSocketAttemptError(attempt: SyncWebSocketAttempt, error: unknown): void {
	if (attempt.finalized) return;
	const exception = error instanceof Error ? error : new Error(String(error));
	attempt.span.recordException(exception);
	attempt.span.setStatus({ code: SpanStatusCode.ERROR });
}

function finalize(
	attempt: SyncWebSocketAttempt,
	outcome:
		| "rejected_authentication"
		| "rejected_upgrade"
		| "closed_cleanly"
		| "closed_error"
		| "error",
	error: unknown,
	now: number,
): void {
	if (attempt.finalized) return;
	attempt.finalized = true;
	if (attempt.accepted) active.add(-1);
	terminal.add(1, { outcome });
	duration.record(Math.max(0, now - attempt.startedAt) / 1000, { outcome });
	attempt.span.setAttribute("bound.sync.websocket.outcome", outcome);
	if (error !== undefined) {
		attempt.span.recordException(error instanceof Error ? error : new Error(String(error)));
		attempt.span.setStatus({ code: SpanStatusCode.ERROR });
	} else {
		attempt.span.setStatus({ code: SpanStatusCode.OK });
	}
	attempt.span.end();
}
