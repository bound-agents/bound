export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export function createLogger(pkg: string, component: string): Logger {
	const minLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
	const minLevelValue = LOG_LEVELS[minLevel];

	const log = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
		if (LOG_LEVELS[level] < minLevelValue) {
			return;
		}

		const logEntry = {
			timestamp: new Date().toISOString(),
			level,
			package: pkg,
			component,
			message,
			...(context || {}),
		};

		console.error(JSON.stringify(logEntry));
	};

	return {
		debug: (message, context) => log("debug", message, context),
		info: (message, context) => log("info", message, context),
		warn: (message, context) => log("warn", message, context),
		error: (message, context) => log("error", message, context),
	};
}
