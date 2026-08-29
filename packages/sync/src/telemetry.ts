import {
	RELAY_KINDS,
	type SyncedTableName,
	counter,
	extractTraceContext,
	histogram,
	upDownCounter,
} from "@bound/shared";
import {
	type Context,
	type Span,
	SpanStatusCode,
	context,
	propagation,
	trace,
} from "@opentelemetry/api";

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
const backfillRuns = counter("bound.sync.backfill.runs", {
	description: "Backfill runs by trigger and outcome",
});
const backfillDuration = histogram("bound.sync.backfill.duration", {
	description: "Backfill run duration",
	unit: "ms",
});
const backfillSkipped = counter("bound.sync.backfill.skipped", {
	description: "Backfill attempts skipped by guard",
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
	backfillRuns?: CounterLike;
	backfillDuration?: {
		record(value: number, attributes?: Record<string, string | number | boolean>): void;
	};
	backfillSkipped?: CounterLike;
	startSpan(
		name:
			| "ws.handshake"
			| "replication.drain"
			| "relay.operation"
			| "sync.backfill"
			| "sync.consistency"
			| "sync.consistency.serve"
			| "sync.row-pull",
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
	backfillRuns,
	backfillDuration,
	backfillSkipped,
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

export type BackfillTrigger = "initial" | "reconnect" | "periodic";
export type BackfillSkipGuard = "running" | "cooldown";

export interface BackfillChildSpan {
	run<T>(fn: () => T): T;
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
	complete(attributes: Record<string, string | number | boolean>): void;
	fail(error: unknown, attributes?: Record<string, string | number | boolean>): void;
}

export interface BackfillSpan {
	run<T>(fn: () => T): T;
	consistency(): BackfillChildSpan;
	rowPull(): BackfillChildSpan;
	drift(table: SyncedTableName, localPushCount: number, remotePullRequestedCount: number): void;
	complete(counts: {
		localPushCount: number;
		remotePullRequestedCount: number;
		remotePullAppliedCount: number;
		driftTableCount: number;
	}): void;
	fail(error: unknown): void;
}

const BACKFILL_TABLES = new Set<SyncedTableName>([
	"users",
	"hosts",
	"cluster_config",
	"threads",
	"messages",
	"turns",
	"semantic_memory",
	"memory_edges",
	"tasks",
	"files",
	"advisories",
	"skills",
]);

function boundedBackfillTable(table: SyncedTableName): string {
	return BACKFILL_TABLES.has(table) ? table : "other";
}

export function startBackfill(trigger: BackfillTrigger): BackfillSpan {
	const span = telemetry.startSpan("sync.backfill", { "backfill.trigger": trigger });
	const startedAt = (telemetry.now ?? performance.now)();
	const operationContext =
		typeof span.spanContext === "function"
			? trace.setSpan(context.active(), span as Span)
			: context.active();
	const emittedDriftTables = new Set<string>();
	let ended = false;
	const startChild = (name: "sync.consistency" | "sync.row-pull"): BackfillChildSpan => {
		const child = telemetry.startSpan(name, {}, operationContext);
		let childEnded = false;
		const finish = (
			attributes: Record<string, string | number | boolean>,
			error?: unknown,
		): void => {
			if (childEnded) return;
			childEnded = true;
			for (const [key, value] of Object.entries(attributes)) child.setAttribute?.(key, value);
			if (error !== undefined) child.recordException(errorValue(error));
			child.setStatus({
				code: error === undefined ? SpanStatusCode.OK : SpanStatusCode.ERROR,
				...(error === undefined ? {} : { message: errorValue(error).message }),
			});
			child.end();
		};
		const childContext =
			typeof child.spanContext === "function"
				? trace.setSpan(operationContext, child as Span)
				: operationContext;
		return {
			run: (fn) => context.with(childContext, fn),
			addEvent: (name, attributes) => child.addEvent(name, attributes),
			complete: (attributes) => finish(attributes),
			fail: (error, attributes = {}) => finish(attributes, error),
		};
	};
	const finish = (
		outcome: "completed" | "failed",
		counts?: {
			localPushCount: number;
			remotePullRequestedCount: number;
			remotePullAppliedCount: number;
			driftTableCount: number;
		},
		error?: unknown,
	): void => {
		if (ended) return;
		ended = true;
		const attributes = { "backfill.trigger": trigger, "backfill.outcome": outcome };
		span.setAttribute?.("backfill.outcome", outcome);
		if (counts) {
			span.setAttribute?.("backfill.local_push_count", counts.localPushCount);
			span.setAttribute?.("backfill.remote_pull_requested_count", counts.remotePullRequestedCount);
			span.setAttribute?.("backfill.remote_pull_applied_count", counts.remotePullAppliedCount);
			span.setAttribute?.("backfill.drift_table_count", counts.driftTableCount);
		}
		if (error !== undefined) span.recordException(errorValue(error));
		telemetry.backfillRuns?.add(1, attributes);
		telemetry.backfillDuration?.record(
			(telemetry.now ?? performance.now)() - startedAt,
			attributes,
		);
		span.setStatus({
			code: error === undefined ? SpanStatusCode.OK : SpanStatusCode.ERROR,
			...(error === undefined ? {} : { message: errorValue(error).message }),
		});
		span.end();
	};
	return {
		run: (fn) => context.with(operationContext, fn),
		consistency: () => startChild("sync.consistency"),
		rowPull: () => startChild("sync.row-pull"),
		drift(table, localPushCount, remotePullRequestedCount) {
			const bounded = boundedBackfillTable(table);
			if (emittedDriftTables.has(bounded)) return;
			emittedDriftTables.add(bounded);
			span.addEvent("sync.backfill.drift", {
				table: bounded,
				local_push_count: localPushCount,
				remote_pull_requested_count: remotePullRequestedCount,
			});
		},
		complete: (counts) => finish("completed", counts),
		fail: (error) => finish("failed", undefined, error),
	};
}

startBackfill.skip = (guard: BackfillSkipGuard, trigger: BackfillTrigger): void => {
	telemetry.backfillSkipped?.add(1, { guard, trigger });
};

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

export type ConsistencyTraceCarrier = { traceparent: string; tracestate?: string };

export function validateConsistencyTraceCarrier(value: unknown): ConsistencyTraceCarrier | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "traceparent" && key !== "tracestate")) return null;
	return validTraceCarrier(JSON.stringify(record));
}

export function injectConsistencyTraceCarrier(): ConsistencyTraceCarrier | undefined {
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	return validateConsistencyTraceCarrier(carrier) ?? undefined;
}

const MAX_CONSISTENCY_SERVING_EVENT_OCCURRENCES = 3;

export interface ConsistencyServingSpan {
	requestReceived(): void;
	/** Present only for request-scoped collectors after this span has ended. */
	getTraceData?(): string | undefined;
	page(details: {
		countMs: number;
		selectMs: number;
		hashMs: number;
		encodeMs: number;
		sendMs: number;
		rows: number;
		cacheHitCount?: number;
		cacheMissCount?: number;
		tableIndex: number;
	}): void;
	backpressured(): void;
	resumed(delayMs: number): void;
	complete(terminal: "all_done"): void;
	fail(error: unknown): void;
}

export function startConsistencyServing(
	carrier?: unknown,
	startSpan?: (
		name: "sync.consistency.serve",
		attributes: Record<string, string | number | boolean>,
		parentContext: Context,
	) => SpanLike & Partial<Pick<Span, "spanContext">>,
	onEnd?: () => string | undefined,
): ConsistencyServingSpan {
	const activeContext = context.active();
	const validated = validateConsistencyTraceCarrier(carrier);
	const parentContext: Context = validated
		? extractRelayTraceContext(activeContext, validated)
		: activeContext;
	const span = (startSpan ?? telemetry.startSpan)(
		"sync.consistency.serve",
		{
			"consistency.serve.carrier_state": validated
				? "extracted"
				: carrier === undefined
					? "absent"
					: "invalid",
		},
		parentContext,
	);
	let pageCount = 0;
	let frameCount = 0;
	let rowCount = 0;
	let queryMs = 0;
	let countMs = 0;
	let selectMs = 0;
	let hashMs = 0;
	let encodeMs = 0;
	let sendMs = 0;
	let backpressureMs = 0;
	let drainResumeCount = 0;
	let firstPage = true;
	let pressureStartedAt: number | undefined;
	let ended = false;
	let traceData: string | undefined;
	const eventOccurrences = new Map<string, number>();
	const addBoundedEvent = (
		name: string,
		attributes?: Record<string, string | number | boolean>,
	): void => {
		const occurrences = eventOccurrences.get(name) ?? 0;
		if (occurrences >= MAX_CONSISTENCY_SERVING_EVENT_OCCURRENCES) return;
		eventOccurrences.set(name, occurrences + 1);
		span.addEvent(name, attributes);
	};
	const finish = (terminal: "all_done" | "error", error?: unknown): void => {
		if (ended) return;
		ended = true;
		span.setAttribute?.("consistency.serve.page_count", pageCount);
		span.setAttribute?.("consistency.serve.frame_count", frameCount);
		span.setAttribute?.("consistency.serve.row_count", rowCount);
		span.setAttribute?.("consistency.serve.table_count", tableIndexes.size);
		span.setAttribute?.("consistency.serve.query_duration_ms", queryMs);
		span.setAttribute?.("consistency.serve.count_duration_ms", countMs);
		span.setAttribute?.("consistency.serve.select_duration_ms", selectMs);
		span.setAttribute?.("consistency.serve.hash_duration_ms", hashMs);
		span.setAttribute?.("consistency.serve.encode_duration_ms", encodeMs);
		span.setAttribute?.("consistency.serve.send_duration_ms", sendMs);
		span.setAttribute?.("consistency.serve.backpressure_duration_ms", backpressureMs);
		span.setAttribute?.("consistency.serve.drain_resume_count", drainResumeCount);
		span.setAttribute?.("consistency.serve.terminal", terminal);
		if (error !== undefined) span.recordException(errorValue(error));
		span.addEvent(`sync.consistency.serve.${terminal}`);
		span.setStatus({
			code: error === undefined ? SpanStatusCode.OK : SpanStatusCode.ERROR,
			...(error === undefined ? {} : { message: errorValue(error).message }),
		});
		span.end();
		traceData = onEnd?.();
	};
	const now = () => (telemetry.now ?? performance.now)();
	const tableIndexes = new Set<number>();
	return {
		getTraceData: () => traceData,
		requestReceived: () => span.addEvent("sync.consistency.serve.request_received"),
		page(details) {
			pageCount++;
			frameCount++;
			rowCount += details.rows;
			tableIndexes.add(details.tableIndex);
			// The compatibility aggregate covers the full per-page serving work exactly once:
			// count query + row select + content-hash computation.
			queryMs += details.countMs + details.selectMs + details.hashMs;
			countMs += details.countMs;
			selectMs += details.selectMs;
			hashMs += details.hashMs;
			encodeMs += details.encodeMs;
			sendMs += details.sendMs;
			if (firstPage) {
				firstPage = false;
				span.addEvent("sync.consistency.serve.first_page", {
					table_index: details.tableIndex,
					row_count: details.rows,
				});
			}
			// Keep slow-query alerts scoped to the database stages they historically measured;
			// hashing remains visible in the aggregate and its dedicated duration attribute.
			const databasePageMs = details.countMs + details.selectMs;
			if (databasePageMs > 1_000)
				addBoundedEvent("sync.consistency.serve.slow_query", { duration_ms: databasePageMs });
			if (details.encodeMs > 1_000)
				addBoundedEvent("sync.consistency.serve.slow_encode", { duration_ms: details.encodeMs });
			if (details.sendMs > 1_000)
				addBoundedEvent("sync.consistency.serve.slow_send", { duration_ms: details.sendMs });
			span.setAttribute?.("consistency.serve.table_count", tableIndexes.size);
			if (details.cacheHitCount !== undefined)
				span.setAttribute?.("consistency.serve.cache_hit_count", details.cacheHitCount);
			if (details.cacheMissCount !== undefined)
				span.setAttribute?.("consistency.serve.cache_miss_count", details.cacheMissCount);
		},
		backpressured() {
			if (pressureStartedAt === undefined) {
				pressureStartedAt = now();
				addBoundedEvent("sync.consistency.serve.send_backpressure");
			}
		},
		resumed(delayMs) {
			drainResumeCount++;
			backpressureMs += delayMs;
			pressureStartedAt = undefined;
			addBoundedEvent("sync.consistency.serve.drain_resume", {
				delay_ms: delayMs,
				count: drainResumeCount,
			});
		},
		complete: () => finish("all_done"),
		fail: (error) => finish("error", error),
	};
}

function extractRelayTraceContext(
	activeContext: import("@opentelemetry/api").Context,
	carrier: { traceparent: string; tracestate?: string },
): import("@opentelemetry/api").Context {
	const propagated = propagation.extract(activeContext, carrier);
	const propagatedSpan = trace.getSpan(propagated)?.spanContext();
	if (propagatedSpan && trace.isSpanContextValid(propagatedSpan)) return propagated;
	return extractTraceContext(carrier);
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
	const parentContext = carrier ? extractRelayTraceContext(activeContext, carrier) : activeContext;
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
