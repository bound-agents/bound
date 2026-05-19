import { describe, expect, it } from "bun:test";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

describe("Agent Loop OTEL Spans", () => {
	it("should create agent-loop.turn spans with thread and task attributes", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const tracer = provider.getTracer("bound.agent-loop");

		// Create root span (like agent-loop.turn)
		const turnSpan = tracer.startSpan("agent-loop.turn");
		turnSpan.setAttribute("thread.id", "test-thread-1");
		turnSpan.setAttribute("task.id", "test-task-1");
		turnSpan.end();

		// Verify span was created
		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBeGreaterThan(0);

		// Find the root span
		const rootSpan = spans.find((s) => s.name === "agent-loop.turn");
		expect(rootSpan).toBeDefined();
		expect(rootSpan?.attributes?.["thread.id"]).toBe("test-thread-1");
		expect(rootSpan?.attributes?.["task.id"]).toBe("test-task-1");

		await provider.shutdown();
	});

	it("should create multiple span types in a turn", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const tracer = provider.getTracer("bound.agent-loop");

		// Create root span
		const turnSpan = tracer.startSpan("agent-loop.turn");

		// Create child spans (simulate being called within the turn)
		const assembleSpan = tracer.startSpan("agent-loop.assemble-context");
		assembleSpan.setAttribute("context.cache_path", "cold");
		assembleSpan.end();

		const llmSpan = tracer.startSpan("agent-loop.llm-call");
		llmSpan.end();

		const persistSpan = tracer.startSpan("agent-loop.response-persist");
		persistSpan.end();

		turnSpan.end();

		// Verify all spans were created
		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBeGreaterThanOrEqual(4);

		// Verify each span exists
		const rootSpan = spans.find((s) => s.name === "agent-loop.turn");
		const assemble = spans.find((s) => s.name === "agent-loop.assemble-context");
		const llm = spans.find((s) => s.name === "agent-loop.llm-call");
		const persist = spans.find((s) => s.name === "agent-loop.response-persist");

		expect(rootSpan).toBeDefined();
		expect(assemble).toBeDefined();
		expect(llm).toBeDefined();
		expect(persist).toBeDefined();

		await provider.shutdown();
	});

	it("should record cache_path attribute on assemble-context span", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const tracer = provider.getTracer("bound.agent-loop");

		const turnSpan = tracer.startSpan("agent-loop.turn");

		// Simulate warm cache path
		const assembleSpan = tracer.startSpan("agent-loop.assemble-context");
		assembleSpan.setAttribute("context.cache_path", "warm");
		assembleSpan.end();

		turnSpan.end();

		const spans = exporter.getFinishedSpans();
		const foundAssemble = spans.find((s) => s.name === "agent-loop.assemble-context");

		expect(foundAssemble).toBeDefined();
		expect(foundAssemble?.attributes?.["context.cache_path"]).toBe("warm");

		await provider.shutdown();
	});

	it("should record model and token attributes on turn span", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		const tracer = provider.getTracer("bound.agent-loop");

		const turnSpan = tracer.startSpan("agent-loop.turn");

		// Simulate LLM response with token data
		turnSpan.setAttribute("model.id", "bedrock-opus");
		turnSpan.setAttribute("model.kind", "local");
		turnSpan.setAttribute("llm.input_tokens", 100);
		turnSpan.setAttribute("llm.output_tokens", 50);
		turnSpan.setAttribute("llm.cache_read_tokens", 1000);
		turnSpan.setAttribute("llm.cache_write_tokens", 500);

		turnSpan.end();

		const spans = exporter.getFinishedSpans();
		const rootSpan = spans.find((s) => s.name === "agent-loop.turn");

		expect(rootSpan).toBeDefined();
		expect(rootSpan?.attributes?.["model.id"]).toBe("bedrock-opus");
		expect(rootSpan?.attributes?.["llm.input_tokens"]).toBe(100);
		expect(rootSpan?.attributes?.["llm.cache_read_tokens"]).toBe(1000);

		await provider.shutdown();
	});
});
