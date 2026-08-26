import { counter, histogram } from "@bound/shared";
import { trace } from "@opentelemetry/api";

const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

export interface LessSpan {
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
	recordException(error: Error): void;
	setStatus(status: { code: number; message?: string }): void;
	end(): void;
}

interface MetricRecorder {
	add(value: number, attributes: Record<string, string>): void;
	record(value: number, attributes: Record<string, string>): void;
}

interface LessTelemetryConfig {
	startSpan(name: string, attributes: Record<string, string>): LessSpan;
	operation: Pick<MetricRecorder, "add">;
	duration: Pick<MetricRecorder, "record">;
}

const noopSpan: LessSpan = {
	addEvent() {},
	recordException() {},
	setStatus() {},
	end() {},
};
const noopMetric: MetricRecorder = { add() {}, record() {} };
let spanFactory: (name: string, attributes: Record<string, string>) => LessSpan = () => noopSpan;
let operationMetric = noopMetric;
let durationMetric = noopMetric;

/** Injects telemetry instruments during boundless startup. */
export function configureLessTelemetry(config?: LessTelemetryConfig): void {
	spanFactory = config?.startSpan ?? (() => noopSpan);
	operationMetric = config
		? { ...noopMetric, add: config.operation.add.bind(config.operation) }
		: noopMetric;
	durationMetric = config
		? { ...noopMetric, record: config.duration.record.bind(config.duration) }
		: noopMetric;
}

/** Connects Less' small telemetry seam to the active global OpenTelemetry providers. */
export function configureLessTelemetryFromOpenTelemetry(overrides?: LessTelemetryConfig): void {
	if (overrides) {
		configureLessTelemetry(overrides);
		return;
	}
	const operation = counter("boundless.operations", {
		description: "Boundless operations by name and outcome",
	});
	const duration = histogram("boundless.operation.duration", {
		description: "Boundless operation duration in milliseconds",
		unit: "ms",
	});
	configureLessTelemetry({
		startSpan: (name, attributes) => trace.getTracer("bound.less").startSpan(name, { attributes }),
		operation,
		duration,
	});
}

export async function withLessTelemetry<T>(
	spanName: "boundless.transport.attach" | "boundless.tool.call",
	attributes: Record<string, string>,
	run: (span: LessSpan) => Promise<T>,
): Promise<T> {
	const started = performance.now();
	const span = spanFactory(spanName, attributes);
	let outcome = "success";
	try {
		const result = await run(span);
		if (
			spanName === "boundless.tool.call" &&
			result !== null &&
			typeof result === "object" &&
			"isError" in result &&
			result.isError === true
		) {
			outcome = "error";
			span.setStatus({ code: SPAN_STATUS_ERROR });
		} else {
			span.setStatus({ code: SPAN_STATUS_OK });
		}
		return result;
	} catch (error) {
		outcome = "error";
		span.recordException(error instanceof Error ? error : new Error(String(error)));
		span.setStatus({
			code: SPAN_STATUS_ERROR,
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		const metricAttributes = { "operation.name": spanName, "operation.outcome": outcome };
		operationMetric.add(1, metricAttributes);
		durationMetric.record(performance.now() - started, metricAttributes);
		span.end();
	}
}
