import { constants, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export function ensureLogDirs(configDir: string): void {
	mkdirSync(join(configDir, "logs"), { recursive: true });
}

export class AppLogger {
	private appFd: number;
	private connFd: number | null = null;
	private connLogPath: string | null = null;

	constructor(configDir: string) {
		ensureLogDirs(configDir);
		const appLogPath = join(configDir, "logs", "application.log");
		this.appFd = openSync(appLogPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
	}

	private writeLog(
		level: "INFO" | "WARN" | "ERROR" | "DEBUG",
		event: string,
		fields: Record<string, unknown>,
		fd: number,
	): void {
		const entry = {
			...fields,
			ts: new Date().toISOString(),
			level,
			pid: process.pid,
			event,
		};
		const line = `${JSON.stringify(entry)}\n`;
		writeSync(fd, line);
	}

	info(event: string, fields: Record<string, unknown> = {}): void {
		this.writeLog("INFO", event, fields, this.appFd);
	}

	warn(event: string, fields: Record<string, unknown> = {}): void {
		this.writeLog("WARN", event, fields, this.appFd);
	}

	error(event: string, fields: Record<string, unknown> = {}): void {
		this.writeLog("ERROR", event, fields, this.appFd);
	}

	debug(event: string, fields: Record<string, unknown> = {}): void {
		if (this.connFd !== null) {
			this.writeLog("DEBUG", event, fields, this.connFd);
		}
	}

	openConnectionLog(configDir: string, threadId: string, connectionId: string): void {
		const threadLogDir = join(configDir, "logs", threadId);
		mkdirSync(threadLogDir, { recursive: true });

		this.connLogPath = join(threadLogDir, `${connectionId}.log`);
		this.connFd = openSync(
			this.connLogPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
		);
	}

	closeConnectionLog(): void {
		if (this.connFd !== null) {
			closeSync(this.connFd);
			this.connFd = null;
			this.connLogPath = null;
		}
	}

	openMcpStderrLog(
		configDir: string,
		threadId: string,
		connectionId: string,
		serverName: string,
	): string {
		const threadLogDir = join(configDir, "logs", threadId);
		mkdirSync(threadLogDir, { recursive: true });
		return join(threadLogDir, `${connectionId}-${serverName}.log`);
	}

	close(): void {
		if (this.connFd !== null) {
			closeSync(this.connFd);
			this.connFd = null;
		}
		closeSync(this.appFd);
	}
}
