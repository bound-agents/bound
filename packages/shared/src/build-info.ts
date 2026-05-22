/**
 * Build-time metadata accessor — single source of truth for both `bound` (CLI)
 * and `boundless` (TUI).
 *
 * `scripts/generate-build-info.ts` writes a sibling file `build-info-generated.ts`
 * (gitignored) at build time containing the actual values. This module wraps that
 * generated file with:
 *
 *   - `loadBuildInfo()` — async loader that gracefully falls back to "dev"/"unknown"
 *     when the generated file is absent (e.g. during `bun run` in development, or
 *     when the dev-mode binary entrypoint is invoked).
 *   - `getBuildInfo()` — synchronous getter for use after load. Render paths can
 *     read it without awaiting; the values are constants for the process lifetime.
 *
 * The two-step API matches `prewarmHighlighter`/`getHighlighterSync` from
 * `./syntax.ts`: warm once at startup, read synchronously thereafter. This keeps
 * React render paths sync-friendly while still allowing the dynamic-import
 * fallback for the gitignored file.
 */

export interface BuildInfo {
	/** Short git SHA at build time, or "dev" when running from source. */
	commitHash: string;
	/** ISO 8601 build timestamp, or "unknown" when running from source. */
	buildTime: string;
}

let cached: BuildInfo = { commitHash: "dev", buildTime: "unknown" };
let loaded = false;
let loadPromise: Promise<void> | null = null;

/**
 * Idempotently load build info from the generated module. Concurrent callers
 * share a single underlying import; subsequent calls are no-ops.
 *
 * Safe to call before the generated file exists: failure is silent and the
 * cached fallback ("dev"/"unknown") remains.
 */
export async function loadBuildInfo(): Promise<void> {
	if (loaded) return;
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		try {
			// @ts-ignore — generated at build time, gitignored, may not exist
			const generated = await import("./build-info-generated.js");
			cached = {
				commitHash: typeof generated.COMMIT_HASH === "string" ? generated.COMMIT_HASH : "dev",
				buildTime: typeof generated.BUILD_TIME === "string" ? generated.BUILD_TIME : "unknown",
			};
		} catch {
			// Generated file absent (e.g. running from source) — keep the fallback.
		}
		loaded = true;
	})();
	return loadPromise;
}

/**
 * Synchronous read of the cached build info. Returns the fallback values
 * if `loadBuildInfo()` hasn't completed yet.
 */
export function getBuildInfo(): BuildInfo {
	return cached;
}
