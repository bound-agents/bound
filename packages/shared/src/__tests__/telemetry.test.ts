import { afterEach, describe, expect, it } from "bun:test";
import { metrics, trace } from "@opentelemetry/api";
import {
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
	type TelemetryOptions,
	counter,
	histogram,
	initTelemetry,
	meter,
	shutdownTelemetry,
} from "../telemetry.js";

const ENV_KEYS = [
	"OTEL_ENABLED",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
	await shutdownTelemetry();
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function metricReader(exporter: InMemoryMetricExporter): PeriodicExportingMetricReader {
	return new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
}

describe("shared telemetry bootstrap", () => {
	it("exports the documented options API and metric helpers", () => {
		const options: TelemetryOptions = {
			enabled: true,
			traceExporter: new InMemorySpanExporter(),
			metricReader: metricReader(new InMemoryMetricExporter()),
			resourceAttributes: { "service.version": "1" },
		};
		expect(options.enabled).toBe(true);
		expect(typeof meter).toBe("function");
		expect(typeof counter).toBe("function");
		expect(typeof histogram).toBe("function");
	});

	it.each([undefined, "", "false", "0", "TRUE", "yes"])(
		"enables from OTEL_ENABLED only for explicit true/1: %s",
		(value) => {
			if (value === undefined) process.env.OTEL_ENABLED = undefined;
			else process.env.OTEL_ENABLED = value;
			initTelemetry("test-service");
			const span = trace.getTracer("test").startSpan("disabled");
			expect(span.isRecording()).toBe(false);
			span.end();
		},
	);

	it.each(["true", "1"])("enables from OTEL_ENABLED=%s", async (value) => {
		process.env.OTEL_ENABLED = value;
		const exporter = new InMemorySpanExporter();
		initTelemetry("test-service", exporter);
		trace.getTracer("test").startSpan("enabled").end();
		await exporter.forceFlush();
		expect(exporter.getFinishedSpans()).toHaveLength(1);
	});

	it("leaves traces and metrics as no-ops when disabled", () => {
		initTelemetry("test-service", { enabled: false });
		const span = trace.getTracer("test").startSpan("disabled");
		expect(span.isRecording()).toBe(false);
		span.end();
		counter("test.disabled").add(1);
		histogram("test.disabled.duration", { unit: "ms" }).record(3);
	});

	it("binds a module-scope instrument created before initialization to the initialized provider", async () => {
		const { recordPreinitMetrics } = await import("./fixtures/module-scope-metrics.js");
		const metricExporter = new InMemoryMetricExporter();

		initTelemetry("test-service", {
			enabled: true,
			traceExporter: new InMemorySpanExporter(),
			metricReader: metricReader(metricExporter),
		});
		recordPreinitMetrics();
		await shutdownTelemetry();

		expect(
			metricExporter
				.getMetrics()
				.flatMap((batch) => batch.scopeMetrics)
				.flatMap((scope) => scope.metrics)
				.map((metric) => metric.descriptor.name),
		).toEqual(["test.preinit.requests", "test.preinit.duration"]);
	});

	it("registers trace and metric providers with shared resource attributes", async () => {
		const traceExporter = new InMemorySpanExporter();
		const metricExporter = new InMemoryMetricExporter();
		initTelemetry("test-service", {
			enabled: true,
			traceExporter,
			metricReader: metricReader(metricExporter),
			resourceAttributes: {
				"service.version": "1.2.3",
				"deployment.environment.name": "test",
			},
		});

		const span = trace.getTracer("test").startSpan("recorded");
		expect(span.isRecording()).toBe(true);
		span.end();
		counter("test.requests", { description: "Requests handled" }).add(2, { route: "/" });
		histogram("test.duration", { unit: "ms" }).record(12, { route: "/" });
		await traceExporter.forceFlush();

		const spans = traceExporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.resource.attributes["service.name"]).toBe("test-service");
		expect(spans[0]?.resource.attributes["service.version"]).toBe("1.2.3");

		await shutdownTelemetry();
		const batches = metricExporter.getMetrics();
		expect(batches).toHaveLength(1);
		expect(batches[0]?.resource.attributes["service.name"]).toBe("test-service");
		expect(batches[0]?.scopeMetrics[0]?.metrics.map((metric) => metric.descriptor.name)).toEqual([
			"test.requests",
			"test.duration",
		]);
	});

	it("returns stable meter and instrument instances for ergonomic shared helpers", () => {
		expect(meter("bound.test")).toBe(meter("bound.test"));
		expect(counter("bound.test.jobs")).toBe(counter("bound.test.jobs"));
		expect(histogram("bound.test.latency", { unit: "ms" })).toBe(
			histogram("bound.test.latency", { unit: "ms" }),
		);
		expect(metrics.getMeter("bound.test")).toBeDefined();
	});

	it("keeps initialization and shutdown idempotent", async () => {
		const exporter = new InMemorySpanExporter();
		initTelemetry("first", { enabled: true, traceExporter: exporter });
		initTelemetry("ignored", { enabled: true, traceExporter: new InMemorySpanExporter() });
		trace.getTracer("test").startSpan("one-span").end();
		await exporter.forceFlush();
		expect(exporter.getFinishedSpans()).toHaveLength(1);
		await Promise.all([shutdownTelemetry(), shutdownTelemetry()]);
	});

	it("can initialize again after shutdown", async () => {
		const firstExporter = new InMemorySpanExporter();
		initTelemetry("first", { enabled: true, traceExporter: firstExporter });
		await shutdownTelemetry();
		const secondExporter = new InMemorySpanExporter();
		initTelemetry("second", { enabled: true, traceExporter: secondExporter });
		trace.getTracer("test").startSpan("second-span").end();
		await secondExporter.forceFlush();
		expect(secondExporter.getFinishedSpans()).toHaveLength(1);
	});

	it("shuts down both providers after flush failures and can initialize again", async () => {
		let metricShutdowns = 0;
		const failingReader = {
			setMetricProducer() {},
			selectAggregationTemporality() {
				return 1;
			},
			selectAggregation() {
				return { type: 0 };
			},
			async forceFlush() {
				throw new Error("metric flush failed");
			},
			async shutdown() {
				metricShutdowns++;
			},
		};
		const failingTraceExporter = new InMemorySpanExporter();
		failingTraceExporter.forceFlush = async () => {
			throw new Error("trace flush failed");
		};
		let traceShutdowns = 0;
		const originalShutdown = failingTraceExporter.shutdown.bind(failingTraceExporter);
		failingTraceExporter.shutdown = async () => {
			traceShutdowns++;
			await originalShutdown();
		};

		initTelemetry("first", {
			enabled: true,
			traceExporter: failingTraceExporter,
			metricReader: failingReader,
		});
		await expect(shutdownTelemetry()).rejects.toThrow();
		expect(traceShutdowns).toBe(1);
		expect(metricShutdowns).toBe(1);

		const secondExporter = new InMemorySpanExporter();
		initTelemetry("second", { enabled: true, traceExporter: secondExporter });
		trace.getTracer("test").startSpan("after-failure").end();
		await secondExporter.forceFlush();
		expect(secondExporter.getFinishedSpans()).toHaveLength(1);
	});

	it("does not disable preexisting foreign providers", async () => {
		const foreignTrace = new BasicTracerProvider();
		const foreignMetrics = new MeterProvider();
		trace.setGlobalTracerProvider(foreignTrace);
		metrics.setGlobalMeterProvider(foreignMetrics);
		const foreignTracer = trace.getTracer("foreign");
		const foreignMeter = metrics.getMeter("foreign");

		initTelemetry("test-service", { enabled: true, traceExporter: new InMemorySpanExporter() });
		await shutdownTelemetry();

		expect(trace.getTracer("foreign")).toBe(foreignTracer);
		expect(metrics.getMeter("foreign")).toBe(foreignMeter);
		trace.disable();
		metrics.disable();
		await foreignTrace.shutdown();
		await foreignMetrics.shutdown();
	});
});
