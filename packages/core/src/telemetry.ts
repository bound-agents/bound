import { counter, histogram } from "@bound/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";

interface CounterLike {
	add(value: number, attributes?: Record<string, string | number>): void;
}

interface SpanLike {
	addEvent?(name: string, attributes?: Record<string, string | number | boolean>): void;
	recordException?(error: Error): void;
	setAttribute?(name: string, value: string | number | boolean): void;
	setStatus?(status: { code: SpanStatusCode; message?: string }): void;
	end(): void;
}

const tracer = trace.getTracer("bound.core");
const changeLogTransactions = counter("bound.core.changelog.transactions", {
	description: "Change-log transactions by outcome",
});
const changeLogPostcommitEvents = counter("bound.core.changelog.postcommit_events", {
	description: "Change-log post-commit event delivery outcomes",
});
const relayOutboxOperations = counter("bound.core.relay_outbox.operations", {
	description: "Relay outbox persistence operations by outcome",
});
const relayOutboxOperationDuration = histogram("bound.core.relay_outbox.operation.duration", {
	description: "Relay outbox persistence operation duration",
	unit: "ms",
});

const noopCounter: CounterLike = { add() {} };
const noopSpan: SpanLike = {
	addEvent() {},
	recordException() {},
	setAttribute() {},
	setStatus() {},
	end() {},
};

export interface CoreTelemetry {
	changeLogTransactions: CounterLike;
	changeLogPostcommitEvents: CounterLike;
	relayOutboxOperations: CounterLike;
	relayOutboxOperationDuration: {
		record(value: number, attributes?: Record<string, string>): void;
	};
	startSpan(
		name: "changelog.transaction" | "relay_outbox.operation",
		attributes?: Record<string, string | number | boolean>,
	): SpanLike;
}

let telemetry: CoreTelemetry = {
	changeLogTransactions,
	changeLogPostcommitEvents,
	relayOutboxOperations,
	relayOutboxOperationDuration,
	startSpan: (name, attributes) => tracer.startSpan(name, { attributes }),
};

export function setCoreTelemetry(value?: CoreTelemetry): void {
	telemetry = value ?? {
		changeLogTransactions: noopCounter,
		changeLogPostcommitEvents: noopCounter,
		relayOutboxOperations: noopCounter,
		relayOutboxOperationDuration: { record() {} },
		startSpan: () => noopSpan,
	};
}

export function withCoreSpan<T>(
	name: "changelog.transaction" | "relay_outbox.operation",
	fn: (span: SpanLike) => T,
): T;
export function withCoreSpan<T>(
	name: "changelog.transaction" | "relay_outbox.operation",
	attributes: Record<string, string | number | boolean>,
	fn: (span: SpanLike) => T,
): T;
export function withCoreSpan<T>(
	name: "changelog.transaction" | "relay_outbox.operation",
	attributesOrFn: Record<string, string | number | boolean> | ((span: SpanLike) => T),
	maybeFn?: (span: SpanLike) => T,
): T {
	const attributes = typeof attributesOrFn === "function" ? undefined : attributesOrFn;
	const fn = typeof attributesOrFn === "function" ? attributesOrFn : maybeFn;
	if (!fn) throw new TypeError("withCoreSpan requires a callback");
	const span = telemetry.startSpan(name, attributes);
	try {
		const result = fn(span);
		span.setStatus?.({ code: SpanStatusCode.OK });
		return result;
	} catch (error) {
		span.recordException?.(error instanceof Error ? error : new Error(String(error)));
		span.setStatus?.({
			code: SpanStatusCode.ERROR,
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		span.end();
	}
}

export function recordChangeLogTransaction(outcome: "committed" | "failed"): void {
	telemetry.changeLogTransactions.add(1, { outcome });
}

export function recordChangeLogPostcommitEvent(outcome: "succeeded" | "failed"): void {
	telemetry.changeLogPostcommitEvents.add(1, { outcome });
}

export function recordRelayOutboxOperation(
	operation: "read" | "write" | "ack" | "drain",
	outcome:
		| "hit"
		| "miss"
		| "failed"
		| "inserted"
		| "duplicate"
		| "delivered"
		| "sent"
		| "backpressured",
	count = 1,
	durationMs?: number,
): void {
	const attributes = { operation, outcome };
	telemetry.relayOutboxOperations.add(count, attributes);
	if (durationMs !== undefined)
		telemetry.relayOutboxOperationDuration.record(durationMs, attributes);
}
