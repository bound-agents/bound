import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Module-level holder for the global trace exporter.
 * Used to avoid circular imports between cli/telemetry.ts and agent/relay-stream$.ts.
 *
 * CLI calls setTraceExporter() during startup.
 * Agent calls getTraceExporter() when handling trace_data responses.
 */
let globalTraceExporter: SpanExporter | null = null;

export function setTraceExporter(exporter: SpanExporter | null): void {
	globalTraceExporter = exporter;
}

export function getTraceExporter(): SpanExporter | null {
	return globalTraceExporter;
}
