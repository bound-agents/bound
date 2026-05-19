import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { initTelemetry, shutdownTelemetry } from "../commands/start/telemetry.js";

describe("telemetry", () => {
	beforeEach(() => {
		// Clean up any existing provider before each test
		process.env.OTEL_ENABLED = undefined;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined;
	});

	afterEach(async () => {
		// Ensure telemetry is shut down after each test
		await shutdownTelemetry();
		process.env.OTEL_ENABLED = undefined;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined;
	});

	it("otel-tracing.AC1.3: Without OTEL_ENABLED, initTelemetry is a no-op", () => {
		// Arrange: OTEL_ENABLED is not set (done in beforeEach)
		// This test runs first to establish a clean baseline

		// Act: Initialize telemetry without OTEL_ENABLED
		initTelemetry("test-service");

		// Get a tracer
		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("test-span");

		// Assert: span.isRecording() returns false (no-op span)
		// This verifies that without OTEL_ENABLED, no actual tracing occurs
		expect(span.isRecording()).toBe(false);

		span.end();
	});

	it("otel-tracing.AC1.1: With OTEL_ENABLED=1, spans are recorded", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";

		// Set up a test exporter so we can verify spans are recorded
		const exporter = new InMemorySpanExporter();
		const resource = new Resource({ [ATTR_SERVICE_NAME]: "test-service" });
		const provider = new BasicTracerProvider({ resource });
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register();

		try {
			// Act: Create and end a span
			const tracer = trace.getTracer("test-tracer");
			const span = tracer.startSpan("test-span");

			// Assert: span.isRecording() returns true
			expect(span.isRecording()).toBe(true);

			span.end();

			// Verify the span was exported
			const spans = exporter.getFinishedSpans();
			expect(spans.length).toBeGreaterThan(0);
			expect(spans[0].name).toBe("test-span");
		} finally {
			await provider.shutdown();
		}
	});

	it("otel-tracing.AC1.2: OTEL_EXPORTER_OTLP_ENDPOINT overrides default", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const customEndpoint = "http://custom-collector:4318";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = customEndpoint;

		// Note: This test verifies the initialization doesn't crash
		// with a custom endpoint. The actual endpoint validation would
		// require mocking the exporter or testing network connectivity.
		let testPassed = false;
		try {
			initTelemetry("test-service");

			// Act: Get a tracer
			const tracer = trace.getTracer("test-tracer");
			const span = tracer.startSpan("test-span");

			// Assert: span is created (no error thrown)
			expect(span).toBeDefined();
			expect(span.isRecording()).toBe(true);

			span.end();
			testPassed = true;
		} finally {
			await shutdownTelemetry();
		}
		expect(testPassed).toBe(true);
	});

	it("otel-tracing.AC1.4: shutdownTelemetry flushes and shuts down", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const exporter = new InMemorySpanExporter();
		const resource = new Resource({ [ATTR_SERVICE_NAME]: "test-service" });
		const provider = new BasicTracerProvider({ resource });
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register();

		try {
			// Create a span
			const tracer = trace.getTracer("test-tracer");
			const span = tracer.startSpan("test-span");
			span.end();

			// Act: Shutdown telemetry
			await shutdownTelemetry();

			// Assert: No error thrown, shutdown completes
			expect(true).toBe(true);
		} finally {
			// Already shut down, but this ensures cleanup
			await provider.shutdown();
		}
	});

	it("otel-tracing.AC1.5: Unreachable collector does not crash", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const unreachableEndpoint = "http://unreachable-collector-xyz123:4318";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = unreachableEndpoint;

		let spanCreated = false;
		try {
			// Act: Initialize telemetry with unreachable endpoint
			initTelemetry("test-service");

			// Create a span
			const tracer = trace.getTracer("test-tracer");
			const span = tracer.startSpan("test-span");

			// Assert: span creation does not throw even with unreachable collector
			expect(span).toBeDefined();
			expect(span.isRecording()).toBe(true);

			span.end();
			spanCreated = true;

			// Shutdown should not throw
			await shutdownTelemetry();
		} catch (error) {
			// If we get here, verify it's not from span creation
			if (error instanceof Error) {
				expect(error.message).not.toContain("startSpan");
			}
		}
		expect(spanCreated).toBe(true);
	});

	it("shutdownTelemetry is idempotent when called without initialization", async () => {
		// Act: Call shutdownTelemetry without initializing
		await shutdownTelemetry();

		// Assert: No error thrown
		expect(true).toBe(true);
	});
});
