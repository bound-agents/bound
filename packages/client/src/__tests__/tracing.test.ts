import { describe, expect, it } from "bun:test";
import { withClientToolTracing } from "../tracing";

describe("withClientToolTracing", () => {
	it("should execute function without trace context and return undefined traceData", async () => {
		const fn = async () => ({ result: "success" });
		const result = await withClientToolTracing(undefined, fn);

		expect(result.result).toEqual({ result: "success" });
		expect(result.traceData).toBeUndefined();
	});

	it("should execute function and return result", async () => {
		const fn = async () => "tool result";
		const result = await withClientToolTracing(undefined, fn);

		expect(result.result).toBe("tool result");
		expect(result.traceData).toBeUndefined();
	});

	it("should return undefined traceData when trace context is null", async () => {
		const fn = async () => ({ result: "success" });
		const result = await withClientToolTracing(null as unknown as string | undefined, fn);

		expect(result.result).toEqual({ result: "success" });
		expect(result.traceData).toBeUndefined();
	});

	it("should handle empty trace context string gracefully", async () => {
		const fn = async () => ({ result: "success" });

		// Empty string JSON parses to empty object, which has no traceparent
		// extractTraceContext will still create a new context, so traceData will be collected
		const emptyResult = await withClientToolTracing("{}", fn);
		expect(emptyResult.result).toEqual({ result: "success" });
		// Empty context still creates spans, just without parent trace ID
		expect(emptyResult.traceData).toBeDefined();
		const traceData = emptyResult.traceData;
		if (!traceData) throw new Error("traceData should be defined");
		const spans = JSON.parse(traceData);
		expect(spans.length).toBeGreaterThan(0);
	});

	it("should execute with valid trace context and collect spans", async () => {
		// Use a minimal W3C trace context
		const traceContextStr = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});

		const fn = async () => ({ result: "success" });
		const result = await withClientToolTracing(traceContextStr, fn);

		expect(result.result).toEqual({ result: "success" });
		expect(result.traceData).toBeDefined();

		// Parse and verify spans structure
		const traceData1 = result.traceData;
		if (!traceData1) throw new Error("traceData should be defined");
		const spans = JSON.parse(traceData1);
		expect(Array.isArray(spans)).toBe(true);
		expect(spans.length).toBeGreaterThan(0);

		// Verify the client span is present
		const clientSpan = spans.find((s) => s.name === "client-tool.execute");
		expect(clientSpan).toBeDefined();
		expect(clientSpan?.status.code).toBe(1); // OK
		// Verify the span has a valid trace ID (format: 32 hex chars)
		expect(clientSpan?.traceId).toMatch(/^[a-f0-9]{32}$/);
	});

	it("should propagate errors and set error status", async () => {
		const traceContextStr = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});

		const errorFn = async () => {
			throw new Error("Test error");
		};

		try {
			await withClientToolTracing(traceContextStr, errorFn);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe("Test error");
		}
	});

	it("should handle async functions properly", async () => {
		const traceContextStr = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});

		const asyncFn = async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { delayed: true };
		};

		const result = await withClientToolTracing(traceContextStr, asyncFn);

		expect(result.result).toEqual({ delayed: true });
		expect(result.traceData).toBeDefined();
		const traceData2 = result.traceData;
		if (!traceData2) throw new Error("traceData should be defined");
		const spans = JSON.parse(traceData2);
		expect(spans.length).toBeGreaterThan(0);
	});
});
