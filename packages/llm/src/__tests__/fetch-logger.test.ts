/**
 * Unit tests for the AI SDK fetch interceptor.
 *
 * The interceptor must:
 *   1. Skip body introspection when LOG_LEVEL disables debug.
 *   2. Log the raw request body at debug level when enabled.
 *   3. Delegate to `globalThis.fetch` at call time (not construction time) so
 *      tests and production monkey-patches of `global.fetch` still work. See
 *      CONTRIBUTING.md "global.fetch pollution" gotcha.
 *   4. Never attempt to consume ReadableStream / FormData / Blob bodies —
 *      doing so would break the real request.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LogLevel, Logger } from "@bound/shared";
import { createLoggingFetch } from "../fetch-logger";

interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	context?: Record<string, unknown>;
}

function makeLogger(enabled: Set<LogLevel>): { logger: Logger; captured: CapturedLog[] } {
	const captured: CapturedLog[] = [];
	const push =
		(level: CapturedLog["level"]) => (message: string, context?: Record<string, unknown>) => {
			captured.push({ level, message, context });
		};
	const logger: Logger = {
		debug: push("debug"),
		info: push("info"),
		warn: push("warn"),
		error: push("error"),
		isLevelEnabled: (level) => enabled.has(level),
	};
	return { logger, captured };
}

describe("createLoggingFetch", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		// Each test installs its own mock via globalThis.fetch.
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("logs the request body at debug level when debug is enabled", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug", "info", "warn", "error"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped("https://bedrock.example.com/invoke", {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});

		expect(captured.length).toBe(1);
		expect(captured[0].level).toBe("debug");
		expect(captured[0].message).toContain("outgoing request body");
		expect(captured[0].context?.provider).toBe("bedrock");
		expect(captured[0].context?.url).toBe("https://bedrock.example.com/invoke");
		expect(captured[0].context?.method).toBe("POST");
		expect(captured[0].context?.body).toBe(
			JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		);
	});

	it("skips logging when debug is disabled (zero-cost at info level)", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["info", "warn", "error"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped("https://bedrock.example.com/invoke", {
			method: "POST",
			body: "huge payload that would be expensive to touch",
		});

		expect(captured.length).toBe(0);
	});

	it("uses globalThis.fetch at call time, not at construction time", async () => {
		const { logger } = makeLogger(new Set<LogLevel>(["info"]));

		// Construct the wrapper while fetch points at a failing mock...
		let usedEarlyFetch = false;
		globalThis.fetch = (async () => {
			usedEarlyFetch = true;
			return new Response("early");
		}) as typeof fetch;
		const wrapped = createLoggingFetch(logger, "openai-compatible");

		// ...then swap it out before the wrapper is actually called.
		let usedLateFetch = false;
		globalThis.fetch = (async () => {
			usedLateFetch = true;
			return new Response("late");
		}) as typeof fetch;

		const res = await wrapped("https://example.com/", { method: "POST", body: "{}" });
		expect(await res.text()).toBe("late");
		expect(usedLateFetch).toBe(true);
		expect(usedEarlyFetch).toBe(false);
	});

	it("emits a safe sentinel for Blob bodies without consuming them", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));

		let downstreamBody: BodyInit | null | undefined;
		globalThis.fetch = (async (_input, init) => {
			downstreamBody = init?.body;
			return new Response("ok");
		}) as typeof fetch;

		const blob = new Blob(['{"hello":"world"}'], { type: "application/json" });

		const wrapped = createLoggingFetch(logger, "openai-compatible");
		await wrapped("https://example.com/", { method: "POST", body: blob });

		// Blob handed through untouched — the interceptor never consumed it.
		expect(downstreamBody).toBe(blob);
		expect(captured.length).toBe(1);
		expect(typeof captured[0].context?.body).toBe("string");
		expect(captured[0].context?.body as string).toMatch(/^\[non-string body:/);
	});

	it("emits a safe sentinel for FormData bodies", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const form = new FormData();
		form.append("k", "v");

		const wrapped = createLoggingFetch(logger, "openai-compatible");
		await wrapped("https://example.com/", { method: "POST", body: form });

		expect(captured.length).toBe(1);
		expect(captured[0].context?.body as string).toMatch(/^\[non-string body:/);
	});

	it("handles Uint8Array bodies by decoding as text", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		const bytes = new TextEncoder().encode('{"hello":"world"}');
		await wrapped("https://example.com/", { method: "POST", body: bytes });

		expect(captured[0].context?.body).toBe('{"hello":"world"}');
	});

	it("extracts URL from Request-like input", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		const req = new Request("https://req.example.com/invoke", {
			method: "POST",
			body: "{}",
		});
		await wrapped(req);

		expect(captured[0].context?.url).toBe("https://req.example.com/invoke");
	});

	it("extracts URL from URL object input", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped(new URL("https://url.example.com/invoke"), { method: "POST", body: "{}" });

		expect(captured[0].context?.url).toBe("https://url.example.com/invoke");
	});

	describe("connect / time-to-first-byte deadline (connectTimeoutMs)", () => {
		// A fetch mock that never resolves on its own but rejects when the
		// passed-in signal aborts — mimicking globalThis.fetch's behavior on a
		// silently-hanging connection (the production Bedrock failure shape).
		function hangingFetch(): typeof fetch {
			return ((_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					if (signal.aborted) {
						reject(signal.reason ?? new Error("aborted"));
						return;
					}
					signal.addEventListener("abort", () => {
						reject(signal.reason ?? new Error("aborted"));
					});
				})) as typeof fetch;
		}

		it("aborts with a self-identifying error when headers don't arrive in time", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			globalThis.fetch = hangingFetch();

			const wrapped = createLoggingFetch(logger, "bedrock", 50);
			await expect(
				wrapped("https://bedrock.example.com/invoke", { method: "POST", body: "{}" }),
			).rejects.toThrow(/no inference response headers from bedrock within 50ms/);
		});

		it("clears the deadline once headers arrive — a slow body is never aborted", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			// Capture the signal the SDK would use to read the streaming body.
			let capturedSignal: AbortSignal | undefined;
			globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
				capturedSignal = init?.signal ?? undefined;
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch;

			const wrapped = createLoggingFetch(logger, "bedrock", 30);
			const res = await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(await res.text()).toBe("ok");

			// Headers arrived → the deadline timer must have been cleared. Wait
			// well past it and assert the body-governing signal never aborted.
			await new Promise((r) => setTimeout(r, 60));
			expect(capturedSignal?.aborted).toBe(false);
		});

		it("honors an inbound init.signal, composed via AbortSignal.any", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			globalThis.fetch = hangingFetch();

			// Long connect deadline so the inbound (agent-loop) signal wins the race.
			const wrapped = createLoggingFetch(logger, "bedrock", 10_000);
			const agentLoop = new AbortController();
			setTimeout(() => agentLoop.abort(new Error("agent-loop silence timeout")), 30);

			await expect(
				wrapped("https://x/", { method: "POST", body: "{}", signal: agentLoop.signal }),
			).rejects.toThrow(/agent-loop silence timeout/);
		});

		it("is a pure passthrough when the deadline is unset or <= 0 (no signal injected)", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			let sawSignal: AbortSignal | null = null;
			globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
				sawSignal = init?.signal ?? null;
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch;

			// Unset → no deadline controller, so no signal is added to a
			// signal-less init.
			let wrapped = createLoggingFetch(logger, "bedrock");
			await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(sawSignal).toBeNull();

			// <= 0 → treated as disabled, same passthrough.
			wrapped = createLoggingFetch(logger, "bedrock", 0);
			await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(sawSignal).toBeNull();
		});
	});
});
