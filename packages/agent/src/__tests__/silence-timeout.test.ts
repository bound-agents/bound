import { describe, expect, it } from "bun:test";
import { withSilenceTimeout } from "../agent-loop";

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
});
