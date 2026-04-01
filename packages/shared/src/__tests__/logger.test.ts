import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, resetLogger } from "../logger.js";

describe("createLogger", () => {
	const logDir = join(process.cwd(), "logs");
	const logFile = join(logDir, "bound.log");

	beforeEach(() => {
		resetLogger();
		if (existsSync(logFile)) rmSync(logFile);
	});

	afterEach(() => {
		resetLogger();
	});

	it("creates a logger instance with all log methods", () => {
		const logger = createLogger("@bound/test", "TestComponent");
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
	});

	it("writes structured JSON to log file", async () => {
		process.env.LOG_LEVEL = "debug";
		const logger = createLogger("@bound/test", "TestComponent");

		logger.info("Test message");

		// pino file destination is async — give it a moment to flush
		await Bun.sleep(100);

		expect(existsSync(logFile)).toBe(true);
		const content = readFileSync(logFile, "utf-8").trim();
		const lines = content.split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const logEntry = JSON.parse(lines[lines.length - 1]);
		expect(logEntry.level).toBe(30); // pino info = 30
		expect(logEntry.msg).toBe("Test message");
		expect(logEntry.package).toBe("@bound/test");
		expect(logEntry.component).toBe("TestComponent");
		expect(logEntry.time).toBeDefined();
	});

	it("includes context in log output", async () => {
		process.env.LOG_LEVEL = "debug";
		const logger = createLogger("@bound/test", "TestComponent");

		logger.warn("Test warning", { userId: "user-123", action: "delete" });

		await Bun.sleep(100);

		const content = readFileSync(logFile, "utf-8").trim();
		const lines = content.split("\n").filter(Boolean);
		const logEntry = JSON.parse(lines[lines.length - 1]);
		expect(logEntry.userId).toBe("user-123");
		expect(logEntry.action).toBe("delete");
	});

	it("respects LOG_LEVEL environment variable", async () => {
		process.env.LOG_LEVEL = "error";
		const logger = createLogger("@bound/test", "TestComponent");

		logger.debug("Debug message");
		logger.info("Info message");
		logger.warn("Warn message");
		logger.error("Error message");

		await Bun.sleep(100);

		const content = readFileSync(logFile, "utf-8").trim();
		const lines = content.split("\n").filter(Boolean);
		expect(lines.length).toBe(1);

		const logEntry = JSON.parse(lines[0]);
		expect(logEntry.level).toBe(50); // pino error = 50
	});

	it("defaults to info level when LOG_LEVEL not set", async () => {
		delete process.env.LOG_LEVEL;
		const logger = createLogger("@bound/test", "TestComponent");

		logger.debug("Debug message");
		logger.info("Info message");

		await Bun.sleep(100);

		const content = readFileSync(logFile, "utf-8").trim();
		const lines = content.split("\n").filter(Boolean);
		expect(lines.length).toBe(1);

		const logEntry = JSON.parse(lines[0]);
		expect(logEntry.msg).toBe("Info message");
	});

	it("creates logs directory automatically", () => {
		process.env.LOG_LEVEL = "info";
		createLogger("@bound/test", "TestComponent");
		expect(existsSync(logDir)).toBe(true);
	});
});
