import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Module-level holder for the global trace exporter. `initTelemetry` sets it;
 * trace_data consumers read it without importing the OTel SDK bootstrap.
 */
let globalTraceExporter: SpanExporter | null = null;

export function setTraceExporter(exporter: SpanExporter | null): void {
	globalTraceExporter = exporter;
}

export function getTraceExporter(): SpanExporter | null {
	return globalTraceExporter;
}
