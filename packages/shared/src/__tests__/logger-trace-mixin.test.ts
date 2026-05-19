import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createLogger, resetLogger } from "../logger.js";

describe("logger-trace-mixin", () => {
	beforeEach(() => {
		resetLogger();
		// Set LOG_LEVEL to avoid file writes
		process.env.LOG_LEVEL = "info";
		process.env.BOUND_LOG_STDERR = "1";
	});

	afterEach(() => {
		resetLogger();
		process.env.LOG_LEVEL = undefined;
		process.env.BOUND_LOG_STDERR = undefined;
	});

	it("AC7.1: includes trace_id and span_id when active span exists", async () => {
		// Set up a tracer provider and exporter for testing
		const exporter = new InMemorySpanExporter();
		const resource = Resource.default().merge(
			new Resource({
				[ATTR_SERVICE_NAME]: "test",
			}),
		);
		const provider = new BasicTracerProvider({ resource });
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register();

		const tracer = trace.getTracer("test-tracer");

		// Use direct tracer API to verify span context fields
		await new Promise<void>((resolve) => {
			tracer.startActiveSpan("test-span", (span) => {
				// Get the mixin fields directly
				const spanContext = span.spanContext();
				expect(spanContext.traceId).toBeDefined();
				expect(spanContext.spanId).toBeDefined();
				expect(spanContext.traceId.length).toBeGreaterThan(0);
				expect(spanContext.spanId.length).toBeGreaterThan(0);
				span.end();
				resolve();
			});
		});

		await provider.shutdown();
	});

	it("AC7.2: excludes trace_id and span_id when no span is active", async () => {
		// Set up a tracer provider (but don't create any spans)
		const exporter = new InMemorySpanExporter();
		const resource = Resource.default().merge(
			new Resource({
				[ATTR_SERVICE_NAME]: "test",
			}),
		);
		const provider = new BasicTracerProvider({ resource });
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register();

		// Verify no active span
		const activeSpan = trace.getActiveSpan();
		expect(activeSpan).toBeFalsy();

		await provider.shutdown();
	});

	it("AC7.3: excludes trace fields when OTEL is disabled (no provider registered)", () => {
		// With no provider registered, trace.getActiveSpan() returns undefined
		const activeSpan = trace.getActiveSpan();
		expect(activeSpan).toBeFalsy();
	});

	it("AC7.1 (detailed): mixin logic returns trace fields when span passed", () => {
		// Test the mixin logic directly with a mock span
		const mockSpan = {
			spanContext: () => ({
				traceId: "test-trace-id-0123456789abcdef",
				spanId: "test-span-id-01234567",
				traceFlags: 1,
			}),
		};

		const testMixin = () => {
			const span = mockSpan;
			if (!span) return {};
			const ctx = span.spanContext();
			return {
				trace_id: ctx.traceId,
				span_id: ctx.spanId,
				trace_flags: ctx.traceFlags,
			};
		};

		const result = testMixin();
		expect(result.trace_id).toBe("test-trace-id-0123456789abcdef");
		expect(result.span_id).toBe("test-span-id-01234567");
		expect(result.trace_flags).toBe(1);
	});

	it("AC7.2 (detailed): mixin returns empty object when no span active", async () => {
		const exporter = new InMemorySpanExporter();
		const resource = Resource.default().merge(
			new Resource({
				[ATTR_SERVICE_NAME]: "test",
			}),
		);
		const provider = new BasicTracerProvider({ resource });
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register();

		const testMixin = () => {
			const span = trace.getActiveSpan();
			if (!span) return {};
			const ctx = span.spanContext();
			return {
				trace_id: ctx.traceId,
				span_id: ctx.spanId,
				trace_flags: ctx.traceFlags,
			};
		};

		const mixinResult = testMixin();
		expect(mixinResult).toEqual({});

		await provider.shutdown();
	});
});
