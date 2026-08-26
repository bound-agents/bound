import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initTelemetry, shutdownTelemetry } from "@bound/shared";
import { clearTelemetryInstrumentCaches } from "@bound/shared/telemetry-api";
import { metrics, trace } from "@opentelemetry/api";
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

let metricExporter: InMemoryMetricExporter;
let spanExporter: InMemorySpanExporter;
let spanProvider: BasicTracerProvider;
let reader: PeriodicExportingMetricReader;
let telemetry: typeof import("../sync-websocket-telemetry.ts");

beforeAll(async () => {
	await shutdownTelemetry();
	trace.disable();
	metrics.disable();
	clearTelemetryInstrumentCaches();
	metricExporter = new InMemoryMetricExporter();
	spanExporter = new InMemorySpanExporter();
	spanProvider = new BasicTracerProvider();
	spanProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
	expect(trace.setGlobalTracerProvider(spanProvider)).toBeTrue();
	reader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 60_000,
	});
	initTelemetry("web-test", {
		enabled: true,
		metricReader: reader,
	});
	telemetry = await import(`../sync-websocket-telemetry.ts?test=${Math.random()}`);
});

afterAll(async () => {
	await shutdownTelemetry();
	await spanProvider.forceFlush();
	await spanProvider.shutdown();
	trace.disable();
	metrics.disable();
});

describe("sync WebSocket telemetry", () => {
	test("records one accepted lifecycle without peer identity in metric attributes", async () => {
		spanExporter.reset();
		const attempt = telemetry.startSyncWebSocketAttempt(1_000);
		telemetry.acceptSyncWebSocketAttempt(attempt, "peer-secret");
		telemetry.closeSyncWebSocketAttempt(attempt, 1000, 3_500);
		telemetry.closeSyncWebSocketAttempt(attempt, 1000, 4_000);
		await reader.forceFlush();

		const span = spanExporter.getFinishedSpans()[0];
		expect(span.name).toBe("sync.websocket.connection");
		expect(span.attributes["bound.sync.peer.site_id"]).toBe("peer-secret");
		expect(span.attributes["bound.sync.websocket.outcome"]).toBe("closed_cleanly");
		expect(span.status.code).toBe(1);

		const points = metricExporter
			.getMetrics()
			.flatMap((resource) =>
				resource.scopeMetrics.flatMap((scope) =>
					scope.metrics.flatMap((metric) => metric.dataPoints),
				),
			);
		expect(
			points.some((point) => Object.values(point.attributes).includes("peer-secret")),
		).toBeFalse();
		const terminalPoints = metricExporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
			.find((metric) => metric.descriptor.name === "bound.sync.websocket.terminal")?.dataPoints;
		expect(terminalPoints).toHaveLength(1);
		expect(terminalPoints?.[0].value).toBe(1);
	});

	test("keeps an accepted error span active until close and finalizes exactly once", async () => {
		spanExporter.reset();
		const attempt = telemetry.startSyncWebSocketAttempt(10);
		telemetry.acceptSyncWebSocketAttempt(attempt, "peer-secret");
		telemetry.markSyncWebSocketAttemptError(attempt, new Error("dispatch failed"));
		expect(spanExporter.getFinishedSpans()).toHaveLength(0);

		telemetry.closeSyncWebSocketAttempt(attempt, 1011, 30);
		telemetry.closeSyncWebSocketAttempt(attempt, 1011, 40);
		await reader.forceFlush();

		const span = spanExporter.getFinishedSpans()[0];
		expect(span.status.code).toBe(2);
		expect(span.events.filter((event) => event.name === "exception")).toHaveLength(2);
		expect(spanExporter.getFinishedSpans()).toHaveLength(1);
	});

	test("records rejected upgrades and error status exactly once", async () => {
		spanExporter.reset();
		const attempt = telemetry.startSyncWebSocketAttempt(10);
		telemetry.rejectSyncWebSocketAttempt(attempt, "authentication", new Error("bad signature"), 20);
		telemetry.markSyncWebSocketAttemptError(attempt, new Error("late error"));
		await reader.forceFlush();

		const span = spanExporter.getFinishedSpans()[0];
		expect(span.status.code).toBe(2);
		expect(span.events.filter((event) => event.name === "exception")).toHaveLength(1);
		expect(spanExporter.getFinishedSpans()).toHaveLength(1);
	});
});
