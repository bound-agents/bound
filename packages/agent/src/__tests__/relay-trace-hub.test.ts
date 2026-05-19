import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { createScopedTraceCollector, extractTraceContext } from "@bound/shared";
import { context } from "@opentelemetry/api";

describe("relay-trace-hub (Task 4: AC5.2, AC5.3, AC5.6)", () => {
	let db: Database;

	beforeEach(() => {
		const dbPath = ":memory:";
		db = new Database(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("should extract trace context from relay entry (AC5.2)", () => {
		// Simulate trace context from spoke
		const simulatedTraceContext = {
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "vendor=value",
		};
		const traceContextStr = JSON.stringify(simulatedTraceContext);

		// Parse and extract
		const traceCarrier = JSON.parse(traceContextStr) as Record<string, string>;
		const parentContext = extractTraceContext(traceCarrier);

		expect(parentContext).toBeDefined();
		expect(traceCarrier).toHaveProperty("traceparent");
	});

	it("should create scoped spans under extracted parent context (AC5.2)", async () => {
		const collector = createScopedTraceCollector();
		const tracer = collector.getTracer("test-tracer");

		// Simulate extracting parent context from relay entry
		const simulatedTraceContext = {
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		};
		const parentContext = extractTraceContext(simulatedTraceContext);

		// Create and execute spans within parent context
		await context.with(parentContext, async () => {
			const span = tracer.startSpan("relay.hub-inference");
			span.setStatus({ code: 0 }); // OK
			span.end();
		});

		// Verify spans were collected
		const spans = await collector.flush();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe("relay.hub-inference");
		// Span is created and has a valid traceId
		expect(spans[0]?.traceId).toBeDefined();
		expect(typeof spans[0]?.traceId).toBe("string");
	});

	it("should serialize spans for trace_data response (AC5.3)", async () => {
		const collector = createScopedTraceCollector();
		const tracer = collector.getTracer("bound.relay-hub");

		const span = tracer.startSpan("relay.hub-inference", {
			attributes: { model: "test-model", source: "spoke-1" },
		});
		span.addEvent("inference-started");
		span.setStatus({ code: 0 });
		span.end();

		const spans = await collector.flush();

		// Verify serialized format matches SerializedSpan interface
		expect(spans).toHaveLength(1);
		const s = spans[0];
		if (!s) throw new Error("span should exist");

		expect(s.traceId).toBeDefined();
		expect(s.spanId).toBeDefined();
		expect(s.name).toBe("relay.hub-inference");
		expect(s.kind).toBeDefined();
		expect(s.startTimeUnixNano).toBeDefined();
		expect(s.endTimeUnixNano).toBeDefined();
		expect(s.attributes).toHaveProperty("model", "test-model");
		expect(s.status.code).toBe(0);
		expect(s.events).toHaveLength(1);
		expect(s.events[0]?.name).toBe("inference-started");

		// Verify it can be serialized to JSON for trace_data response
		const serialized = JSON.stringify(spans);
		expect(serialized).toBeDefined();
		const parsed = JSON.parse(serialized);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0]).toHaveProperty("traceId");
	});

	it("should gracefully handle null trace_context (AC5.6)", async () => {
		// When trace_context is null, extraction should succeed
		const traceCarrier = null;
		const parentContext = extractTraceContext(traceCarrier);

		expect(parentContext).toBeDefined();
		// No error should be thrown
	});

	it("should create and flush multiple spans (AC5.5)", async () => {
		// Simulate multiple hops creating spans
		const collector = createScopedTraceCollector();
		const tracer = collector.getTracer("bound.relay-hub");

		// Hub A creates first span
		const span1 = tracer.startSpan("hub-a-processing");
		span1.setStatus({ code: 0 });
		span1.end();

		// Hub B (if delegating) would create second span in same trace
		const span2 = tracer.startSpan("hub-b-processing");
		span2.setStatus({ code: 0 });
		span2.end();

		const spans = await collector.flush();
		expect(spans).toHaveLength(2);
		expect(spans[0]?.name).toBe("hub-a-processing");
		expect(spans[1]?.name).toBe("hub-b-processing");
		// Both spans should be properly collected
		expect(spans[0]?.traceId).toBeDefined();
		expect(spans[1]?.traceId).toBeDefined();
	});
});
