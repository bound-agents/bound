import { afterEach, describe, expect, it } from "bun:test";
import { SpanStatusCode, context, propagation } from "@opentelemetry/api";
import {
	setSyncTelemetry,
	startRelayOperation,
	startReplicationDrain,
	startWsHandshake,
} from "../telemetry";

function harness() {
	const spans: Array<{
		name: string;
		attributes: Record<string, string>;
		events: Array<{ name: string; attributes?: Record<string, string | number> }>;
		exceptions: Error[];
		statuses: Array<{ code: SpanStatusCode; message?: string }>;
		ends: number;
	}> = [];
	const counters = {
		handshakes: [] as unknown[],
		drains: [] as unknown[],
		entries: [] as unknown[],
	};
	const durations: Array<{ value: number; attributes?: Record<string, string> }> = [];
	let now = 10;
	setSyncTelemetry({
		handshakes: { add: (value, attributes) => counters.handshakes.push({ value, attributes }) },
		drains: { add: (value, attributes) => counters.drains.push({ value, attributes }) },
		drainedEntries: { add: (value, attributes) => counters.entries.push({ value, attributes }) },
		drainDuration: { record: (value, attributes) => durations.push({ value, attributes }) },
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

it("starts relay operations from a validated carrier and records safe attributes", () => {
	const h = harness();
	const carrier = JSON.stringify({
		traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	});
	const operation = startRelayOperation("receive", {
		kind: "stream_chunk",
		payloadBytes: 42,
		traceContext: carrier,
	});
	operation.complete("inserted");
	expect(h.spans[0].attributes).toEqual({
		direction: "receive",
		kind: "stream_chunk",
		payload_bytes: 42,
		trace_context_present: true,
	});
	expect(h.spans[0].events).toEqual([
		{ name: "relay.operation.complete", attributes: { outcome: "inserted" } },
	]);
});

it("ends failed relay operations exactly once with ERROR status and exception", () => {
	const h = harness();
	const failure = new Error("relay failed");
	const operation = startRelayOperation("receive", { kind: "error", payloadBytes: 1 });
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

			startRelayOperation("receive", { kind: "tool_call", payloadBytes: 1, traceContext });

			expect(extracts).toBe(0);
			expect(
				(
					h.spans[0] as (typeof h.spans)[number] & {
						parentContext: import("@opentelemetry/api").Context;
					}
				).parentContext,
			).toBe(localContext);
			expect(h.spans[0].attributes.trace_context_present).toBe(false);
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

		startRelayOperation("receive", { kind: "tool_call", payloadBytes: 1, traceContext });

		expect(extractedCarrier).toEqual({ traceparent: validTraceparent, tracestate: "vendor=value" });
		expect(
			(
				h.spans[0] as (typeof h.spans)[number] & {
					parentContext: import("@opentelemetry/api").Context;
				}
			).parentContext,
		).toBe(extractedContext);
	});
});
