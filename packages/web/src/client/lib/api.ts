import { hc } from "hono/client";
import type { AppType } from "../../server/routes/index";

/** Fetch signature the typed API client calls through. */
export type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Typed same-origin client for the web router's routes. Paths, methods, inputs,
 * and JSON outputs come from {@link AppType}. The default fetcher resolves
 * `globalThis.fetch` per call, so tests that patch it after import still apply.
 */
export function createApi(fetchFn: ApiFetch = (input, init) => fetch(input, init)) {
	return hc<AppType>("/", { fetch: fetchFn });
}
