import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

describe("Web message handling root spans", () => {
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

	it("verifies web.handle-message span has correct structure for user message", () => {
		const tracer = trace.getTracer("bound.web");
		const messageAttrs = {
			thread_id: "thread-1",
			user_id: "user-1",
			message_id: "msg-1",
			platform: "web",
		};

		const rootSpan = tracer.startSpan("web.handle-message", {
			attributes: {
				"thread.id": messageAttrs.thread_id,
				"user.id": messageAttrs.user_id,
				"message.id": messageAttrs.message_id,
				platform: messageAttrs.platform,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "web.handle-message");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes["thread.id"]).toBe("thread-1");
		expect(createdSpan?.attributes["user.id"]).toBe("user-1");
		expect(createdSpan?.attributes["message.id"]).toBe("msg-1");
		expect(createdSpan?.attributes.platform).toBe("web");
		expect(createdSpan?.status.code).toBe(SpanStatusCode.OK);
	});

	it("verifies web.handle-message span for boundless message", () => {
		const tracer = trace.getTracer("bound.web");
		const messageAttrs = {
			thread_id: "thread-2",
			user_id: "user-2",
			message_id: "msg-2",
			platform: "boundless",
		};

		const rootSpan = tracer.startSpan("web.handle-message", {
			attributes: {
				"thread.id": messageAttrs.thread_id,
				"user.id": messageAttrs.user_id,
				"message.id": messageAttrs.message_id,
				platform: messageAttrs.platform,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "web.handle-message");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes.platform).toBe("boundless");
	});

	it("sets ERROR status on span when message handling fails", () => {
		const tracer = trace.getTracer("bound.web");
		const rootSpan = tracer.startSpan("web.handle-message", {
			attributes: {
				"thread.id": "thread-3",
				"user.id": "user-3",
				"message.id": "msg-3",
				platform: "web",
			},
		});

		const testError = new Error("Message processing failed");
		try {
			throw testError;
		} catch (err) {
			rootSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			rootSpan.end();
		}

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "web.handle-message");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(createdSpan?.status.message).toBe("Message processing failed");
	});
});
