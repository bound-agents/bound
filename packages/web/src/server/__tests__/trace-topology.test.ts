import { describe, expect, it } from "bun:test";
import { extractTraceContext } from "@bound/shared";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	recordClientToolResultReceive,
	startClientToolResultReceive,
	startSessionHostHandoff,
} from "../trace-topology";

const carrier = {
	traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

describe("web trace topology", () => {
	it("links async client-tool result receipt to dispatch context without parenting it", () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const span = startClientToolResultReceive(
			provider.getTracer("test"),
			extractTraceContext(carrier),
			{ isError: false, hasTraceData: true },
		);
		span.end();

		const received = exporter.getFinishedSpans()[0];
		expect(received?.name).toBe("client-tool.result.receive");
		expect(received?.parentSpanId).toBeUndefined();
		expect(received?.links[0]?.context.spanId).toBe("b7ad6b7169203331");
		expect(received?.attributes).toEqual({
			"bound.client_tool.result.error": false,
			"bound.client_tool.result.trace_data": true,
		});
	});

	it("parents the synchronous session-host handoff to the extracted carrier", () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const span = startSessionHostHandoff(provider.getTracer("test"), extractTraceContext(carrier));
		span.end();

		const handoff = exporter.getFinishedSpans()[0];
		expect(handoff?.name).toBe("client-tool.session-host.handoff");
		expect(handoff?.parentSpanId).toBe("b7ad6b7169203331");
	});

	it("does not create a result-receive span for an ordinary carrierless success", () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const span = startClientToolResultReceive(provider.getTracer("test"), undefined, {
			isError: false,
			hasTraceData: false,
		});

		expect(span).toBeUndefined();
		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("marks a valid-carrier result-receive span slow after processing crosses 100ms", () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const span = startClientToolResultReceive(
			provider.getTracer("test"),
			extractTraceContext(carrier),
			{ isError: false, hasTraceData: false },
		);

		expect(span).toBeDefined();
		recordClientToolResultReceive(100, "ok", span);
		span?.end();

		const received = exporter.getFinishedSpans()[0];
		expect(received?.attributes["bound.client_tool.result.slow"]).toBe(true);
		expect(received?.events).toContainEqual(
			expect.objectContaining({
				name: "client-tool.result.slow",
				attributes: expect.objectContaining({ "bound.client_tool.result.duration_ms": 100 }),
			}),
		);
	});
});
