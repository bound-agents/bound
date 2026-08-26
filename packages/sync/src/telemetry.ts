import { counter, histogram, upDownCounter } from "@bound/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";

interface CounterLike {
	add(value: number, attributes?: Record<string, string | number>): void;
}

interface SpanLike {
	addEvent(name: string, attributes?: Record<string, string | number>): void;
	recordException(error: Error): void;
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
		name: "ws.handshake" | "replication.drain",
		attributes: Record<string, string>,
	): SpanLike;
	now?: () => number;
}

let telemetry: SyncTelemetry = {
	handshakes,
	drains,
	drainedEntries,
	drainDuration,
	activeConnections,
	startSpan: (name, attributes) => tracer.startSpan(name, { attributes }),
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
