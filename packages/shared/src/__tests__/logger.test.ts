import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLogger } from "../logger.js";

describe("createLogger", () => {
	let originalEnv: string | undefined;
	let stderrOutput: string[] = [];

	beforeEach(() => {
		originalEnv = process.env.LOG_LEVEL;
		stderrOutput = [];

		// @ts-expect-error - mocking console.error
		console.error = (...args: string[]) => {
			stderrOutput.push(
				...args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))),
			);
		};
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			process.env.LOG_LEVEL = undefined;
		} else {
			process.env.LOG_LEVEL = originalEnv;
		}
	});

	it("creates a logger instance", () => {
		const logger = createLogger("@bound/test", "TestComponent");
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
	});

	it("logs messages with correct structure", () => {
		const logger = createLogger("@bound/test", "TestComponent");
		process.env.LOG_LEVEL = "debug";

		stderrOutput = [];
		logger.info("Test message");

		expect(stderrOutput.length).toBeGreaterThan(0);
		const logEntry = JSON.parse(stderrOutput[0]);
		expect(logEntry.level).toBe("info");
		expect(logEntry.message).toBe("Test message");
		expect(logEntry.package).toBe("@bound/test");
		expect(logEntry.component).toBe("TestComponent");
		expect(logEntry.timestamp).toBeDefined();
	});

	it("includes context in log output", () => {
		const logger = createLogger("@bound/test", "TestComponent");
		process.env.LOG_LEVEL = "debug";

		stderrOutput = [];
		logger.warn("Test warning", { userId: "user-123", action: "delete" });

		expect(stderrOutput.length).toBeGreaterThan(0);
		const logEntry = JSON.parse(stderrOutput[0]);
		expect(logEntry.userId).toBe("user-123");
		expect(logEntry.action).toBe("delete");
	});

	it("respects LOG_LEVEL environment variable", () => {
		process.env.LOG_LEVEL = "error";
		const logger = createLogger("@bound/test", "TestComponent");

		stderrOutput = [];
		logger.debug("Debug message");
		logger.info("Info message");
		logger.warn("Warn message");
		logger.error("Error message");

		expect(stderrOutput.length).toBe(1);
		const logEntry = JSON.parse(stderrOutput[0]);
		expect(logEntry.level).toBe("error");
	});

	it("defaults to info level when LOG_LEVEL not set", () => {
		process.env.LOG_LEVEL = undefined;
		const logger = createLogger("@bound/test", "TestComponent");

		stderrOutput = [];
		logger.debug("Debug message");
		logger.info("Info message");

		expect(stderrOutput.length).toBe(1);
		const logEntry = JSON.parse(stderrOutput[0]);
		expect(logEntry.level).toBe("info");
	});

	it("outputs valid JSON to stderr", () => {
		const logger = createLogger("@bound/test", "TestComponent");
		process.env.LOG_LEVEL = "debug";

		stderrOutput = [];
		logger.error("Error test", { code: 500 });

		expect(stderrOutput.length).toBeGreaterThan(0);
		const logEntry = JSON.parse(stderrOutput[0]);
		expect(logEntry.level).toBe("error");
		expect(logEntry.message).toBe("Error test");
		expect(logEntry.code).toBe(500);
	});
});
