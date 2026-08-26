import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

describe("Scheduler root spans", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(() => {
		// Set up OTEL tracing with shared provider
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});

	beforeEach(() => {
		exporter.reset();
	});

	afterAll(async () => {
		await provider.shutdown();
		trace.disable();
	});

	it("verifies scheduler.execute-task span has correct name and attributes for cron task", () => {
		const tracer = trace.getTracer("bound.scheduler");
		const task = {
			id: "task-1",
			type: "cron",
			trigger_spec: '{"type":"cron","expression":"0 * * * *"}',
			threadId: "thread-1",
		};

		const rootSpan = tracer.startSpan("scheduler.execute-task", {
			attributes: {
				"task.id": task.id,
				"task.type": task.type,
				"task.trigger_spec": task.trigger_spec,
				"thread.id": task.threadId,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "scheduler.execute-task");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes["task.id"]).toBe("task-1");
		expect(createdSpan?.attributes["task.type"]).toBe("cron");
		expect(createdSpan?.status.code).toBe(SpanStatusCode.OK);
	});

	it("verifies scheduler.execute-task span for event task with webhook trigger", () => {
		const tracer = trace.getTracer("bound.scheduler");
		const task = {
			id: "task-2",
			type: "event",
			trigger_spec: '{"type":"webhook","name":"github"}',
			threadId: "thread-2",
		};

		const rootSpan = tracer.startSpan("scheduler.execute-task", {
			attributes: {
				"task.id": task.id,
				"task.type": task.type,
				"task.trigger_spec": task.trigger_spec,
				"thread.id": task.threadId,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "scheduler.execute-task");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes["task.type"]).toBe("event");
		expect(createdSpan?.attributes["task.trigger_spec"]).toContain("webhook");
	});

	it("verifies scheduler.execute-task span for event task with platform trigger", () => {
		const tracer = trace.getTracer("bound.scheduler");
		const task = {
			id: "task-3",
			type: "event",
			trigger_spec: '{"type":"connector","platform":"discord"}',
			threadId: "thread-3",
		};

		const rootSpan = tracer.startSpan("scheduler.execute-task", {
			attributes: {
				"task.id": task.id,
				"task.type": task.type,
				"task.trigger_spec": task.trigger_spec,
				"thread.id": task.threadId,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "scheduler.execute-task");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes["task.type"]).toBe("event");
		expect(createdSpan?.attributes["task.trigger_spec"]).toContain("connector");
	});

	it("keeps terminal scheduler outcomes on the span and marks soft failures as errors", () => {
		const tracer = trace.getTracer("bound.scheduler");
		const rootSpan = tracer.startSpan("scheduler.execute-task", {
			attributes: {
				"task.id": "task-4",
				"task.type": "cron",
			},
		});

		rootSpan.addEvent("bound.scheduler.outcome", { "scheduler.outcome": "soft_failed" });
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Operation failed" });
		rootSpan.end();

		const createdSpan = exporter
			.getFinishedSpans()
			.find((span) => span.name === "scheduler.execute-task");
		expect(createdSpan?.events).toEqual([
			expect.objectContaining({
				name: "bound.scheduler.outcome",
				attributes: { "scheduler.outcome": "soft_failed" },
			}),
		]);
		expect(createdSpan?.status).toEqual({
			code: SpanStatusCode.ERROR,
			message: "Operation failed",
		});
	});
});
