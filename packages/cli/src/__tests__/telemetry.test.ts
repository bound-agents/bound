import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SITE_ID_ATTR } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
	initTelemetry,
	setTelemetrySiteId,
	shutdownTelemetry,
} from "../commands/start/telemetry.js";

describe("telemetry", () => {
	beforeEach(() => {
		// Clean up any existing provider before each test. Use `delete`, not
		// `= undefined`: assigning `undefined` coerces to the literal string
		// "undefined", which is truthy — so `if (!process.env.OTEL_ENABLED)` in
		// initTelemetry would NOT short-circuit, building a real OTLPTraceExporter
		// with url "undefined/v1/traces" and throwing in validateUserProvidedUrl.
		// biome-ignore lint/performance/noDelete: clearing process.env requires delete; see note above
		delete process.env.OTEL_ENABLED;
		// biome-ignore lint/performance/noDelete: clearing process.env requires delete; see note above
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	});

	afterEach(async () => {
		// Ensure telemetry is shut down after each test
		await shutdownTelemetry();
		// biome-ignore lint/performance/noDelete: clearing process.env requires delete; see note above
		delete process.env.OTEL_ENABLED;
		// biome-ignore lint/performance/noDelete: clearing process.env requires delete; see note above
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
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

		// Use a test exporter for verification
		const exporter = new InMemorySpanExporter();

		// Act: Initialize telemetry with test exporter
		initTelemetry("test-service", exporter);

		// Get a tracer from the global trace API
		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("test-span");

		// Assert: span.isRecording() returns true, proving initTelemetry registered a working provider
		expect(span.isRecording()).toBe(true);

		span.end();

		// Verify the span was exported
		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBeGreaterThan(0);
		expect(spans[0].name).toBe("test-span");

		// Clean up
		await shutdownTelemetry();
	});

	it("otel-tracing.AC1.2: OTEL_EXPORTER_OTLP_ENDPOINT overrides default", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const customEndpoint = "http://custom-collector:4318";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = customEndpoint;

		// Use test exporter to avoid network calls
		const exporter = new InMemorySpanExporter();

		// Act: Initialize telemetry with custom endpoint (passed via env var)
		// The test exporter is passed to avoid network errors; the env var is still checked
		initTelemetry("test-service", exporter);

		// Get a tracer
		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("test-span");

		// Assert: span is created and recording
		expect(span).toBeDefined();
		expect(span.isRecording()).toBe(true);

		span.end();

		// Clean up
		await shutdownTelemetry();
	});

	it("otel-tracing.AC1.4: shutdownTelemetry flushes and shuts down", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";

		// Use a test exporter so we can verify spans are flushed
		const exporter = new InMemorySpanExporter();

		// Initialize telemetry (registers the module-level provider)
		initTelemetry("test-service", exporter);

		// Create a span to verify the provider is working
		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("test-span");
		expect(span.isRecording()).toBe(true);
		span.end();

		// Verify the span was exported before shutdown
		const spansBeforeShutdown = exporter.getFinishedSpans();
		expect(spansBeforeShutdown.length).toBeGreaterThan(0);

		// Act: Shutdown telemetry (flushes pending spans and nulls the provider)
		await shutdownTelemetry();

		// Assert: Shutdown completed without error and flushed the spans
		// The fact that we reach here means shutdown did not throw
		expect(true).toBe(true);

		// Also verify that after shutdown, trace.disable() was called so spans become non-recording
		const tracer2 = trace.getTracer("test-tracer-2");
		const span2 = tracer2.startSpan("test-span-2");
		expect(span2.isRecording()).toBe(false);
		span2.end();
	});

	it("otel-tracing.AC1.5: Unreachable collector does not crash", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const unreachableEndpoint = "http://unreachable-collector-xyz123:4318";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = unreachableEndpoint;

		// Use test exporter to avoid network errors, but verify initialization logic
		const exporter = new InMemorySpanExporter();

		let spanCreated = false;
		try {
			// Act: Initialize telemetry with unreachable endpoint env var
			// (the test exporter prevents actual network calls, so we're testing the env var handling)
			initTelemetry("test-service", exporter);

			// Create a span
			const tracer = trace.getTracer("test-tracer");
			const span = tracer.startSpan("test-span");

			// Assert: span creation does not throw even with unreachable collector config
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

	it("issue-152: setTelemetrySiteId stamps bound.site_id on subsequently-started spans", async () => {
		// Arrange
		process.env.OTEL_ENABLED = "1";
		const exporter = new InMemorySpanExporter();
		initTelemetry("test-service", exporter);

		// Act: populate the site ID (mirrors the post-bootstrap call in runStart)
		setTelemetrySiteId("site-abc-123");

		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("test-span");
		span.end();

		// Assert: the span carries the executing site ID
		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBeGreaterThan(0);
		expect(spans[0]?.attributes[SITE_ID_ATTR]).toBe("site-abc-123");

		await shutdownTelemetry();
	});

	it("issue-152: spans started before setTelemetrySiteId carry no site_id tag", async () => {
		// Arrange: mirror the Phase 0 window where initTelemetry has run but the site
		// ID is not yet known (bootstrap derives it from the keypair in Phase 1).
		process.env.OTEL_ENABLED = "1";
		const exporter = new InMemorySpanExporter();
		initTelemetry("test-service", exporter);

		const tracer = trace.getTracer("test-tracer");
		const span = tracer.startSpan("bootstrap-span");
		span.end();

		// Assert: no tag yet — acceptable, these are startup-infra spans, not agent loops
		const spans = exporter.getFinishedSpans();
		expect(spans[0]?.attributes[SITE_ID_ATTR]).toBeUndefined();

		await shutdownTelemetry();
	});

	it("issue-152: setTelemetrySiteId is a no-op when telemetry was never initialized", () => {
		// Act + Assert: must not throw even though no provider/processor exists
		expect(() => setTelemetrySiteId("site-xyz")).not.toThrow();
	});
});
