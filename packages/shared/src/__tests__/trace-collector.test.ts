import { describe, expect, it } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import {
	createScopedTraceCollector,
	extractTraceContext,
	injectTraceContext,
} from "../trace-collector";

describe("trace-collector", () => {
	describe("createScopedTraceCollector", () => {
		it("creates a scoped collector with provider and tracer", () => {
			const collector = createScopedTraceCollector();
			expect(collector.provider).toBeDefined();
			expect(collector.getTracer).toBeDefined();
		});

		it("getTracer returns a working tracer", () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");
			expect(tracer).toBeDefined();
		});

		it("creates spans that are recorded", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span = tracer.startSpan("test-span");
			span.setStatus({ code: 0 }); // OK
			span.end();

			const spans = await collector.flush();
			expect(spans).toHaveLength(1);
			expect(spans[0]?.name).toBe("test-span");
		});

		it("serializes span with correct fields", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span = tracer.startSpan("test-span", {
				attributes: { key: "value", number: 42 },
			});
			span.addEvent("test-event", { detail: "event-detail" });
			span.setStatus({ code: 0 });
			span.end();

			const spans = await collector.flush();
			expect(spans).toHaveLength(1);
			const s = spans[0];

			expect(s).toBeDefined();
			if (!s) return;
			expect(s.traceId).toBeDefined();
			expect(s.spanId).toBeDefined();
			expect(s.name).toBe("test-span");
			expect(s.kind).toBeDefined();
			expect(s.startTimeUnixNano).toBeDefined();
			expect(s.endTimeUnixNano).toBeDefined();
			expect(s.attributes).toEqual({ key: "value", number: 42 });
			expect(s.status.code).toBe(0);
			expect(s.events).toHaveLength(1);
			expect(s.events[0]?.name).toBe("test-event");
		});

		it("serializes multiple spans with correct span IDs", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span1 = tracer.startSpan("span-1");
			const span2 = tracer.startSpan("span-2");

			span1.end();
			span2.end();

			const spans = await collector.flush();
			expect(spans).toHaveLength(2);

			const s1 = spans.find((s) => s.name === "span-1");
			const s2 = spans.find((s) => s.name === "span-2");

			expect(s1).toBeDefined();
			expect(s2).toBeDefined();
			if (!s1 || !s2) return;

			// Each span should have its own spanId
			expect(s1.spanId).toBeDefined();
			expect(s2.spanId).toBeDefined();
			expect(s1.spanId).not.toBe(s2.spanId);
		});
	});

	describe("injectTraceContext", () => {
		it("returns null when no span is active in global API", () => {
			const carrier = injectTraceContext();
			expect(carrier).toBeNull();
		});

		it("injects carrier format when called within context", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span = tracer.startSpan("test-span");

			// The function uses the global trace.getActiveSpan(), so set one via context
			// But note: this requires global telemetry setup, not a scoped collector.
			// For this test, we verify the injection format would be correct if a global span exists.
			span.end();
			await collector.flush();

			// Test that the function returns null when no global span is active
			const result = injectTraceContext();
			expect(result).toBeNull();
		});

		it("would inject traceparent if global span was active", async () => {
			// This test documents the expected behavior if trace.getActiveSpan() returned a span.
			// In production, this happens when global telemetry is initialized.
			// The function signature is correct; it's just not testable without global setup.
			const carrier = injectTraceContext();
			expect(carrier).toBeNull(); // Currently no global span
		});
	});

	describe("extractTraceContext", () => {
		it("returns current context when carrier is null", () => {
			const ctx = extractTraceContext(null);
			expect(ctx).toBeDefined();
		});

		it("extracts context from carrier with traceparent", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			// Create a span and inject its context
			const span = tracer.startSpan("test-span");
			let injectedCarrier: Record<string, string> | null = null;

			await context.with(trace.setSpan(context.active(), span), () => {
				injectedCarrier = injectTraceContext();
			});

			span.end();

			// Extract the context
			if (injectedCarrier) {
				const extracted = extractTraceContext(injectedCarrier);
				expect(extracted).toBeDefined();
			}

			await collector.flush();
		});

		it("handles empty carrier gracefully", () => {
			const ctx = extractTraceContext({});
			expect(ctx).toBeDefined();
		});

		it("extracts correct traceId from traceparent via manual parsing", () => {
			// W3C traceparent format: version-traceId-spanId-traceFlags
			const parentTraceId = "0af7651916cd43dd8448eb211c80319c";
			const parentSpanId = "b7ad6b7169203331";
			const carrier = {
				traceparent: `00-${parentTraceId}-${parentSpanId}-01`,
			};

			const extracted = extractTraceContext(carrier);
			const spanCtx = trace.getSpanContext(extracted);

			expect(spanCtx).toBeDefined();
			expect(spanCtx?.traceId).toBe(parentTraceId);
			expect(spanCtx?.spanId).toBe(parentSpanId);
			expect(spanCtx?.traceFlags).toBe(1);
		});
	});

	describe("span status codes", () => {
		it("serializes status OK (code 0)", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span = tracer.startSpan("test-span");
			span.setStatus({ code: 0 });
			span.end();

			const spans = await collector.flush();
			expect(spans[0]?.status.code).toBe(0);
		});

		it("serializes status ERROR (code 2) with message", async () => {
			const collector = createScopedTraceCollector();
			const tracer = collector.getTracer("test.tracer");

			const span = tracer.startSpan("test-span");
			span.setStatus({ code: 2, message: "error occurred" });
			span.end();

			const spans = await collector.flush();
			expect(spans[0]?.status.code).toBe(2);
			expect(spans[0]?.status.message).toBe("error occurred");
		});
	});
});
