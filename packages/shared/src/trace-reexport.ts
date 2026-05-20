import type { SpanContext, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { SerializedSpan } from "./trace-collector.js";

/**
 * Re-export serialized remote spans to the local OTLP exporter.
 * Constructs ReadableSpan-conformant objects from SerializedSpan data.
 * Used on spoke side to integrate hub-generated spans into local traces.
 *
 * AC5.4: This function is called when a trace_data relay response is received.
 */
export function reExportSpans(spans: SerializedSpan[], exporter: SpanExporter | null): void {
	if (!exporter || spans.length === 0) return;

	const readableSpans = spans.map((s) => ({
		name: s.name,
		kind: s.kind as SpanKind,
		spanContext: () => ({
			traceId: s.traceId,
			spanId: s.spanId,
			traceFlags: 1, // sampled
			traceState: undefined,
		}),
		parentSpanId: s.parentSpanId,
		startTime: nanoToHrTime(s.startTimeUnixNano),
		endTime: nanoToHrTime(s.endTimeUnixNano),
		status: { code: s.status.code as SpanStatusCode, message: s.status.message },
		attributes: s.attributes,
		links: (s.links ?? []).map((l) => ({
			context: {
				traceId: l.traceId,
				spanId: l.spanId,
				traceFlags: l.traceFlags ?? 1,
				traceState: undefined,
			} as SpanContext,
			attributes: l.attributes ?? {},
		})),
		events: s.events.map((e) => ({
			name: e.name,
			attributes: e.attributes ?? {},
			time: nanoToHrTime(e.timeUnixNano),
			droppedAttributesCount: 0,
		})),
		duration: nanoToHrTime(String(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano))),
		ended: true,
		resource: new Resource({ [ATTR_SERVICE_NAME]: "bound-client" }),
		instrumentationLibrary: { name: "bound.remote-reexport" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	}));

	exporter.export(readableSpans as ReadableSpan[], () => {
		// Fire and forget — export failures are non-critical
	});
}

function nanoToHrTime(nanoStr: string): [number, number] {
	const nano = BigInt(nanoStr);
	const seconds = Number(nano / 1_000_000_000n);
	const nanos = Number(nano % 1_000_000_000n);
	return [seconds, nanos];
}
