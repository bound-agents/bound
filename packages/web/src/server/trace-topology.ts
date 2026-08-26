import { counter, histogram } from "@bound/shared/telemetry-api";
import {
	type Context,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	type Tracer,
	trace,
} from "@opentelemetry/api";

const SLOW_OPERATION_MS = 100;
const resultReceiveCounter = counter("bound.web.client_tool.result.receive", {
	description: "Client tool result receipt outcomes",
});
const resultReceiveDuration = histogram("bound.web.client_tool.result.receive.duration", {
	description: "Client tool result receipt latency",
	unit: "ms",
});
const sessionHostHandoffCounter = counter("bound.web.client_tool.session_host.handoff", {
	description: "Client tool session-host handoff outcomes",
});
const sessionHostHandoffDuration = histogram(
	"bound.web.client_tool.session_host.handoff.duration",
	{
		description: "Client tool session-host handoff latency",
		unit: "ms",
	},
);

function hasValidSpanContext(context: Context | undefined): boolean {
	const spanContext = context ? trace.getSpanContext(context) : undefined;
	return spanContext !== undefined && trace.isSpanContextValid(spanContext);
}

export function startClientToolResultReceive(
	tracer: Tracer,
	dispatchContext: Context | undefined,
	attributes: { isError: boolean; hasTraceData: boolean; durationMs?: number },
) {
	const linkedSpan = dispatchContext ? trace.getSpanContext(dispatchContext) : undefined;
	const meaningful =
		attributes.isError || attributes.hasTraceData || hasValidSpanContext(dispatchContext);
	const slow = (attributes.durationMs ?? 0) >= SLOW_OPERATION_MS;
	if (!meaningful && !slow) return undefined;
	return tracer.startSpan(
		"client-tool.result.receive",
		{
			kind: SpanKind.CONSUMER,
			attributes: {
				"bound.client_tool.result.error": attributes.isError,
				"bound.client_tool.result.trace_data": attributes.hasTraceData,
				...(slow ? { "bound.client_tool.result.slow": true } : {}),
			},
			links: linkedSpan && trace.isSpanContextValid(linkedSpan) ? [{ context: linkedSpan }] : [],
		},
		ROOT_CONTEXT,
	);
}

export function recordClientToolResultReceive(
	durationMs: number,
	outcome: "ok" | "error",
	span?: Span,
): void {
	const slow = durationMs >= SLOW_OPERATION_MS;
	const attributes = { outcome, slow };
	resultReceiveCounter.add(1, attributes);
	resultReceiveDuration.record(durationMs, attributes);
	if (slow && span) {
		span.setAttribute("bound.client_tool.result.slow", true);
		span.addEvent("client-tool.result.slow", {
			"bound.client_tool.result.duration_ms": Math.round(Math.max(0, durationMs)),
		});
	}
}

export function startSessionHostHandoff(
	tracer: Tracer,
	carrierContext: Context | undefined,
	attributes: { isError?: boolean; durationMs?: number } = {},
) {
	const meaningful = attributes.isError || hasValidSpanContext(carrierContext);
	const slow = (attributes.durationMs ?? 0) >= SLOW_OPERATION_MS;
	if (!meaningful && !slow) return undefined;
	return tracer.startSpan(
		"client-tool.session-host.handoff",
		{ kind: SpanKind.PRODUCER, attributes: slow ? { "bound.client_tool.handoff.slow": true } : {} },
		carrierContext ?? ROOT_CONTEXT,
	);
}

export function recordSessionHostHandoff(durationMs: number, outcome: "ok" | "error"): void {
	sessionHostHandoffCounter.add(1, { outcome });
	sessionHostHandoffDuration.record(durationMs, { outcome });
}
