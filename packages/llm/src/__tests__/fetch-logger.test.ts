/**
 * Unit tests for the AI SDK fetch interceptor.
 *
 * Request diagnostics must retain safe request-shape evidence without ever
 * serializing prompts, memory, tool payloads, or file content.
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

	it("logs a redacted JSON request shape at debug level", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug", "info", "warn", "error"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const secret = "sk-live-secret";
		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped("https://bedrock.example.com/model/invoke", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-test",
				messages: [
					{ role: "system", content: `semantic-memory ${secret}` },
					{ role: "user", content: `user text ${secret}` },
				],
				tools: [{ name: "lookup", input_schema: { secret } }],
				tool_choice: { type: "tool", name: "lookup" },
				file: { data: `file-like ${secret}` },
			}),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].level).toBe("debug");
		expect(captured[0].message).toContain("outgoing request shape");
		expect(captured[0].context).toMatchObject({
			provider: "bedrock",
			method: "POST",
			endpoint: "https://bedrock.example.com/model/invoke",
			bodyKind: "json",
			model: "claude-test",
			roleCounts: { system: 1, user: 1 },
			toolCount: 1,
			toolNames: ["lookup"],
		});
		const emitted = JSON.stringify(captured[0]);
		expect(emitted).not.toContain(secret);
		expect(emitted).not.toContain("semantic-memory");
		expect(emitted).not.toContain("user text");
		expect(emitted).not.toContain("file-like");
		expect(captured[0].context).not.toHaveProperty("body");
	});

	it("does not serialize a body when debug logging is disabled", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["info", "warn", "error"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
		const body = {
			toString() {
				throw new Error("body must not be serialized");
			},
		} as unknown as BodyInit;

		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped("https://bedrock.example.com/invoke", { method: "POST", body });

		expect(captured).toHaveLength(0);
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

	it("summarizes stream and binary bodies without consuming or decoding their content", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		let downstreamBody: BodyInit | null | undefined;
		globalThis.fetch = (async (_input, init) => {
			downstreamBody = init?.body;
			return new Response("ok");
		}) as typeof fetch;

		const streamSecret = "stream-secret";
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`tool arguments ${streamSecret}`));
				controller.close();
			},
		});
		const wrapped = createLoggingFetch(logger, "openai-compatible");
		await wrapped("https://example.com/v1/chat/completions", { method: "POST", body: stream });

		expect(downstreamBody).toBe(stream);
		expect(captured[0].context).toMatchObject({ bodyKind: "stream" });
		expect(JSON.stringify(captured[0])).not.toContain(streamSecret);

		const binarySecret = "binary-file-secret";
		const bytes = new TextEncoder().encode(binarySecret);
		await wrapped("https://example.com/v1/chat/completions", { method: "POST", body: bytes });
		expect(captured[1].context).toMatchObject({ bodyKind: "binary", bodySize: bytes.byteLength });
		expect(JSON.stringify(captured[1])).not.toContain(binarySecret);
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

		expect(captured[0].context?.endpoint).toBe("https://req.example.com/invoke");
	});

	it("extracts URL from URL object input", async () => {
		const { logger, captured } = makeLogger(new Set<LogLevel>(["debug"]));
		globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

		const wrapped = createLoggingFetch(logger, "bedrock");
		await wrapped(new URL("https://url.example.com/invoke"), { method: "POST", body: "{}" });

		expect(captured[0].context?.endpoint).toBe("https://url.example.com/invoke");
	});

	describe("connect / time-to-first-byte deadline (connectTimeoutMs)", () => {
		interface ControlledTimer {
			callback: () => void;
			cleared: boolean;
		}

		function controlledTimeoutScheduler() {
			const timers: ControlledTimer[] = [];
			return {
				schedule(callback: () => void): ControlledTimer {
					const timer = { callback, cleared: false };
					timers.push(timer);
					return timer;
				},
				clear(timer: ControlledTimer) {
					timer.cleared = true;
				},
				fireAll() {
					for (const timer of timers) if (!timer.cleared) timer.callback();
				},
			};
		}

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
			const scheduler = controlledTimeoutScheduler();
			let capturedSignal: AbortSignal | undefined;
			globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
				capturedSignal = init?.signal ?? undefined;
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch;

			const wrapped = createLoggingFetch(logger, "bedrock", 30, scheduler);
			const res = await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(await res.text()).toBe("ok");

			// Headers arrived → the deadline was cleared, so firing every
			// scheduled timeout cannot abort the body-governing signal.
			scheduler.fireAll();
			expect(capturedSignal?.aborted).toBe(false);
		});

		it("honors an inbound init.signal before the deadline", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			const scheduler = controlledTimeoutScheduler();
			globalThis.fetch = hangingFetch();

			const wrapped = createLoggingFetch(logger, "bedrock", 10_000, scheduler);
			const agentLoop = new AbortController();
			const request = wrapped("https://x/", {
				method: "POST",
				body: "{}",
				signal: agentLoop.signal,
			});
			agentLoop.abort(new Error("agent-loop silence timeout"));

			await expect(request).rejects.toThrow(/agent-loop silence timeout/);
		});

		it("is a pure passthrough when the deadline is unset or <= 0 (no signal injected)", async () => {
			const { logger } = makeLogger(new Set<LogLevel>(["info"]));
			let sawSignal: AbortSignal | null = null;
			globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
				sawSignal = init?.signal ?? null;
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch;

			let wrapped = createLoggingFetch(logger, "bedrock");
			await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(sawSignal).toBeNull();

			wrapped = createLoggingFetch(logger, "bedrock", 0);
			await wrapped("https://x/", { method: "POST", body: "{}" });
			expect(sawSignal).toBeNull();
		});
	});
});
