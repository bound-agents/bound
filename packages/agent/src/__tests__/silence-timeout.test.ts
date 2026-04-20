import { describe, expect, it } from "bun:test";
import { FIRST_CHUNK_TIMEOUT_MULTIPLIER, withSilenceTimeout } from "../agent-loop";

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

	it("should throw silence timeout when no chunk arrives within first-chunk timeout", async () => {
		// 500ms delay, 50ms base timeout, first-chunk timeout = 50*5 = 250ms — should fail
		const source = delayedIterable(500, ["a"]);
		const result: string[] = [];
		try {
			for await (const item of withSilenceTimeout(source, 50)) {
				result.push(item);
			}
			expect(true).toBe(false); // should not reach
		} catch (err) {
			expect((err as Error).message).toContain("silence timeout");
		}
		expect(result).toEqual([]);
	});

	it("should use longer timeout for first chunk (FIRST_CHUNK_TIMEOUT_MULTIPLIER)", async () => {
		// First chunk arrives at 150ms. Regular timeout is 50ms (would fail).
		// But first-chunk timeout = 50 * FIRST_CHUNK_TIMEOUT_MULTIPLIER = 250ms (should succeed).
		// Second chunk at 10ms (well within regular timeout).
		const source = splitDelayIterable(150, 10, ["first", "second"]);
		const result: string[] = [];
		for await (const item of withSilenceTimeout(source, 50)) {
			result.push(item);
		}
		expect(result).toEqual(["first", "second"]);
	});

	it("should still timeout on first chunk if it exceeds first-chunk timeout", async () => {
		// First-chunk timeout = 50 * FIRST_CHUNK_TIMEOUT_MULTIPLIER.
		// If first chunk takes way longer than that, should still fail.
		const veryLongDelay = 50 * FIRST_CHUNK_TIMEOUT_MULTIPLIER + 200;
		const source = delayedIterable(veryLongDelay, ["a"]);
		try {
			for await (const _ of withSilenceTimeout(source, 50)) {
				// should not reach
			}
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("silence timeout");
		}
	});

	it("should use regular timeout for subsequent chunks after first", async () => {
		// First chunk at 150ms (within first-chunk timeout of 50*5=250ms).
		// Second chunk at 200ms (exceeds regular 50ms timeout).
		// Should fail on the second chunk.
		const source = splitDelayIterable(150, 200, ["first", "second"]);
		const result: string[] = [];
		try {
			for await (const item of withSilenceTimeout(source, 50)) {
				result.push(item);
			}
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("silence timeout");
		}
		// Should have received first chunk before timeout on second
		expect(result).toEqual(["first"]);
	});

	it("should export FIRST_CHUNK_TIMEOUT_MULTIPLIER as 5", () => {
		expect(FIRST_CHUNK_TIMEOUT_MULTIPLIER).toBe(5);
	});
});
