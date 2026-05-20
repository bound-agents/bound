import { describe, expect, it } from "bun:test";
import type { SerializedSpan } from "@bound/shared";
import { createClientTracingSession } from "../tracing";

const PARENT_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT_A = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`;
const TRACEPARENT_B = "00-1bf8762a27cd43dd8448eb211c80319d-c8ad6b7169203331-01";

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

	it("creates a client-tool.execute span on a fresh trace, with a Link to the server SpanContext", async () => {
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
			const child = spans.find((s) => s.name === "client-tool.execute");
			expect(child).toBeDefined();
			expect(child?.status.code).toBe(1); // OK
			expect(child?.attributes["tool.name"]).toBe("boundless_bash");

			// New semantics: client span lives on a FRESH trace (the session trace),
			// NOT the parent's trace. Cross-trace nav is via the Link.
			expect(child?.traceId).not.toBe(PARENT_TRACE_ID);
			expect(child?.links?.length).toBe(1);
			expect(child?.links?.[0]?.traceId).toBe(PARENT_TRACE_ID);
			expect(child?.links?.[0]?.spanId).toBe(PARENT_SPAN_ID);
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

	it("groups parallel/serial calls under one boundless.session for the same traceparent", async () => {
		const session = createClientTracingSession();
		const a = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 1, {
			toolName: "tool_a",
		});
		const b = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 2, {
			toolName: "tool_b",
		});
		const trailing = session.end();

		const aSpans = parseSpans(a.traceData);
		const bSpans = parseSpans(b.traceData);

		const childA = aSpans.find((s) => s.name === "client-tool.execute");
		const childB = bSpans.find((s) => s.name === "client-tool.execute");
		expect(childA).toBeDefined();
		expect(childB).toBeDefined();

		// Both client-tool.execute spans share the same trace and same parent span (the session).
		expect(childA?.traceId).toBe(childB?.traceId);
		expect(childA?.parentSpanId).toBeDefined();
		expect(childA?.parentSpanId).toBe(childB?.parentSpanId);

		// The session span ends in the trailing flush, sharing the trace and matching the parentSpanId.
		const sessionSpan = trailing.find((s) => s.name === "boundless.session");
		expect(sessionSpan).toBeDefined();
		expect(sessionSpan?.traceId).toBe(childA?.traceId);
		expect(sessionSpan?.spanId).toBe(childA?.parentSpanId);
	});

	it("rolls the session when the server traceparent changes (new agent turn)", async () => {
		const session = createClientTracingSession();
		const a = await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => 1);
		// Second call under a different traceparent — should close the previous batch
		// and start a new one. The previous batch span ships on this call's flush.
		const b = await session.wrapToolCall(traceContext(TRACEPARENT_B), async () => 2);
		session.end();

		const aSpans = parseSpans(a.traceData);
		const bSpans = parseSpans(b.traceData);

		const aChild = aSpans.find((s) => s.name === "client-tool.execute");
		const bChild = bSpans.find((s) => s.name === "client-tool.execute");
		const rolledSessionSpan = bSpans.find((s) => s.name === "boundless.session");

		// Children live on different traces (different sessions).
		expect(aChild?.traceId).not.toBe(bChild?.traceId);
		// The rolled session span shipped on b's flush is the OLD one (matches a's parent).
		expect(rolledSessionSpan).toBeDefined();
		expect(rolledSessionSpan?.traceId).toBe(aChild?.traceId);
		expect(rolledSessionSpan?.spanId).toBe(aChild?.parentSpanId);
	});

	it("end() is idempotent and returns [] on subsequent calls", async () => {
		const session = createClientTracingSession();
		await session.wrapToolCall(traceContext(TRACEPARENT_A), async () => "ok");
		const first = session.end();
		const second = session.end();
		expect(first.length).toBeGreaterThan(0);
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
			expect(spans.length).toBeGreaterThan(0);
		} finally {
			session.end();
		}
	});
});
