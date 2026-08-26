import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.sandbox");
const meter = metrics.getMeter("bound.sandbox");
const commandCount = meter.createCounter("bound.sandbox.command.count", {
	description: "Sandbox command executions",
});
const commandDuration = meter.createHistogram("bound.sandbox.command.duration", {
	description: "Sandbox command execution duration",
	unit: "ms",
});

export async function withCommandTelemetry<T>(
	command: string,
	run: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
): Promise<T> {
	const started = performance.now();
	const span = tracer.startSpan("sandbox.command", { attributes: { "command.name": command } });
	span.addEvent("sandbox.command.parsed");
	let outcome = "success";
	try {
		const result = await run(span);
		span.addEvent("sandbox.command.completed");
		return result;
	} catch (error) {
		outcome = "error";
		span.recordException(error instanceof Error ? error : new Error(String(error)));
		span.setStatus({ code: SpanStatusCode.ERROR });
		span.addEvent("sandbox.command.failed");
		throw error;
	} finally {
		const attributes = { "command.name": command, "command.outcome": outcome };
		commandCount.add(1, attributes);
		commandDuration.record(performance.now() - started, attributes);
		span.end();
	}
}
