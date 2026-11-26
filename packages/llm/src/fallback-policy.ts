/**
 * Static, per-driver fallback protocol capabilities (R-MC7,
 * 2026-11-21-model-catalog.md §4.2). Routing and refusal-fallback logic branch
 * on these flags, never on provider names or model tables. The fallback chain
 * itself is resolved agent-side (`packages/agent/src/resolve-request-fallback.ts`).
 */
export type DriverFallbackSupport = {
	/**
	 * Provider accepts a server-side automatic fallback directive (e.g. the
	 * Anthropic API `fallbacks: "default"` + `server-side-fallback-2026-07-01`).
	 */
	server_side_auto: boolean;
	/** Provider publishes per-model `allowed_fallback_models` via its models API. */
	publishes_allowed_targets: boolean;
	/**
	 * Provider can mint and redeem prompt-cache fallback-credit tokens on refusal
	 * (Anthropic API, Bedrock Runtime, Bedrock Mantle).
	 */
	supports_fallback_credit: boolean;
};
