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
 */
export function createLoggingFetch(logger: Logger, provider: string): typeof fetch {
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
		return globalThis.fetch(input, init);
	};
	return wrapped as typeof fetch;
}
