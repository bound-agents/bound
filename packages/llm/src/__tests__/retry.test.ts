import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { withRetry } from "../retry";
import { LLMError } from "../types";

describe("withRetry", () => {
	let callCount = 0;
	let startTime = 0;

	beforeEach(() => {
		callCount = 0;
		startTime = Date.now();
	});

	afterEach(() => {
		callCount = 0;
	});

	it("succeeds on first attempt", async () => {
		const fn = async () => {
			callCount++;
			return "success";
		};

		const result = await withRetry(fn);

		expect(result).toBe("success");
		expect(callCount).toBe(1);
	});

	it("retries on 429 error and succeeds", async () => {
		const fn = async () => {
			callCount++;
			if (callCount === 1) {
				throw new LLMError("Rate limit exceeded", "test", 429);
			}
			return "success";
		};

		const result = await withRetry(fn, { baseDelayMs: 50, maxDelayMs: 100 });

		expect(result).toBe("success");
		expect(callCount).toBe(2);
		const elapsed = Date.now() - startTime;
		// Should have delayed at least 50ms
		expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing variance
	});

	it("retries 429 error up to max retries then throws", async () => {
		const fn = async () => {
			callCount++;
			throw new LLMError("Rate limit exceeded", "test", 429);
		};

		await expect(
			withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 }),
		).rejects.toThrow("Rate limit exceeded");

		expect(callCount).toBe(4); // Initial attempt + 3 retries
	});

	it("throws non-429 errors immediately without retry", async () => {
		const fn = async () => {
			callCount++;
			throw new LLMError("Invalid API key", "test", 401);
		};

		await expect(withRetry(fn)).rejects.toThrow("Invalid API key");

		expect(callCount).toBe(1);
	});

	it("retries connection errors once", async () => {
		const fn = async () => {
			callCount++;
			if (callCount === 1) {
				const connError = new Error("ECONNREFUSED");
				throw new LLMError("Failed to connect", "test", undefined, connError);
			}
			return "success";
		};

		const result = await withRetry(fn, { baseDelayMs: 50 });

		expect(result).toBe("success");
		expect(callCount).toBe(2);
	});

	it("throws connection error after one retry", async () => {
		const fn = async () => {
			callCount++;
			const connError = new Error("ECONNREFUSED");
			throw new LLMError("Failed to connect", "test", undefined, connError);
		};

		await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow("Failed to connect");

		expect(callCount).toBe(2); // Initial + 1 retry for connection error
	});

	it("applies exponential backoff for 429 errors", async () => {
		const delays: number[] = [];
		let lastTime = Date.now();

		const fn = async () => {
			callCount++;
			if (callCount > 1) {
				const now = Date.now();
				delays.push(now - lastTime);
				lastTime = now;
			}
			if (callCount <= 3) {
				throw new LLMError("Rate limit exceeded", "test", 429);
			}
			return "success";
		};

		const result = await withRetry(fn, {
			maxRetries: 3,
			baseDelayMs: 50,
			maxDelayMs: 1000,
		});

		expect(result).toBe("success");
		expect(callCount).toBe(4);
		expect(delays.length).toBe(3);

		// Verify exponential backoff: 50ms, 100ms, 200ms (with some tolerance)
		expect(delays[0]).toBeGreaterThanOrEqual(40);
		expect(delays[0]).toBeLessThan(80);

		expect(delays[1]).toBeGreaterThanOrEqual(90);
		expect(delays[1]).toBeLessThan(140);

		expect(delays[2]).toBeGreaterThanOrEqual(180);
		expect(delays[2]).toBeLessThan(250);
	});

	it("respects maxDelayMs cap", async () => {
		const delays: number[] = [];
		let lastTime = Date.now();

		const fn = async () => {
			callCount++;
			if (callCount > 1) {
				const now = Date.now();
				delays.push(now - lastTime);
				lastTime = now;
			}
			if (callCount <= 2) {
				throw new LLMError("Rate limit exceeded", "test", 429);
			}
			return "success";
		};

		const result = await withRetry(fn, {
			maxRetries: 3,
			baseDelayMs: 100,
			maxDelayMs: 150,
		});

		expect(result).toBe("success");
		expect(callCount).toBe(3);

		// First delay: 100ms (baseDelayMs * 2^0)
		expect(delays[0]).toBeGreaterThanOrEqual(90);
		expect(delays[0]).toBeLessThan(140);

		// Second delay: capped at 150ms (would be 200ms without cap)
		expect(delays[1]).toBeGreaterThanOrEqual(140);
		expect(delays[1]).toBeLessThan(180);
	});

	it("handles non-LLMError by throwing immediately", async () => {
		const fn = async () => {
			callCount++;
			throw new Error("Regular error");
		};

		await expect(withRetry(fn)).rejects.toThrow("Regular error");

		expect(callCount).toBe(1);
	});

	it("allows custom retry config", async () => {
		const fn = async () => {
			callCount++;
			if (callCount <= 2) {
				throw new LLMError("Rate limit exceeded", "test", 429);
			}
			return "success";
		};

		const result = await withRetry(fn, {
			maxRetries: 5,
			baseDelayMs: 20,
			maxDelayMs: 500,
		});

		expect(result).toBe("success");
		expect(callCount).toBe(3);
	});
});
