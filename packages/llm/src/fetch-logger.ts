/**
 * Fetch interceptor that emits safe request-shape summaries for outgoing AI
 * SDK calls. Bodies are never logged: they can contain prompts, memory, tool
 * payloads, and files.
 */

import type { Logger } from "@bound/shared";

const MAX_TOOL_NAMES = 10;

type RequestSummary = Record<string, unknown>;

export interface TimeoutScheduler {
	schedule(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

const realTimeoutScheduler: TimeoutScheduler = {
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function byteSize(body: BodyInit): number | undefined {
	if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
	if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
	if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body.byteLength;
	return undefined;
}

function summarizeJsonBody(body: string): RequestSummary {
	const summary: RequestSummary = { bodyKind: "json", bodySize: byteSize(body) };
	try {
		const value: unknown = JSON.parse(body);
		if (!value || typeof value !== "object" || Array.isArray(value)) return summary;
		const record = value as Record<string, unknown>;
		if (typeof record.model === "string") summary.model = record.model;
		const messages = Array.isArray(record.messages) ? record.messages : [];
		if (messages.length > 0) {
			const roleCounts: Record<string, number> = {};
			for (const message of messages) {
				if (!message || typeof message !== "object") continue;
				const role = (message as Record<string, unknown>).role;
				if (typeof role === "string") roleCounts[role] = (roleCounts[role] ?? 0) + 1;
			}
			summary.roleCounts = roleCounts;
		}
		const tools = Array.isArray(record.tools) ? record.tools : [];
		if (tools.length > 0) {
			summary.toolCount = tools.length;
			summary.toolNames = tools
				.slice(0, MAX_TOOL_NAMES)
				.map((tool) =>
					tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : undefined,
				)
				.filter((name): name is string => typeof name === "string");
		}
	} catch {
		// Non-JSON strings are represented only by kind and byte count.
	}
	return summary;
}

function summarizeBody(body: BodyInit | null | undefined): RequestSummary {
	if (body === null || body === undefined) return { bodyKind: "empty", bodySize: 0 };
	if (typeof body === "string") return summarizeJsonBody(body);
	if (body instanceof URLSearchParams) return { bodyKind: "form", bodySize: byteSize(body) };
	if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
		return { bodyKind: "binary", bodySize: byteSize(body) };
	}
	if (body instanceof ReadableStream) return { bodyKind: "stream" };
	return { bodyKind: "opaque", bodySize: byteSize(body) };
}

function extractUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

function endpoint(input: RequestInfo | URL): string {
	const url = new URL(extractUrl(input));
	return `${url.origin}${url.pathname}`;
}

/**
 * Build a fetch function suitable for passing as the `fetch` option to an
 * AI SDK provider factory. Calls through to `globalThis.fetch` and emits a
 * debug log line per request when `LOG_LEVEL=debug`.
 *
 * Return type is `typeof fetch` because the AI SDK provider settings require
 * the full fetch signature (including Node/Bun-specific properties like
 * `preconnect`). We only implement the call signature — the SDK does not
 * invoke `preconnect`, `bind`, etc. on its custom fetch, so the cast is safe.
 *
 * ## Connect / time-to-first-byte deadline (`connectTimeoutMs`)
 *
 * When `connectTimeoutMs > 0`, the wrapper owns an `AbortController` that
 * aborts the request if response headers do not arrive within the deadline.
 * This converts the opaque transport-level wall — observed in production as a
 * bare `TimeoutError` "The operation timed out." with no host status, on the
 * local opus path against a 200k-token prompt — into a deadline we control,
 * carrying a self-identifying error message instead of the ambiguous one.
 *
 * Three properties make this safe:
 *   1. **Headers-scoped, not whole-request.** `globalThis.fetch` resolves the
 *      moment response *headers* arrive; the body streams afterward. We clear
 *      the timer at that point, so a healthy-but-slow stream is never killed
 *      mid-flight. The streaming body remains governed by the agent-loop's
 *      silence timeout, which rides `init.signal` (see below). The production
 *      failure is a *fetch-promise* rejection (no headers ever), which is
 *      exactly time-to-first-byte — what this deadline targets.
 *   2. **Composed, not clobbered.** The agent-loop passes its abort signal all
 *      the way down to this fetch as `init.signal` (agent-loop → ChatParams →
 *      `streamText({ abortSignal })` → SDK fetch). We compose our deadline with
 *      it via `AbortSignal.any` so either can abort; if the agent-loop signal
 *      fires during body streaming, the composed signal still honors it.
 *   3. **Bun imposes no shorter default.** Empirically (Bun 1.3.x) a silent-
 *      hanging connection is not aborted by the runtime, so our deadline is the
 *      controlling timeout rather than racing an internal one.
 *
 * Absent / `<= 0` → no deadline is installed and the call is a pure passthrough
 * (behavior unchanged). This is opt-in per backend via `connect_timeout_ms`.
 */
export function createLoggingFetch(
	logger: Logger,
	provider: string,
	connectTimeoutMs?: number,
	timeoutScheduler: TimeoutScheduler = realTimeoutScheduler,
): typeof fetch {
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (logger.isLevelEnabled("debug")) {
			logger.debug(`[ai-sdk:${provider}] outgoing request shape`, {
				provider,
				endpoint: endpoint(input),
				method: init?.method ?? "GET",
				...summarizeBody(init?.body),
			});
		}

		// No deadline configured → pure passthrough, zero overhead.
		if (connectTimeoutMs === undefined || connectTimeoutMs <= 0) {
			return globalThis.fetch(input, init);
		}

		// Own the abort: a timer fires our controller if headers don't arrive
		// in time, with a message we control. Compose with any inbound signal
		// (the agent-loop silence/inactivity controller) so either can win.
		const deadline = new AbortController();
		const timer = timeoutScheduler.schedule(() => {
			deadline.abort(
				new Error(
					`bound: no inference response headers from ${provider} within ${connectTimeoutMs}ms (connect/TTFB deadline)`,
				),
			);
		}, connectTimeoutMs);

		const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

		try {
			const res = await globalThis.fetch(input, { ...init, signal });
			// Headers received. The body stream that follows is governed by the
			// agent-loop signal (still live on the composed `signal`), not our
			// connect deadline — clear the timer so a slow-but-progressing
			// stream is never aborted.
			timeoutScheduler.clear(timer);
			return res;
		} catch (err) {
			timeoutScheduler.clear(timer);
			throw err;
		}
	};
	return wrapped as typeof fetch;
}
