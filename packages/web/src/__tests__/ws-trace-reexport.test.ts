import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { type SerializedSpan, setTraceExporter } from "@bound/shared";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

describe("WebSocket tool:result trace re-export (AC6.3)", () => {
	let mockExporter: SpanExporter;
	let exportCalls: unknown[][];

	beforeEach(() => {
		exportCalls = [];

		// Mock exporter that captures calls
		mockExporter = {
			export: mock((spans: unknown[], callback: (result: any) => void) => {
				exportCalls.push(spans);
				callback({ code: 0 });
			}),
			shutdown: mock(async () => {
				return { code: 0 };
			}),
		} as unknown as SpanExporter;

		setTraceExporter(mockExporter);
	});

	afterEach(() => {
		setTraceExporter(null);
	});

	it("calls reExportSpans with parsed trace_data when present", async () => {
		// Import reExportSpans to test directly
		const { reExportSpans } = await import("@bound/shared");

		// Create serialized spans
		const serializedSpans: SerializedSpan[] = [
			{
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				parentSpanId: undefined,
				name: "test-operation",
				kind: 0,
				startTimeUnixNano: "1234567890000000000",
				endTimeUnixNano: "1234567890001000000",
				attributes: { "custom.attr": "value" },
				status: { code: 0 },
				events: [],
			},
		];

		// Call reExportSpans directly
		reExportSpans(serializedSpans, mockExporter);

		// Verify export was called
		expect(exportCalls.length).toBe(1);
		const exportedSpans = exportCalls[0];
		expect(exportedSpans).toBeDefined();
		expect((exportedSpans as any)[0]?.name).toBe("test-operation");
	});

	it("gracefully handles null exporter", async () => {
		const { reExportSpans } = await import("@bound/shared");

		const serializedSpans: SerializedSpan[] = [
			{
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				parentSpanId: undefined,
				name: "test-op",
				kind: 0,
				startTimeUnixNano: "1234567890000000000",
				endTimeUnixNano: "1234567890001000000",
				attributes: {},
				status: { code: 0 },
				events: [],
			},
		];

		// Should not throw with null exporter
		expect(() => {
			reExportSpans(serializedSpans, null);
		}).not.toThrow();
	});

	it("handles empty spans array gracefully", async () => {
		const { reExportSpans } = await import("@bound/shared");

		// Should not throw with empty array
		expect(() => {
			reExportSpans([], mockExporter);
		}).not.toThrow();

		// Exporter should not have been called for empty spans
		expect(exportCalls.length).toBe(0);
	});

	it("re-exports multiple spans correctly", async () => {
		const { reExportSpans } = await import("@bound/shared");

		const serializedSpans: SerializedSpan[] = [
			{
				traceId: "trace-1",
				spanId: "span-1",
				parentSpanId: undefined,
				name: "parent-span",
				kind: 0,
				startTimeUnixNano: "1000000000",
				endTimeUnixNano: "2000000000",
				attributes: { key: "value" },
				status: { code: 0 },
				events: [
					{
						name: "event-1",
						attributes: { event_key: "event_value" },
						timeUnixNano: "1500000000",
					},
				],
			},
			{
				traceId: "trace-1",
				spanId: "span-2",
				parentSpanId: "span-1",
				name: "child-span",
				kind: 1,
				startTimeUnixNano: "1100000000",
				endTimeUnixNano: "1900000000",
				attributes: {},
				status: { code: 0 },
				events: [],
			},
		];

		reExportSpans(serializedSpans, mockExporter);

		expect(exportCalls.length).toBe(1);
		const exported = exportCalls[0] as any[];
		expect(exported.length).toBe(2);
		expect(exported[0].name).toBe("parent-span");
		expect(exported[1].name).toBe("child-span");
		expect(exported[1].parentSpanId).toBe("span-1");
	});

	it("preserves span attributes during re-export", async () => {
		const { reExportSpans } = await import("@bound/shared");

		const attributes = {
			"http.method": "GET",
			"http.status_code": 200,
			"custom.trace": "value",
		};

		const serializedSpans: SerializedSpan[] = [
			{
				traceId: "abc123",
				spanId: "def456",
				parentSpanId: undefined,
				name: "http-request",
				kind: 3,
				startTimeUnixNano: "1000",
				endTimeUnixNano: "2000",
				attributes,
				status: { code: 0, message: "OK" },
				events: [],
			},
		];

		reExportSpans(serializedSpans, mockExporter);

		const exported = exportCalls[0] as any[];
		expect(exported[0].attributes).toEqual(attributes);
		expect(exported[0].status.message).toBe("OK");
	});
});
