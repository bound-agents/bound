import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { SerializedSpan } from "@bound/shared";
import { getTraceExporter, reExportSpans, setTraceExporter } from "@bound/shared";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

describe("relay-trace-reexport (Task 5: AC5.4)", () => {
	let db: Database;

	beforeEach(() => {
		const dbPath = ":memory:";
		db = new Database(dbPath);
		applySchema(db);
		// Clear any previous exporter
		setTraceExporter(null);
	});

	afterEach(() => {
		db.close();
		setTraceExporter(null);
	});

	it("should set and get trace exporter (AC5.4)", () => {
		// Initially, no exporter is set
		expect(getTraceExporter()).toBeNull();

		// Create a mock exporter
		const mockExporter: SpanExporter = {
			export: () => Promise.resolve({ code: 0 }),
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		};

		// Set the exporter
		setTraceExporter(mockExporter);
		expect(getTraceExporter()).not.toBeNull();

		// Clear the exporter
		setTraceExporter(null);
		expect(getTraceExporter()).toBeNull();
	});

	it("should re-export serialized spans to exporter (AC5.4)", () => {
		// Create mock spans
		const mockSpans: SerializedSpan[] = [
			{
				traceId: "test-trace-123",
				spanId: "test-span-456",
				parentSpanId: undefined,
				name: "hub-inference",
				kind: 1,
				startTimeUnixNano: "1000000000",
				endTimeUnixNano: "2000000000",
				attributes: { model: "test-model" },
				status: { code: 0 },
				events: [],
			},
		];

		let exportCalled = false;
		const mockExporter: SpanExporter = {
			export: () => {
				exportCalled = true;
				return Promise.resolve({ code: 0 });
			},
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		};

		setTraceExporter(mockExporter);

		// Re-export the mock spans
		reExportSpans(mockSpans, getTraceExporter());

		// Verify the exporter was called
		expect(exportCalled).toBe(true);
	});

	it("should gracefully handle null exporter (AC5.4)", () => {
		const mockSpans: SerializedSpan[] = [
			{
				traceId: "test-trace-123",
				spanId: "test-span-456",
				parentSpanId: undefined,
				name: "hub-inference",
				kind: 1,
				startTimeUnixNano: "1000000000",
				endTimeUnixNano: "2000000000",
				attributes: { model: "test-model" },
				status: { code: 0 },
				events: [],
			},
		];

		// Should not throw when exporter is null
		reExportSpans(mockSpans, null);
		expect(true).toBe(true); // Just verify no exception
	});

	it("should gracefully handle empty spans array (AC5.4)", () => {
		const mockExporter: SpanExporter = {
			export: () => Promise.resolve({ code: 0 }),
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		};

		setTraceExporter(mockExporter);

		// Should not throw with empty spans
		reExportSpans([], getTraceExporter());
		expect(true).toBe(true); // Just verify no exception
	});

	it("should construct ReadableSpan-conformant objects from SerializedSpan", () => {
		// This test verifies that reExportSpans correctly converts SerializedSpan
		// to ReadableSpan format without throwing
		const mockSpans: SerializedSpan[] = [
			{
				traceId: "aaaa000000000000bbbbbbbbbbbbbbbb",
				spanId: "cccccccccccccccc",
				parentSpanId: "dddddddddddddddd",
				name: "test-span",
				kind: 1,
				startTimeUnixNano: "1609459200000000000",
				endTimeUnixNano: "1609459201000000000",
				attributes: { key: "value", number: 42 },
				status: { code: 0, message: "OK" },
				events: [
					{
						name: "event1",
						attributes: { detail: "event-detail" },
						timeUnixNano: "1609459200500000000",
					},
				],
			},
		];

		let constructedCorrectly = false;
		const mockExporter: SpanExporter = {
			export: (spans) => {
				// Verify the span was constructed with the right shape
				if (Array.isArray(spans) && spans.length > 0) {
					const span = spans[0];
					if (
						span &&
						span.name === "test-span" &&
						span.spanContext().traceId === "aaaa000000000000bbbbbbbbbbbbbbbb"
					) {
						constructedCorrectly = true;
					}
				}
				return Promise.resolve({ code: 0 });
			},
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		};

		setTraceExporter(mockExporter);

		// Should successfully convert and re-export
		reExportSpans(mockSpans, getTraceExporter());

		// Verify construction was correct
		expect(constructedCorrectly).toBe(true);
	});
});
