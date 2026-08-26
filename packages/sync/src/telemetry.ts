import { RELAY_KINDS, counter, histogram, upDownCounter } from "@bound/shared";
import { type Span, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";

interface CounterLike {
	add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface SpanLike {
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
	recordException(error: Error): void;
	setAttribute?(name: string, value: string | number | boolean): void;
	setStatus(status: { code: SpanStatusCode; message?: string }): void;
	end(): void;
}

const tracer = trace.getTracer("bound.sync");
const handshakes = counter("bound.sync.ws.handshakes", {
	description: "WebSocket handshakes by terminal outcome",
});
const drains = counter("bound.sync.replication.drains", {
	description: "Replication drain attempts by kind and outcome",
});
const drainedEntries = counter("bound.sync.replication.entries", {
	description: "Entries considered by replication drains",
});
const drainDuration = histogram("bound.sync.replication.drain.duration", {
	description: "Replication drain duration",
	unit: "ms",
});
const activeConnections = upDownCounter("bound.sync.ws.active_connections", {
	description: "Currently active replication WebSocket peers by endpoint role",
});

const noopCounter: CounterLike = { add() {} };
const noopSpan: SpanLike = {
	addEvent() {},
	recordException() {},
	setAttribute() {},
	setStatus() {},
	end() {},
};

export interface SyncTelemetry {
	handshakes: CounterLike;
	drains: CounterLike;
	drainedEntries: CounterLike;
	drainDuration: { record(value: number, attributes?: Record<string, string>): void };
	activeConnections: CounterLike;
	startSpan(
		name: "ws.handshake" | "replication.drain" | "relay.operation",
		attributes: Record<string, string | number | boolean>,
		parentContext?: import("@opentelemetry/api").Context,
	): SpanLike & Partial<Pick<Span, "spanContext">>;
	now?: () => number;
}

let telemetry: SyncTelemetry = {
	handshakes,
	drains,
	drainedEntries,
	drainDuration,
	activeConnections,
	startSpan: (name, attributes, parentContext) =>
		tracer.startSpan(name, { attributes }, parentContext ?? context.active()),
	now: () => performance.now(),
};

export function setSyncTelemetry(value?: SyncTelemetry): void {
	telemetry = value ?? {
		handshakes: noopCounter,
		drains: noopCounter,
		drainedEntries: noopCounter,
		drainDuration: { record() {} },
		activeConnections: noopCounter,
		startSpan: () => noopSpan,
		now: () => performance.now(),
	};
}

export interface HandshakeSpan {
	complete(outcome: "connected" | "failed" | "timeout", error?: unknown): void;
}

export interface DrainSpan {
	complete(outcome: "completed" | "empty" | "backpressured" | "skipped", entryCount: number): void;
	fail(error: unknown, entryCount?: number): void;
}

function errorValue(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function startWsHandshake(): HandshakeSpan {
	const span = telemetry.startSpan("ws.handshake", {});
	let ended = false;
	return {
		complete(outcome, error) {
			if (ended) return;
			ended = true;
			const failure = outcome !== "connected";
			if (error !== undefined) span.recordException(errorValue(error));
			span.addEvent("ws.handshake.complete", { outcome });
			telemetry.handshakes.add(1, { outcome });
			span.setStatus({
				code: failure ? SpanStatusCode.ERROR : SpanStatusCode.OK,
				...(failure ? { message: error === undefined ? outcome : errorValue(error).message } : {}),
			});
			span.end();
		},
	};
}

export function recordActiveConnection(role: "server" | "client", delta: 1 | -1): void {
	telemetry.activeConnections.add(delta, { role });
}

export function startReplicationDrain(
	kind: "changelog" | "relay_outbox" | "relay_inbox",
): DrainSpan {
	const span = telemetry.startSpan("replication.drain", { kind });
	const startedAt = (telemetry.now ?? performance.now)();
	let ended = false;
	const finish = (outcome: string, entryCount: number, error?: unknown): void => {
		if (ended) return;
		ended = true;
		const attributes = { kind, outcome };
		if (error !== undefined) span.recordException(errorValue(error));
		span.addEvent("replication.drain.complete", { outcome, entry_count: entryCount });
		telemetry.drains.add(1, attributes);
		if (entryCount > 0) telemetry.drainedEntries.add(entryCount, attributes);
		telemetry.drainDuration.record((telemetry.now ?? performance.now)() - startedAt, attributes);
		span.setStatus({
			code: error === undefined ? SpanStatusCode.OK : SpanStatusCode.ERROR,
			...(error === undefined ? {} : { message: errorValue(error).message }),
		});
		span.end();
	};
	return {
		complete: (outcome, entryCount) => finish(outcome, entryCount),
		fail: (error, entryCount = 0) => finish("failed", entryCount, error),
	};
}

export type RelayOperationDirection = "send" | "receive" | "deliver";

export interface RelayOperationSpan {
	run<T>(fn: () => T): T;
	complete(outcome: "inserted" | "duplicate" | "sent" | "delivered" | "backpressured"): void;
	fail(error: unknown): void;
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_KEY_PATTERN =
	/^(?:[a-z0-9][_0-9a-z*/-]{0,255}|[a-z0-9][_0-9a-z*/-]{0,240}@[a-z0-9][_0-9a-z*/-]{0,13})$/;

function validTracestate(value: string): boolean {
	if (value.length === 0 || value.length > 512) return false;
	const members = value.split(",");
	if (members.length > 32) return false;
	const seen = new Set<string>();
	for (const member of members) {
		const separator = member.indexOf("=");
		if (separator <= 0) return false;
		const key = member.slice(0, separator).trim();
		const memberValue = member.slice(separator + 1).trim();
		if (!TRACESTATE_KEY_PATTERN.test(key) || seen.has(key)) return false;
		if (memberValue.length === 0 || memberValue.length > 256) return false;
		for (const character of memberValue) {
			const code = character.charCodeAt(0);
			if (code < 0x20 || code > 0x7e || character === "," || character === "=") return false;
		}
		seen.add(key);
	}
	return true;
}

function validTraceCarrier(
	value?: string | null,
): { traceparent: string; tracestate?: string } | null {
	if (!value || value.length > 2048) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "traceparent" && key !== "tracestate"))
			return null;
		if (typeof record.traceparent !== "string") return null;
		const match = TRACEPARENT_PATTERN.exec(record.traceparent);
		if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
		if (record.tracestate !== undefined && typeof record.tracestate !== "string") return null;
		if (typeof record.tracestate === "string" && !validTracestate(record.tracestate)) return null;
		return {
			traceparent: record.traceparent,
			...(typeof record.tracestate === "string" ? { tracestate: record.tracestate } : {}),
		};
	} catch {
		return null;
	}
}

export type RelayTrigger = "push-write" | "receive" | "deliver" | "reconnect-drain";
export type RelayPath =
	| "spoke.outbox.push"
	| "hub.relay.receive"
	| "spoke.relay.deliver"
	| "spoke.outbox.drain";

const MAX_RELAY_ENTRY_COUNT = 10_000;

function boundedRelayKind(kind: string): string {
	return RELAY_KINDS.includes(kind as (typeof RELAY_KINDS)[number]) ? kind : "other";
}

function boundedEntryCount(entryCount: number): number {
	if (!Number.isFinite(entryCount)) return MAX_RELAY_ENTRY_COUNT;
	return Math.min(Math.max(Math.floor(entryCount), 0), MAX_RELAY_ENTRY_COUNT);
}

export function startRelayOperation(
	direction: RelayOperationDirection,
	options: {
		kind: string;
		traceContext?: string | null;
		trigger: RelayTrigger;
		path: RelayPath;
		entryCount: number;
	},
): RelayOperationSpan {
	const activeContext = context.active();
	const kind = boundedRelayKind(options.kind);
	const entryCount = boundedEntryCount(options.entryCount);
	const carrier = validTraceCarrier(options.traceContext);
	const activeSpanContext = trace.getSpan(activeContext)?.spanContext();
	const carrierState =
		carrier !== null
			? "extracted"
			: options.traceContext != null
				? "invalid"
				: activeSpanContext !== undefined && trace.isSpanContextValid(activeSpanContext)
					? "active"
					: "absent";
	const parentContext = carrier ? propagation.extract(activeContext, carrier) : activeContext;
	const span = telemetry.startSpan(
		"relay.operation",
		{
			"relay.trigger": options.trigger,
			"relay.path": options.path,
			"relay.direction": direction,
			"relay.kind": kind,
			"relay.carrier_state": carrierState,
			"relay.entry_count": entryCount,
		},
		parentContext,
	);
	const operationContext =
		typeof span.spanContext === "function"
			? trace.setSpan(parentContext, span as Span)
			: parentContext;
	let ended = false;
	return {
		run: (fn) => context.with(operationContext, fn),
		complete(outcome) {
			if (ended) return;
			ended = true;
			span.setAttribute?.("relay.outcome", outcome);
			span.addEvent("relay.operation.complete", { outcome });
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
		},
		fail(error) {
			if (ended) return;
			ended = true;
			const failure = errorValue(error);
			span.setAttribute?.("relay.outcome", "failed");
			span.recordException(failure);
			span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
			span.end();
		},
	};
}
