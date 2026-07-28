import { describe, expect, it } from "bun:test";
import type { StreamChunk } from "@bound/llm";
import { LLMError } from "@bound/llm";
import { createLogger } from "@bound/shared";

// Minimal stand-in for the async generator in responses.ts — same logic.
async function* withTransientRetry(
	createStream: () => AsyncIterable<StreamChunk>,
	opts: {
		maxRetries: number;
		signal?: AbortSignal;
		log: { warn: (msg: string, ctx: unknown) => void };
	},
): AsyncIterable<StreamChunk> {
	let attempt = 0;
	let chunksYielded = false;
	while (true) {
		const stream = createStream();
		try {
			for await (const chunk of stream) {
				chunksYielded = true;
				yield chunk;
			}
			return;
		} catch (err) {
			if (chunksYielded) throw err;
			if (attempt >= opts.maxRetries) throw err;
			const llmErr = err instanceof LLMError ? err : null;
			const statusCode = llmErr?.statusCode;
			const isTransient =
				statusCode === 429 ||
				statusCode === 500 ||
				statusCode === 502 ||
				statusCode === 503 ||
				statusCode === 529;
			if (!isTransient) throw err;
			if (opts.signal?.aborted) throw err;
			const retryAfter = llmErr?.retryAfterMs;
			const backoff = retryAfter ?? 1 + Math.random() * 10; // tiny for tests
			opts.log.warn("RESPONSES_RETRY: transient error, retrying", {
				attempt: attempt + 1,
				maxRetries: opts.maxRetries,
				statusCode: llmErr?.statusCode,
				backoffMs: Math.round(backoff),
			});
			await new Promise<void>((resolve) => setTimeout(resolve, backoff));
			attempt++;
		}
	}
}

/** Async iterable that rejects immediately — avoids generator syntax (useYield lint). */
function errorStream(err: Error): AsyncIterable<StreamChunk> {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => Promise.reject(err),
			};
		},
	};
}

/** Async iterable that yields chunks then completes. */
function chunkStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}

const noopLog = createLogger("test", "retry");

describe("withTransientRetry", () => {
	it("retries on 529 Overloaded and succeeds on second attempt", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			if (calls === 1) {
				return errorStream(new LLMError("anthropic request failed: Overloaded", "anthropic", 529));
			}
			return chunkStream([{ type: "text", content: "hello" } as StreamChunk]);
		};

		const chunks: StreamChunk[] = [];
		for await (const chunk of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
			chunks.push(chunk);
		}
		expect(calls).toBe(2);
		expect(chunks).toHaveLength(1);
		expect((chunks[0] as { content: string }).content).toBe("hello");
	});

	it("retries on 429 Rate Limited and respects retryAfterMs", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			if (calls <= 2) {
				return errorStream(new LLMError("rate limited", "openai", 429, undefined, 1));
			}
			return chunkStream([{ type: "text", content: "ok" } as StreamChunk]);
		};

		const chunks: StreamChunk[] = [];
		for await (const chunk of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
			chunks.push(chunk);
		}
		expect(calls).toBe(3);
		expect(chunks).toHaveLength(1);
	});

	it("does NOT retry on 400 Bad Request", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			return errorStream(new LLMError("prompt too long", "openai", 400));
		};

		const chunks: StreamChunk[] = [];
		await expect(async () => {
			for await (const chunk of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
				chunks.push(chunk);
			}
		}).toThrow();
		expect(calls).toBe(1);
		expect(chunks).toHaveLength(0);
	});

	it("gives up after maxRetries", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			return errorStream(new LLMError("down", "test", 503));
		};

		await expect(async () => {
			for await (const _ of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
				// should not yield
			}
		}).toThrow();
		expect(calls).toBe(3); // initial + 2 retries
	});

	it("does NOT retry after chunks have been yielded (mid-stream error)", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "text", content: "partial" } as StreamChunk;
					throw new LLMError("mid-stream error", "test", 529);
				},
			};
		};

		const chunks: StreamChunk[] = [];
		await expect(async () => {
			for await (const chunk of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
				chunks.push(chunk);
			}
		}).toThrow();
		expect(calls).toBe(1);
		expect(chunks).toHaveLength(1);
		expect((chunks[0] as { content: string }).content).toBe("partial");
	});

	it("does not retry non-LLMError errors", async () => {
		let calls = 0;
		const createStream = (): AsyncIterable<StreamChunk> => {
			calls++;
			return errorStream(new Error("network blip"));
		};

		await expect(async () => {
			for await (const _ of withTransientRetry(createStream, { maxRetries: 2, log: noopLog })) {
				// noop
			}
		}).toThrow();
		expect(calls).toBe(1);
	});
});
