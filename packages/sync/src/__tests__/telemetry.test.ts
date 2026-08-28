import { afterEach, describe, expect, it } from "bun:test";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	setSyncTelemetry,
	startBackfill,
	startRelayOperation,
	startReplicationDrain,
	startWsHandshake,
} from "../telemetry";

function harness() {
	const spans: Array<{
		name: string;
		attributes: Record<string, string | number | boolean>;
		events: Array<{ name: string; attributes?: Record<string, string | number> }>;
		exceptions: Error[];
		statuses: Array<{ code: SpanStatusCode; message?: string }>;
		ends: number;
	}> = [];
	const counters = {
		handshakes: [] as unknown[],
		drains: [] as unknown[],
		entries: [] as unknown[],
		backfillRuns: [] as unknown[],
		backfillSkipped: [] as unknown[],
	};
	const durations: Array<{ value: number; attributes?: Record<string, string> }> = [];
	const backfillDurations: Array<{
		value: number;
		attributes?: Record<string, string | number | boolean>;
	}> = [];
	let now = 10;
	setSyncTelemetry({
		handshakes: { add: (value, attributes) => counters.handshakes.push({ value, attributes }) },
		drains: { add: (value, attributes) => counters.drains.push({ value, attributes }) },
		drainedEntries: { add: (value, attributes) => counters.entries.push({ value, attributes }) },
		drainDuration: { record: (value, attributes) => durations.push({ value, attributes }) },
		backfillRuns: { add: (value, attributes) => counters.backfillRuns.push({ value, attributes }) },
		backfillSkipped: {
			add: (value, attributes) => counters.backfillSkipped.push({ value, attributes }),
		},
		backfillDuration: {
			record: (value, attributes) => backfillDurations.push({ value, attributes }),
		},
		startSpan(name, attributes, parentContext) {
			const state = {
				name,
				attributes,
				parentContext,
				events: [],
				exceptions: [],
				statuses: [],
				ends: 0,
			} as (typeof spans)[number] & { parentContext: import("@opentelemetry/api").Context };
			spans.push(state);
			return {
				addEvent: (eventName, eventAttributes) =>
					state.events.push({ name: eventName, attributes: eventAttributes }),
				recordException: (error) => state.exceptions.push(error),
				setAttribute: (name, value) => {
					state.attributes[name] = value;
				},
				setStatus: (status) => state.statuses.push(status),
				end: () => state.ends++,
			};
		},
		now: () => now,
	});
	return {
		spans,
		counters,
		durations,
		backfillDurations,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

afterEach(() => setSyncTelemetry());

describe("sync telemetry operation lifetimes", () => {
	it("keeps the WebSocket handshake span open until its terminal outcome", () => {
		const h = harness();
		const operation = startWsHandshake();
		expect(h.spans).toHaveLength(1);
		expect(h.spans[0].ends).toBe(0);
		operation.complete("connected");
		expect(h.spans[0].events).toEqual([
			{ name: "ws.handshake.complete", attributes: { outcome: "connected" } },
		]);
		expect(h.spans[0].ends).toBe(1);
		operation.complete("failed");
		expect(h.spans[0].ends).toBe(1);
		expect(h.counters.handshakes).toHaveLength(1);
	});

	it("records handshake failures on the existing parent span", () => {
		const h = harness();
		const failure = new Error("upgrade failed");
		const operation = startWsHandshake();
		operation.complete("failed", failure);
		expect(h.spans).toHaveLength(1);
		expect(h.spans[0].exceptions).toEqual([failure]);
		expect(h.spans[0].statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
		expect(h.spans[0].ends).toBe(1);
	});

	it("measures the actual replication drain lifetime and emits one aggregate event", () => {
		const h = harness();
		const operation = startReplicationDrain("changelog");
		h.advance(37);
		expect(h.spans[0].ends).toBe(0);
		operation.complete("completed", 12);
		expect(h.durations).toEqual([
			{ value: 37, attributes: { kind: "changelog", outcome: "completed" } },
		]);
		expect(h.spans[0].events).toEqual([
			{ name: "replication.drain.complete", attributes: { outcome: "completed", entry_count: 12 } },
		]);
		expect(h.counters.drains).toHaveLength(1);
		expect(h.counters.entries).toHaveLength(1);
		expect(h.spans[0].ends).toBe(1);
	});

	it("ends a failed drain once and preserves its real duration", () => {
		const h = harness();
		const failure = new Error("database failed");
		const operation = startReplicationDrain("relay_outbox");
		h.advance(9);
		operation.fail(failure, 3);
		operation.complete("completed", 3);
		expect(h.spans[0].exceptions).toEqual([failure]);
		expect(h.spans[0].statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
		expect(h.spans[0].ends).toBe(1);
		expect(h.durations[0].value).toBe(9);
		expect(h.counters.drains).toEqual([
			{ value: 1, attributes: { kind: "relay_outbox", outcome: "failed" } },
		]);
	});
});

describe("relay operation attribution", () => {
	it.each([
		["push-write", "spoke.outbox.push", "send", 1],
		["receive", "hub.relay.receive", "receive", 2],
		["deliver", "spoke.relay.deliver", "deliver", 3],
		["reconnect-drain", "spoke.outbox.drain", "send", 4],
	] as const)("exports bounded %s source attributes", (trigger, path, direction, entryCount) => {
		const h = harness();
		startRelayOperation(direction, {
			kind: "stream_chunk",
			traceContext: null,
			trigger,
			path,
			entryCount,
		});

		expect(h.spans[0].attributes).toEqual({
			"relay.trigger": trigger,
			"relay.path": path,
			"relay.direction": direction,
			"relay.kind": "stream_chunk",
			"relay.carrier_state": "absent",
			"relay.entry_count": entryCount,
		});
	});

	it("retains a detached relay operation as an exportable root span", () => {
		const h = harness();
		const operation = startRelayOperation("send", {
			kind: "tool_call",
			trigger: "push-write",
			path: "spoke.outbox.push",
			entryCount: 1,
		});
		expect(h.spans).toHaveLength(1);
		expect(h.spans[0].attributes["relay.carrier_state"]).toBe("absent");
		operation.complete("sent");
		expect(h.spans[0].attributes["relay.outcome"]).toBe("sent");
	});
	it("classifies extracted, active, absent, and invalid carriers without changing parentage", () => {
		const validCarrier = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});
		const extractedContext = context.active();
		propagation.extract = (() => extractedContext) as typeof propagation.extract;
		const extracted = harness();
		startRelayOperation("receive", {
			kind: "tool_call",
			traceContext: validCarrier,
			trigger: "receive",
			path: "hub.relay.receive",
			entryCount: 1,
		});
		expect(extracted.spans[0].attributes["relay.carrier_state"]).toBe("extracted");
		expect(trace.getSpan(extracted.spans[0].parentContext)?.spanContext().spanId).toBe(
			"b7ad6b7169203331",
		);

		const activeContext = trace.setSpan(
			context.active(),
			trace.wrapSpanContext({
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				traceFlags: 1,
			}),
		);
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		const active = harness();
		context.with(activeContext, () => {
			startRelayOperation("send", {
				kind: "tool_result",
				trigger: "push-write",
				path: "spoke.outbox.push",
				entryCount: 1,
			});
		});
		expect(active.spans[0].attributes["relay.carrier_state"]).toBe("active");
		expect(active.spans[0].parentContext).toBe(activeContext);

		const absent = harness();
		startRelayOperation("send", {
			kind: "tool_result",
			trigger: "reconnect-drain",
			path: "spoke.outbox.drain",
			entryCount: 2,
		});
		expect(absent.spans[0].attributes["relay.carrier_state"]).toBe("absent");

		const invalid = harness();
		startRelayOperation("deliver", {
			kind: "tool_result",
			traceContext: "{",
			trigger: "deliver",
			path: "spoke.relay.deliver",
			entryCount: 1,
		});
		expect(invalid.spans[0].attributes["relay.carrier_state"]).toBe("invalid");
	});

	it("collapses unknown kinds and clamps non-finite entry counts at the telemetry boundary", () => {
		const h = harness();
		startRelayOperation("receive", {
			kind: "unrecognized-kind",
			trigger: "receive",
			path: "hub.relay.receive",
			entryCount: Number.POSITIVE_INFINITY,
		});

		expect(h.spans[0].attributes["relay.kind"]).toBe("other");
		expect(h.spans[0].attributes["relay.entry_count"]).toBeGreaterThan(0);
		expect(Number.isFinite(h.spans[0].attributes["relay.entry_count"])).toBe(true);

		const negative = harness();
		startRelayOperation("receive", {
			kind: "tool_call",
			trigger: "receive",
			path: "hub.relay.receive",
			entryCount: -1.5,
		});
		expect(negative.spans[0].attributes["relay.entry_count"]).toBe(0);
	});
});

it("ends failed relay operations exactly once with ERROR status and exception", () => {
	const h = harness();
	const failure = new Error("relay failed");
	const operation = startRelayOperation("receive", {
		kind: "error",
		trigger: "receive",
		path: "hub.relay.receive",
		entryCount: 1,
	});
	operation.fail(failure);
	operation.fail(new Error("late failure"));
	operation.complete("duplicate");
	expect(h.spans[0].exceptions).toEqual([failure]);
	expect(h.spans[0].statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "relay failed" }]);
	expect(h.spans[0].ends).toBe(1);
});

describe("inbound relay trace carrier security", () => {
	const validTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
	const originalExtract = propagation.extract;

	afterEach(() => {
		propagation.extract = originalExtract;
	});

	for (const [name, traceContext] of [
		["malformed JSON", "{"],
		["non-object JSON", "[]"],
		[
			"unknown carrier fields",
			JSON.stringify({ traceparent: validTraceparent, baggage: "admin=true" }),
		],
		[
			"all-zero trace id",
			JSON.stringify({ traceparent: "00-00000000000000000000000000000000-b7ad6b7169203331-01" }),
		],
		[
			"all-zero parent id",
			JSON.stringify({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01" }),
		],
		[
			"oversized tracestate",
			JSON.stringify({ traceparent: validTraceparent, tracestate: `a=${"x".repeat(511)}` }),
		],
		[
			"invalid tracestate",
			JSON.stringify({ traceparent: validTraceparent, tracestate: "UPPER=value" }),
		],
	] as const) {
		it(`rejects ${name} before extraction and falls back to local context`, () => {
			const h = harness();
			const localContext = context.active();
			let extracts = 0;
			propagation.extract = ((base) => {
				extracts++;
				return base;
			}) as typeof propagation.extract;

			startRelayOperation("receive", {
				kind: "tool_call",
				traceContext,
				trigger: "receive",
				path: "hub.relay.receive",
				entryCount: 1,
			});

			expect(extracts).toBe(0);
			expect(
				(
					h.spans[0] as (typeof h.spans)[number] & {
						parentContext: import("@opentelemetry/api").Context;
					}
				).parentContext,
			).toBe(localContext);
			expect(h.spans[0].attributes["relay.carrier_state"]).toBe("invalid");
		});
	}

	it("extracts only trusted trace headers from a valid carrier", () => {
		const h = harness();
		const extractedContext = context.active();
		let extractedCarrier: unknown;
		propagation.extract = ((_base, carrier) => {
			extractedCarrier = carrier;
			return extractedContext;
		}) as typeof propagation.extract;
		const traceContext = JSON.stringify({
			traceparent: validTraceparent,
			tracestate: "vendor=value",
		});

		startRelayOperation("receive", {
			kind: "tool_call",
			traceContext,
			trigger: "receive",
			path: "hub.relay.receive",
			entryCount: 1,
		});

		expect(extractedCarrier).toEqual({ traceparent: validTraceparent, tracestate: "vendor=value" });
		expect(
			trace
				.getSpan(
					(
						h.spans[0] as (typeof h.spans)[number] & {
							parentContext: import("@opentelemetry/api").Context;
						}
					).parentContext,
				)
				?.spanContext().spanId,
		).toBe("b7ad6b7169203331");
	});
});

describe("backfill telemetry operation lifetime", () => {
	it("records successful pulls, bounded drift, metrics, and closes once", () => {
		const h = harness();
		const operation = startBackfill("initial");
		operation.drift("semantic_memory", 2, 3);
		operation.drift("semantic_memory", 9, 9);
		h.advance(12);
		operation.complete({
			localPushCount: 2,
			remotePullRequestedCount: 3,
			remotePullAppliedCount: 3,
			driftTableCount: 1,
		});
		operation.complete({
			localPushCount: 2,
			remotePullRequestedCount: 3,
			remotePullAppliedCount: 3,
			driftTableCount: 1,
		});
		expect(h.spans[0].name).toBe("sync.backfill");
		expect(h.spans[0].attributes).toMatchObject({
			"backfill.trigger": "initial",
			"backfill.outcome": "completed",
			"backfill.local_push_count": 2,
			"backfill.remote_pull_requested_count": 3,
			"backfill.remote_pull_applied_count": 3,
			"backfill.drift_table_count": 1,
		});
		expect(h.spans[0].events).toEqual([
			{
				name: "sync.backfill.drift",
				attributes: {
					table: "semantic_memory",
					local_push_count: 2,
					remote_pull_requested_count: 3,
				},
			},
		]);
		expect(h.counters.backfillRuns).toEqual([
			{ value: 1, attributes: { "backfill.trigger": "initial", "backfill.outcome": "completed" } },
		]);
		expect(h.backfillDurations).toEqual([
			{ value: 12, attributes: { "backfill.trigger": "initial", "backfill.outcome": "completed" } },
		]);
		expect(h.spans[0].ends).toBe(1);
	});

	it("records failure and skipped guard without creating a span for the skip", () => {
		const h = harness();
		const operation = startBackfill("reconnect");
		const failure = new Error("consistency failed");
		operation.fail(failure);
		expect(h.spans[0].exceptions).toEqual([failure]);
		expect(h.spans[0].statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
		startBackfill.skip("cooldown", "periodic");
		expect(h.spans).toHaveLength(1);
	});
});
