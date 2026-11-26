import type { SpanContext, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { Logger } from "./logger.js";
import type { SerializedSpan } from "./trace-collector.js";

interface ExportFailureState {
	errorClass: string;
	suppressedFailures: number;
}

const exportFailureStates = new WeakMap<SpanExporter, Map<string, ExportFailureState>>();

/** Error names are class identifiers; anything else (spaces, URLs, overlong) is dropped. */
const SAFE_ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
/** Symbolic error codes such as ECONNREFUSED or ERR_SOCKET_CLOSED. */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const MAX_ERROR_CODES = 4;
const MAX_ERROR_DEPTH = 3;
const MAX_ERRORS_VISITED = 32;

function safeErrorName(error: Error): string {
	return SAFE_ERROR_NAME.test(error.name) ? error.name : "Error";
}

function safeErrorCode(code: unknown): string | undefined {
	if (typeof code === "string") return SAFE_ERROR_CODE.test(code) ? code : undefined;
	if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) {
		return String(code);
	}
	return undefined;
}

/**
 * Collect allowlisted codes (symbolic errno-style strings or HTTP statuses) from an
 * error, its AggregateError members, and its cause chain. Messages, endpoints,
 * headers, and payloads are never read.
 */
function collectErrorCodes(error: Error): string[] {
	const codes: string[] = [];
	let visited = 0;
	const visit = (value: unknown, depth: number) => {
		if (!(value instanceof Error) || depth > MAX_ERROR_DEPTH) return;
		if (visited++ >= MAX_ERRORS_VISITED || codes.length >= MAX_ERROR_CODES) return;
		const code = safeErrorCode((value as { code?: unknown }).code);
		if (code && !codes.includes(code)) codes.push(code);
		const nested = (value as { errors?: unknown }).errors;
		if (Array.isArray(nested)) {
			for (const member of nested) visit(member, depth + 1);
		}
		visit((value as { cause?: unknown }).cause, depth + 1);
	};
	visit(error, 0);
	return codes.slice(0, MAX_ERROR_CODES);
}

function errorClass(error: unknown): string {
	if (!(error instanceof Error)) return typeof error;
	const codes = collectErrorCodes(error);
	const name = safeErrorName(error);
	return codes.length > 0 ? `${name}[${codes.join(",")}]` : name;
}

/**
 * Re-export serialized remote spans to the local OTLP exporter.
 * Constructs ReadableSpan-conformant objects from SerializedSpan data.
 * Used on spoke side to integrate hub-generated spans into local traces.
 */
export function reExportSpans(
	spans: SerializedSpan[],
	exporter: SpanExporter | null,
	logger?: Pick<Logger, "warn">,
): void {
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

	exporter.export(readableSpans as ReadableSpan[], (result) => {
		const states = exportFailureStates.get(exporter) ?? new Map<string, ExportFailureState>();
		exportFailureStates.set(exporter, states);

		if (result.code === 0) {
			// Every open failure episode — including a single failed batch — ends
			// with exactly one recovery warning.
			for (const state of states.values()) {
				logger?.warn("Remote span re-export recovered", {
					error_class: state.errorClass,
					suppressed_failures: state.suppressedFailures,
				});
			}
			states.clear();
			return;
		}

		const failureClass = errorClass(result.error);
		const key = `${result.code}:${failureClass}`;
		const state = states.get(key);
		if (state) {
			state.suppressedFailures++;
			return;
		}

		states.set(key, { errorClass: failureClass, suppressedFailures: 0 });
		logger?.warn("Remote span re-export failed", {
			span_count: spans.length,
			result_code: result.code,
			error_class: failureClass,
		});
	});
}

function nanoToHrTime(nanoStr: string): [number, number] {
	const nano = BigInt(nanoStr);
	const seconds = Number(nano / 1_000_000_000n);
	const nanos = Number(nano % 1_000_000_000n);
	return [seconds, nanos];
}
