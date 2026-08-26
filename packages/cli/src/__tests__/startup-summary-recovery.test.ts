import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withEmptyRetry } from "../../../llm/src/drivers/shared";
import { runStartupSummaryRecovery } from "../commands/start/inference";

describe("startup summary recovery tracing", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
	});

	afterEach(async () => {
		await provider.shutdown();
		trace.disable();
	});

	it("nests provider requests under bounded startup recovery extraction spans", async () => {
		await runStartupSummaryRecovery(["thread-a", "thread-b"], async () => {
			for await (const _chunk of withEmptyRetry(
				async function* () {
					yield { type: "text" as const, text: "summary" };
					yield {
						type: "done" as const,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_write_tokens: null,
							cache_read_tokens: null,
							estimated: false,
						},
					};
				},
				{ maxRetries: 0, isAborted: () => false, providerName: "test-provider" },
			)) {
				// Consume the synthetic summary provider stream.
			}
		});

		const spans = exporter.getFinishedSpans();
		const recovery = spans.find((span) => span.name === "startup.summary-recovery");
		const extractions = spans.filter((span) => span.name === "startup.summary-extraction");
		const requests = spans.filter((span) => span.name === "llm.provider.request");

		expect(recovery).toBeDefined();
		expect(recovery?.attributes["startup.summary_recovery.queue_count"]).toBe(2);
		expect(recovery?.attributes.outcome).toBe("success");
		expect(extractions).toHaveLength(2);
		expect(extractions.every((span) => span.parentSpanId === recovery?.spanContext().spanId)).toBe(
			true,
		);
		expect(requests).toHaveLength(2);
		expect(
			requests.every((request) =>
				extractions.some((extraction) => request.parentSpanId === extraction.spanContext().spanId),
			),
		).toBe(true);
	});

	it("records extraction failures without leaving the recovery span open", async () => {
		await runStartupSummaryRecovery(["thread-a", "thread-b"], async (threadId) => {
			if (threadId === "thread-b") throw new Error("summary failed");
		});

		const spans = exporter.getFinishedSpans();
		const recovery = spans.find((span) => span.name === "startup.summary-recovery");
		const failed = spans.find(
			(span) =>
				span.name === "startup.summary-extraction" && span.attributes["thread.id"] === "thread-b",
		);

		expect(recovery?.attributes.outcome).toBe("partial_failure");
		expect(recovery?.attributes["startup.summary_recovery.failed_count"]).toBe(1);
		expect(failed?.status.code).toBe(2);
	});
});
