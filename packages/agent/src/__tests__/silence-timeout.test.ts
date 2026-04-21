import { describe, expect, it } from "bun:test";
import { SILENCE_HEARTBEAT_INTERVAL_MS, withSilenceTimeout } from "../agent-loop";

/**
 * Creates an async iterable that delays `delayMs` before each yield.
 */
async function* delayedIterable(delayMs: number, items: string[]): AsyncGenerator<string> {
	for (const item of items) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		yield item;
	}
}

/**
 * Creates an async iterable that delays `firstDelayMs` before the first yield,
 * then `subsequentDelayMs` before subsequent yields.
 */
async function* splitDelayIterable(
	firstDelayMs: number,
	subsequentDelayMs: number,
	items: string[],
): AsyncGenerator<string> {
	for (let i = 0; i < items.length; i++) {
		const delay = i === 0 ? firstDelayMs : subsequentDelayMs;
		await new Promise((resolve) => setTimeout(resolve, delay));
		yield items[i];
	}
}

describe("withSilenceTimeout", () => {
	it("should pass through items from source iterable", async () => {
		const source = delayedIterable(10, ["a", "b", "c"]);
		const result: string[] = [];
		for await (const item of withSilenceTimeout(source, 1000)) {
			result.push(item);
		}
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("should throw silence timeout when no chunk arrives within timeoutMs", async () => {
		const source = delayedIterable(200, ["a"]);
		const result: string[] = [];
		try {
			for await (const item of withSilenceTimeout(source, 50)) {
				result.push(item);
			}
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("silence timeout");
		}
		expect(result).toEqual([]);
	});

	it("should timeout on mid-stream silence", async () => {
		// First chunk at 10ms (within 100ms timeout). Second chunk at 200ms (exceeds 100ms).
		const source = splitDelayIterable(10, 200, ["first", "second"]);
		const result: string[] = [];
		try {
			for await (const item of withSilenceTimeout(source, 100)) {
				result.push(item);
			}
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("silence timeout");
		}
		expect(result).toEqual(["first"]);
	});

	it("heartbeat resets the timer so subsequent data arrives", async () => {
		async function* heartbeatThenData(): AsyncGenerator<string> {
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield "heartbeat";
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield "real-data";
		}

		const result: string[] = [];
		for await (const item of withSilenceTimeout(heartbeatThenData(), 100)) {
			result.push(item);
		}
		expect(result).toEqual(["heartbeat", "real-data"]);
	});

	describe("onHeartbeat callback", () => {
		it("fires onHeartbeat at the configured interval while waiting for next chunk", async () => {
			// One chunk after 150ms, with a 500ms silence timeout and a 30ms
			// heartbeat interval. We expect ~4-5 heartbeats in the 150ms wait.
			const source = delayedIterable(150, ["only-chunk"]);
			let heartbeatCount = 0;
			const result: string[] = [];

			for await (const item of withSilenceTimeout(
				source,
				500,
				() => {
					heartbeatCount++;
				},
				30,
			)) {
				result.push(item);
			}

			expect(result).toEqual(["only-chunk"]);
			// Allow slop for timer jitter but require at least a few heartbeats.
			expect(heartbeatCount).toBeGreaterThanOrEqual(3);
			expect(heartbeatCount).toBeLessThanOrEqual(10);
		});

		it("does not fire onHeartbeat when chunks arrive faster than the interval", async () => {
			// Chunks every 5ms, heartbeat interval 100ms — no heartbeat should fire
			// because each chunk resets the interval before it elapses.
			const source = delayedIterable(5, ["a", "b", "c", "d", "e"]);
			let heartbeatCount = 0;
			const result: string[] = [];

			for await (const item of withSilenceTimeout(
				source,
				500,
				() => {
					heartbeatCount++;
				},
				100,
			)) {
				result.push(item);
			}

			expect(result).toEqual(["a", "b", "c", "d", "e"]);
			expect(heartbeatCount).toBe(0);
		});

		it("still throws silence timeout even when onHeartbeat is provided", async () => {
			// onHeartbeat firing MUST NOT reset the timeout itself — it's a passive
			// observer. The timeout is the actual timeout.
			const source = delayedIterable(500, ["never-arrives-in-time"]);
			let heartbeatCount = 0;

			try {
				for await (const _ of withSilenceTimeout(
					source,
					100,
					() => {
						heartbeatCount++;
					},
					20,
				)) {
					// unreachable
				}
				expect(true).toBe(false);
			} catch (err) {
				expect((err as Error).message).toContain("silence timeout");
			}
			// Some heartbeats should have fired before the timeout tripped.
			expect(heartbeatCount).toBeGreaterThanOrEqual(1);
		});

		it("swallows exceptions thrown from onHeartbeat without breaking the stream", async () => {
			const source = delayedIterable(80, ["a", "b"]);
			let heartbeatCount = 0;
			const result: string[] = [];

			for await (const item of withSilenceTimeout(
				source,
				500,
				() => {
					heartbeatCount++;
					throw new Error("heartbeat callback exploded");
				},
				20,
			)) {
				result.push(item);
			}

			expect(result).toEqual(["a", "b"]);
			expect(heartbeatCount).toBeGreaterThanOrEqual(2);
		});

		it("clears the heartbeat interval after the stream completes", async () => {
			// After the stream finishes, no further heartbeats should fire.
			const source = delayedIterable(20, ["a"]);
			let heartbeatCount = 0;

			for await (const _ of withSilenceTimeout(
				source,
				200,
				() => {
					heartbeatCount++;
				},
				10,
			)) {
				// drain
			}

			const countAtEnd = heartbeatCount;
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(heartbeatCount).toBe(countAtEnd);
		});

		it("clears the heartbeat interval after a timeout rejection", async () => {
			// After the timeout trips, no further heartbeats should fire.
			const source = delayedIterable(500, ["never"]);
			let heartbeatCount = 0;

			try {
				for await (const _ of withSilenceTimeout(
					source,
					50,
					() => {
						heartbeatCount++;
					},
					10,
				)) {
					// unreachable
				}
			} catch {
				// expected
			}

			const countAtRejection = heartbeatCount;
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(heartbeatCount).toBe(countAtRejection);
		});

		it("exports SILENCE_HEARTBEAT_INTERVAL_MS as a sensible default", () => {
			// Lock in the default as part of the public contract — tests and
			// upstream code may rely on this constant being reasonable for
			// production inactivity timers (outer timer is 35 min, inner silence
			// timeout is 10 min; heartbeat must be well below both).
			expect(SILENCE_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(1000);
			expect(SILENCE_HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000);
		});
	});
});
