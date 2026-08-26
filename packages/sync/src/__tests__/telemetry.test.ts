import { afterEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { setSyncTelemetry, startReplicationDrain, startWsHandshake } from "../telemetry";

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
		startSpan(name, attributes) {
			const state = {
				name,
				attributes,
				events: [],
				exceptions: [],
				statuses: [],
				ends: 0,
			} as (typeof spans)[number];
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
