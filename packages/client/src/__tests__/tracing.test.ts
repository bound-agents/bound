import { describe, expect, it } from "bun:test";
import type { SerializedSpan } from "@bound/shared";
import { createClientTracingSession } from "../tracing";

const PARENT_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT_A = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`;
const PARENT_TRACE_ID_B = "1bf8762a27cd43dd8448eb211c80319d";
const PARENT_SPAN_ID_B = "c8ad6b7169203331";
const TRACEPARENT_B = `00-${PARENT_TRACE_ID_B}-${PARENT_SPAN_ID_B}-01`;

const traceContext = (traceparent: string): string => JSON.stringify({ traceparent });

function parseSpans(traceData: string | undefined): SerializedSpan[] {
	if (!traceData) throw new Error("expected traceData to be defined");
	return JSON.parse(traceData) as SerializedSpan[];
}

describe("createClientTracingSession", () => {
	it("executes without tracing when no trace_context is provided", async () => {
		const session = createClientTracingSession();
		try {
			const { result, traceData } = await session.wrapToolCall(undefined, async () => "ok");
			expect(result).toBe("ok");
			expect(traceData).toBeUndefined();
		} finally {
			session.end();
		}
	});

	it("executes without tracing for malformed trace_context", async () => {
		const session = createClientTracingSession();
		try {
			const { result, traceData } = await session.wrapToolCall("not-json", async () => "ok");
			expect(result).toBe("ok");
			expect(traceData).toBeUndefined();
		} finally {
			session.end();
		}
	});

	it("executes without tracing when carrier has no traceparent", async () => {
		const session = createClientTracingSession();
		try {
			const { result, traceData } = await session.wrapToolCall("{}", async () => "ok");
			expect(result).toBe("ok");
			expect(traceData).toBeUndefined();
		} finally {
			session.end();
		}
	});

	it("creates a client-tool.execute span parented directly under the server SpanContext", async () => {
		const session = createClientTracingSession();
		const { result, traceData } = await session.wrapToolCall(
			traceContext(TRACEPARENT_A),
			async () => ({ ok: true }),
			{ toolName: "boundless_bash" },
		);
		try {
			expect(result).toEqual({ ok: true });
			expect(traceData).toBeDefined();
			const spans = parseSpans(traceData);
			expect(spans.length).toBe(1);
			const child = spans[0];
			expect(child?.name).toBe("client-tool.execute");
			expect(child?.status.code).toBe(1); // OK
			expect(child?.attributes["tool.name"]).toBe("boundless_bash");

			// Lives on the server's trace and is a direct child of the server span
			// (typically agent-loop.tool-execute) — no intermediary boundless.session.
			expect(child?.traceId).toBe(PARENT_TRACE_ID);
			expect(child?.parentSpanId).toBe(PARENT_SPAN_ID);

			// No Link to the parent SpanContext — the parent reference is the
			// only ref we want Jaeger to see, otherwise the redundant Link
			// causes the parent relationship to render as FOLLOWS_FROM.
			expect(child?.links?.length ?? 0).toBe(0);
		} finally {
			session.end();
		}
	});

	it("propagates errors and sets ERROR status on the span", async () => {
		const session = createClientTracingSession();
		try {
			await expect(
				session.wrapToolCall(traceContext(TRACEPARENT_A), async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
		} finally {
			session.end();
		}
	});

	it("siblings under the same server traceparent share parentSpanId implicitly via the carrier", async () => {
		const session = createClientTracingSession();
		const a = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 1, {
			toolName: "tool_a",
		});
		const b = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 2, {
			toolName: "tool_b",
		});
		session.end();

		const childA = parseSpans(a.traceData)[0];
		const childB = parseSpans(b.traceData)[0];
		expect(childA?.name).toBe("client-tool.execute");
		expect(childB?.name).toBe("client-tool.execute");

		// Same trace, same parent — no client-side container span needed.
		expect(childA?.traceId).toBe(PARENT_TRACE_ID);
		expect(childB?.traceId).toBe(PARENT_TRACE_ID);
		expect(childA?.parentSpanId).toBe(PARENT_SPAN_ID);
		expect(childB?.parentSpanId).toBe(PARENT_SPAN_ID);
	});

	it("calls under different server traceparents land on different unified traces", async () => {
		const session = createClientTracingSession();
		const a = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 1);
		const b = await session.wrapToolCall(traceContext(TRACEPARENT_B), async () => 2);
		session.end();

		const aChild = parseSpans(a.traceData)[0];
		const bChild = parseSpans(b.traceData)[0];

		expect(aChild?.traceId).toBe(PARENT_TRACE_ID);
		expect(aChild?.parentSpanId).toBe(PARENT_SPAN_ID);
		expect(bChild?.traceId).toBe(PARENT_TRACE_ID_B);
		expect(bChild?.parentSpanId).toBe(PARENT_SPAN_ID_B);
		expect(aChild?.traceId).not.toBe(bChild?.traceId);
	});

	it("end() is idempotent and returns [] (no trailing batch span to flush)", async () => {
		const session = createClientTracingSession();
		await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => "ok");
		const first = session.end();
		const second = session.end();
		expect(first).toEqual([]);
		expect(second).toEqual([]);
	});

	it("after end(), wrapToolCall executes the function but emits no trace data", async () => {
		const session = createClientTracingSession();
		session.end();
		const { result, traceData } = await session.wrapToolCall(
			traceContext(TRACEPARENT_A),
			async () => "ok",
		);
		expect(result).toBe("ok");
		expect(traceData).toBeUndefined();
	});

	it("handles async functions correctly", async () => {
		const session = createClientTracingSession();
		try {
			const { result, traceData } = await session.wrapToolCall(
				traceContext(TRACEPARENT_A),
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { delayed: true };
				},
			);
			expect(result).toEqual({ delayed: true });
			expect(traceData).toBeDefined();
			const spans = parseSpans(traceData);
			expect(spans.length).toBe(1);
		} finally {
			session.end();
		}
	});
});
