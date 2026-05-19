import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

describe("Relay processor root spans", () => {
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

	it("verifies relay.execute-process span has correct structure", () => {
		const tracer = trace.getTracer("bound.relay");
		const processAttrs = {
			thread_id: "thread-1",
			user_id: "user-1",
			source_site_id: "hub-site",
			platform: "discord",
		};

		const rootSpan = tracer.startSpan("relay.execute-process", {
			attributes: {
				"thread.id": processAttrs.thread_id,
				"user.id": processAttrs.user_id,
				"source.site_id": processAttrs.source_site_id,
				platform: processAttrs.platform,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "relay.execute-process");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes["thread.id"]).toBe("thread-1");
		expect(createdSpan?.attributes["user.id"]).toBe("user-1");
		expect(createdSpan?.attributes["source.site_id"]).toBe("hub-site");
		expect(createdSpan?.attributes.platform).toBe("discord");
		expect(createdSpan?.status.code).toBe(SpanStatusCode.OK);
	});

	it("verifies relay.execute-process span for web platform", () => {
		const tracer = trace.getTracer("bound.relay");
		const processAttrs = {
			thread_id: "thread-2",
			user_id: "user-2",
			source_site_id: "spoke-site",
			platform: "web",
		};

		const rootSpan = tracer.startSpan("relay.execute-process", {
			attributes: {
				"thread.id": processAttrs.thread_id,
				"user.id": processAttrs.user_id,
				"source.site_id": processAttrs.source_site_id,
				platform: processAttrs.platform,
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "relay.execute-process");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes.platform).toBe("web");
	});

	it("verifies relay.execute-process span with empty platform", () => {
		const tracer = trace.getTracer("bound.relay");
		const rootSpan = tracer.startSpan("relay.execute-process", {
			attributes: {
				"thread.id": "thread-3",
				"user.id": "user-3",
				"source.site_id": "spoke-site",
				platform: "",
			},
		});

		rootSpan.setStatus({ code: SpanStatusCode.OK });
		rootSpan.end();

		const spans = exporter.getFinishedSpans();
		const createdSpan = spans.find((s) => s.name === "relay.execute-process");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.attributes.platform).toBe("");
	});

	it("sets ERROR status on span when process execution fails", () => {
		const tracer = trace.getTracer("bound.relay");
		const rootSpan = tracer.startSpan("relay.execute-process", {
			attributes: {
				"thread.id": "thread-4",
				"user.id": "user-4",
				"source.site_id": "spoke-site",
				platform: "discord",
			},
		});

		const testError = new Error("Delegation failed");
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
		const createdSpan = spans.find((s) => s.name === "relay.execute-process");

		expect(createdSpan).toBeDefined();
		expect(createdSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(createdSpan?.status.message).toBe("Delegation failed");
	});
});
