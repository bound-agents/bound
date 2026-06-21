import { describe, expect, it } from "bun:test";
import type { Logger } from "@bound/shared";
import { mapProviderStream, resolveProviderFetch, runProviderStream } from "../driver-utils";
import { LLMError, type StreamChunk } from "../types";

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

async function* normalAiSdkStream(): AsyncIterable<unknown> {
	yield { type: "text-delta", text: "hello" };
	yield {
		type: "finish",
		finishReason: "stop",
		totalUsage: { inputTokens: 4, outputTokens: 2 },
	};
}

async function* failingAiSdkStream(): AsyncIterable<unknown> {
	yield { type: "text-delta", text: "partial" };
	throw Object.assign(new Error("upstream broke"), { statusCode: 503 });
}

describe("driver stream utilities", () => {
	it("runProviderStream emits the initial heartbeat before mapped stream chunks", async () => {
		const chunks = await collect(
			runProviderStream({
				providerName: "test-provider",
				stream: () => normalAiSdkStream(),
				map: { estimateInputFromMessages: [{ role: "user", content: "hello" }] },
			}),
		);

		expect(chunks[0]).toEqual({ type: "heartbeat" });
		expect(chunks[1]).toEqual({ type: "text", content: "hello" });
		expect(chunks[2]).toMatchObject({
			type: "done",
			usage: { input_tokens: 4, output_tokens: 2 },
			finish_reason: "stop",
		});
	});

	it("mapProviderStream maps stream errors with the owning provider name", async () => {
		const chunks: StreamChunk[] = [];
		let thrown: unknown;

		try {
			for await (const chunk of mapProviderStream({
				providerName: "test-provider",
				stream: () => failingAiSdkStream(),
			})) {
				chunks.push(chunk);
			}
		} catch (err) {
			thrown = err;
		}

		expect(chunks).toEqual([{ type: "text", content: "partial" }]);
		expect(thrown).toBeInstanceOf(LLMError);
		expect((thrown as LLMError).provider).toBe("test-provider");
		expect((thrown as LLMError).statusCode).toBe(503);
	});

	it("mapProviderStream does not emit a heartbeat for retry wrappers", async () => {
		const chunks = await collect(
			mapProviderStream({ providerName: "test-provider", stream: () => normalAiSdkStream() }),
		);

		expect(chunks[0]).toEqual({ type: "text", content: "hello" });
	});
});

describe("provider fetch resolution", () => {
	it("uses an explicit fetch override before logger-backed fetch", () => {
		const explicitFetch: typeof fetch = async () => new Response("ok");
		const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

		expect(
			resolveProviderFetch("test-provider", {
				fetch: explicitFetch,
				logger,
				connectTimeoutMs: 1,
			}),
		).toBe(explicitFetch);
	});

	it("returns undefined when neither fetch nor logger is configured", () => {
		expect(resolveProviderFetch("test-provider", {})).toBeUndefined();
	});

	it("builds a logger-backed fetch when only a logger is configured", () => {
		const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

		expect(typeof resolveProviderFetch("test-provider", { logger })).toBe("function");
	});
});
