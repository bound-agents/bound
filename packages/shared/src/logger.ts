import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import pinoPretty from "pino-pretty";

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

	const level = (process.env.LOG_LEVEL || "info") as LogLevel;

	const logDir = join(process.cwd(), "logs");
	mkdirSync(logDir, { recursive: true });
	const logFile = join(logDir, "bound.log");

	const prettyStream = pinoPretty({
		destination: 2,
		colorize: true,
		translateTime: "HH:MM:ss.l",
		ignore: "pid,hostname",
		messageFormat: "[{package}/{component}] {msg}",
	});

	const fileStream = pino.destination({ dest: logFile, sync: false });

	rootLogger = pino(
		{ level },
		pino.multistream([
			{ stream: prettyStream, level },
			{ stream: fileStream, level },
		]),
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
