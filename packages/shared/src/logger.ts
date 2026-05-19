import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import pinoPretty from "pino-pretty";
import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	/**
	 * True when the underlying logger would emit at `level` given the current
	 * LOG_LEVEL. Useful to short-circuit expensive context-building (e.g.,
	 * stringifying a large request body for debug-level logging).
	 */
	isLevelEnabled(level: LogLevel): boolean;
}

let rootLogger: pino.Logger | undefined;

function getRootLogger(): pino.Logger {
	if (rootLogger) return rootLogger;

	const level = (process.env.LOG_LEVEL || "info") as pino.LevelWithSilent;

	if (level === "silent") {
		rootLogger = pino({
			level,
			mixin() {
				const span = trace.getActiveSpan();
				if (!span) return {};
				const ctx = span.spanContext();
				return {
					trace_id: ctx.traceId,
					span_id: ctx.spanId,
					trace_flags: ctx.traceFlags,
				};
			},
		});
		return rootLogger;
	}

	const logDir = join(process.cwd(), "logs");
	mkdirSync(logDir, { recursive: true });
	const logFile = join(logDir, "bound.log");

	// sync: true — opens the file synchronously so that it is ready before the
	// first log write. This prevents "sonic boom is not ready yet" crashes when
	// the process exits quickly after startup.
	const fileStream = pino.destination({ dest: logFile, sync: true });
	const streams: pino.StreamEntry[] = [{ stream: fileStream, level }];

	if (process.env.BOUND_LOG_STDERR !== "0") {
		streams.push({
			stream: pinoPretty({
				destination: 2,
				colorize: true,
				translateTime: "HH:MM:ss.l",
				ignore: "pid,hostname",
				messageFormat: "[{package}/{component}] {msg}",
			}),
			level,
		});
	}

	rootLogger = pino(
		{
			level,
			mixin() {
				const span = trace.getActiveSpan();
				if (!span) return {};
				const ctx = span.spanContext();
				return {
					trace_id: ctx.traceId,
					span_id: ctx.spanId,
					trace_flags: ctx.traceFlags,
				};
			},
		},
		pino.multistream(streams),
	);

	return rootLogger;
}

export function createLogger(pkg: string, component: string): Logger {
	const child = getRootLogger().child({ package: pkg, component });

	return {
		debug: (message, context) => child.debug(context ?? {}, message),
		info: (message, context) => child.info(context ?? {}, message),
		warn: (message, context) => child.warn(context ?? {}, message),
		error: (message, context) => child.error(context ?? {}, message),
		isLevelEnabled: (level) => child.isLevelEnabled(level),
	};
}

/**
 * Reset the root logger instance. Used for testing.
 */
export function resetLogger(): void {
	rootLogger = undefined;
}
