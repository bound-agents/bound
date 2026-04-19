import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger, ensureLogDirs } from "../logging";

describe("logging", () => {
	let testDir: string;

	beforeEach(() => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-logging-test-${hex}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("ensureLogDirs", () => {
		it("creates logs directory", () => {
			ensureLogDirs(testDir);
			const logsDir = join(testDir, "logs");
			// Check that directory exists by checking we can access it
			const testFile = join(logsDir, "test.txt");
			expect(() => {
				// Try to write and read a test file in the created directory
				writeFileSync(testFile, "test");
				readFileSync(testFile, "utf-8");
			}).not.toThrow();
		});
	});

	describe("AppLogger", () => {
		it("writes info messages as JSON lines to application.log", () => {
			const logger = new AppLogger(testDir);
			logger.info("app_started", { version: "1.0.0" });
			logger.close();

			const logPath = join(testDir, "logs", "application.log");
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines.length).toBe(1);
			const entry = JSON.parse(lines[0]);
			expect(entry.ts).toBeDefined();
			expect(entry.level).toBe("INFO");
			expect(entry.pid).toBe(process.pid);
			expect(entry.event).toBe("app_started");
			expect(entry.version).toBe("1.0.0");
		});

		it("writes warn messages as JSON lines to application.log", () => {
			const logger = new AppLogger(testDir);
			logger.warn("config_missing", { detail: "using defaults" });
			logger.close();

			const logPath = join(testDir, "logs", "application.log");
			const content = readFileSync(logPath, "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.level).toBe("WARN");
			expect(entry.event).toBe("config_missing");
			expect(entry.detail).toBe("using defaults");
		});

		it("writes error messages as JSON lines to application.log", () => {
			const logger = new AppLogger(testDir);
			logger.error("connection_failed", { error: "ECONNREFUSED", code: 111 });
			logger.close();

			const logPath = join(testDir, "logs", "application.log");
			const content = readFileSync(logPath, "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.level).toBe("ERROR");
			expect(entry.event).toBe("connection_failed");
			expect(entry.error).toBe("ECONNREFUSED");
		});

		it("writes debug messages to connection log only", () => {
			const logger = new AppLogger(testDir);
			logger.openConnectionLog(testDir, "thread-123", "conn-456");
			logger.debug("detail", { data: "test" });
			logger.close();

			// Application log should not exist or be empty
			const appLogPath = join(testDir, "logs", "application.log");
			let appContent = "";
			try {
				appContent = readFileSync(appLogPath, "utf-8").trim();
			} catch {
				// File might not exist, which is fine
			}
			expect(appContent).toBe("");

			// Connection log should have the debug entry
			const connLogPath = join(testDir, "logs", "thread-123", "conn-456.log");
			const content = readFileSync(connLogPath, "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.level).toBe("DEBUG");
			expect(entry.event).toBe("detail");
			expect(entry.data).toBe("test");
		});

		it("openConnectionLog creates thread subdirectory", () => {
			const logger = new AppLogger(testDir);
			logger.openConnectionLog(testDir, "thread-xyz", "conn-abc");
			logger.info("test", { msg: "in app log" });
			logger.debug("test", { msg: "in conn log" });
			logger.close();

			const threadDir = join(testDir, "logs", "thread-xyz");
			const connLog = join(threadDir, "conn-abc.log");
			const content = readFileSync(connLog, "utf-8");

			expect(content.trim().length).toBeGreaterThan(0);
		});

		it("openMcpStderrLog returns correct path", () => {
			const logger = new AppLogger(testDir);
			const stderrPath = logger.openMcpStderrLog(testDir, "thread-123", "conn-456", "github");
			logger.close();

			expect(stderrPath).toBe(join(testDir, "logs", "thread-123", "conn-456-github.log"));
		});

		it("closeConnectionLog stops writing to connection log", () => {
			const logger = new AppLogger(testDir);
			logger.openConnectionLog(testDir, "thread-1", "conn-1");
			logger.debug("first", { count: 1 });
			logger.closeConnectionLog();

			// After closing, debug should not be written anywhere
			logger.debug("second", { count: 2 });

			const connLogPath = join(testDir, "logs", "thread-1", "conn-1.log");
			const content = readFileSync(connLogPath, "utf-8");
			const lines = content.trim().split("\n");

			// Should only have the first debug message
			expect(lines.length).toBe(1);
			expect(JSON.parse(lines[0]).count).toBe(1);

			logger.close();
		});

		it("close releases file descriptors without errors", () => {
			const logger = new AppLogger(testDir);
			logger.info("test", { msg: "test" });
			logger.openConnectionLog(testDir, "thread-1", "conn-1");
			logger.debug("test", { msg: "test" });

			// Should not throw
			expect(() => {
				logger.close();
			}).not.toThrow();
		});

		it("multiple log entries are on separate lines", () => {
			const logger = new AppLogger(testDir);
			logger.info("event1", { seq: 1 });
			logger.info("event2", { seq: 2 });
			logger.warn("event3", { seq: 3 });
			logger.close();

			const logPath = join(testDir, "logs", "application.log");
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines.length).toBe(3);
			expect(JSON.parse(lines[0]).seq).toBe(1);
			expect(JSON.parse(lines[1]).seq).toBe(2);
			expect(JSON.parse(lines[2]).seq).toBe(3);
		});
	});
});
