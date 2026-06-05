/**
 * Fetch interceptor that logs outgoing AI SDK request bodies at debug level.
 *
 * The AI SDK provider factories (`createAmazonBedrock`, `createOpenAICompatible`,
 * `createAnthropic`) all accept a custom `fetch` option typed as
 * `(input: RequestInfo, init?: RequestInit) => Promise<Response>`. This
 * factory returns such a function. When installed, every outgoing HTTP call
 * the AI SDK makes to the inference backend is intercepted, and the raw
 * request body is logged via the provided pino-backed Logger.
 *
 * Intentionally body-only — headers are not logged. Request URLs are included
 * for provider/route disambiguation.
 *
 * Gated on `logger.isLevelEnabled("debug")` so info-level runs pay zero cost
 * (no body introspection, no log emission).
 *
 * Delegation note: the wrapper calls `globalThis.fetch(input, init)` at
 * invocation time rather than capturing a bound reference at construction
 * time. Some tests replace `global.fetch` with a mock after this factory
 * runs; late-binding ensures those mocks are honored. See the
 * `global.fetch pollution` gotcha in CONTRIBUTING.md.
 */

import type { Logger } from "@bound/shared";

/**
 * Extract a loggable string representation of a fetch request body without
 * consuming ReadableStreams (which would break the real request).
 */
function readBodyForLog(body: BodyInit | null | undefined): string {
	if (body === null || body === undefined) return "";
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Uint8Array) {
		try {
			return new TextDecoder().decode(body);
		} catch {
			return `[binary body: Uint8Array length=${body.byteLength}]`;
		}
	}
	if (body instanceof ArrayBuffer) {
		try {
			return new TextDecoder().decode(new Uint8Array(body));
		} catch {
			return `[binary body: ArrayBuffer byteLength=${body.byteLength}]`;
		}
	}
	// FormData / Blob / ReadableStream — we don't try to consume these, both
	// because it could break the request (ReadableStream is one-shot) and
	// because AI SDK providers don't use them for inference calls in practice.
	const ctor = (body as object).constructor?.name ?? typeof body;
	return `[non-string body: ${ctor}]`;
}

function extractUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	// Request-like object with a `url` property.
	return (input as Request).url;
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
): typeof fetch {
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (logger.isLevelEnabled("debug")) {
			const body = readBodyForLog(init?.body);
			logger.debug(`[ai-sdk:${provider}] outgoing request body`, {
				provider,
				url: extractUrl(input),
				method: init?.method ?? "GET",
				body,
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
		const timer = setTimeout(() => {
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
			clearTimeout(timer);
			return res;
		} catch (err) {
			clearTimeout(timer);
			throw err;
		}
	};
	return wrapped as typeof fetch;
}
