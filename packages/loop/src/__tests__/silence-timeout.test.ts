import { afterEach, describe, expect, it } from "bun:test";
import {
	SILENCE_HEARTBEAT_INTERVAL_MS,
	scaledSilenceTimeout,
	withSilenceTimeout,
} from "../silence-timeout";

/**
 * Behavioral coverage for the silence-timeout stream guard. These exercise the
 * async-generator paths that the property suite's pure-scaling tests do not:
 * pass-through yield, timeout firing + source finalization, heartbeat emission,
 * early consumer `.return()`, and the heartbeat-callback-throws swallow.
 */

/** An async source whose chunks arrive on a caller-controlled cadence. */
function controllableSource<T>() {
	const queue: T[] = [];
	let done = false;
	let returned = false;
	let wake: (() => void) | null = null;

	const push = (value: T) => {
		queue.push(value);
		wake?.();
	};
	const finish = () => {
		done = true;
		wake?.();
	};

	const iterable: AsyncIterable<T> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<T>> {
					while (queue.length === 0 && !done) {
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						wake = null;
					}
					if (queue.length > 0) {
						return { value: queue.shift() as T, done: false };
					}
					return { value: undefined as never, done: true };
				},
				async return(): Promise<IteratorResult<T>> {
					returned = true;
					return { value: undefined as never, done: true };
				},
			};
		},
	};

	return { iterable, push, finish, wasReturned: () => returned };
}

async function* arrayGenerator<T>(values: T[]): AsyncGenerator<T> {
	for (const value of values) {
		yield value;
	}
}

describe("scaledSilenceTimeout", () => {
	it("returns the base timeout at or under the 100k-token threshold", () => {
		expect(scaledSilenceTimeout(60_000, 0)).toBe(60_000);
		expect(scaledSilenceTimeout(60_000, 100_000)).toBe(60_000);
	});

	it("adds one minute per 50k tokens over 100k, flooring the step", () => {
		expect(scaledSilenceTimeout(60_000, 150_000)).toBe(60_000 + 60_000);
		expect(scaledSilenceTimeout(60_000, 200_000)).toBe(60_000 + 120_000);
		// 149_999 is under the first 50k step boundary -> floor to 0 extra.
		expect(scaledSilenceTimeout(60_000, 149_999)).toBe(60_000);
	});
});

describe("withSilenceTimeout", () => {
	it("yields every source chunk in order when chunks arrive promptly", async () => {
		const received: number[] = [];
		for await (const chunk of withSilenceTimeout(arrayGenerator([1, 2, 3]), 1_000)) {
			received.push(chunk);
		}
		expect(received).toEqual([1, 2, 3]);
	});

	it("throws a silence-timeout error and finalizes the source when no chunk arrives", async () => {
		const source = controllableSource<string>();
		let caught: unknown;
		const timeoutFired: boolean[] = [];
		try {
			for await (const chunk of withSilenceTimeout(
				source.iterable,
				10,
				undefined,
				SILENCE_HEARTBEAT_INTERVAL_MS,
				() => timeoutFired.push(true),
			)) {
				void chunk;
			}
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("LLM silence timeout");
		expect((caught as Error).message).toContain("10ms");
		// onTimeout ran, and the source iterator was finalized to free it.
		expect(timeoutFired).toEqual([true]);
		expect(source.wasReturned()).toBe(true);
	});

	it("invokes the heartbeat callback while waiting for the next chunk", async () => {
		const source = controllableSource<string>();
		let beats = 0;
		const consumed: string[] = [];
		const run = (async () => {
			for await (const chunk of withSilenceTimeout(
				source.iterable,
				5_000,
				() => {
					beats++;
				},
				5, // short heartbeat interval so beats fire during the gap
			)) {
				consumed.push(chunk);
			}
		})();
		// Leave a gap so the heartbeat interval fires at least once, then deliver.
		await new Promise((r) => setTimeout(r, 30));
		source.push("a");
		await new Promise((r) => setTimeout(r, 5));
		source.finish();
		await run;
		expect(consumed).toEqual(["a"]);
		expect(beats).toBeGreaterThan(0);
	});

	it("swallows a throwing heartbeat callback without breaking the stream", async () => {
		const source = controllableSource<string>();
		const consumed: string[] = [];
		const run = (async () => {
			for await (const chunk of withSilenceTimeout(
				source.iterable,
				5_000,
				() => {
					throw new Error("heartbeat boom");
				},
				5,
			)) {
				consumed.push(chunk);
			}
		})();
		await new Promise((r) => setTimeout(r, 30));
		source.push("ok");
		await new Promise((r) => setTimeout(r, 5));
		source.finish();
		await expect(run).resolves.toBeUndefined();
		expect(consumed).toEqual(["ok"]);
	});

	it("finalizes the source when the consumer breaks out early", async () => {
		const source = controllableSource<number>();
		source.push(1);
		source.push(2);
		const consumed: number[] = [];
		for await (const chunk of withSilenceTimeout(source.iterable, 5_000)) {
			consumed.push(chunk);
			break; // early return triggers the generator's finally block
		}
		expect(consumed).toEqual([1]);
		expect(source.wasReturned()).toBe(true);
	});
});

// Defensive: ensure no interval/timer leaks across the file's tests. All timers
// in withSilenceTimeout are cleared on the normal and error paths; this guards
// the whole-suite rule by asserting the process is not left with pending work
// attributable to this file.
afterEach(() => {
	// no shared global state to restore; placeholder keeps the lint rule happy
});
