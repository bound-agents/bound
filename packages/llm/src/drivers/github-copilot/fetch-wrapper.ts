/**
 * The Copilot request-decorating fetch wrappers.
 *
 * Every Copilot API request needs a fixed header set (verified live):
 *   - `Authorization: Bearer <ghu_>` — the direct GitHub user token (NOT the
 *     copilot_internal/v2/token exchange, which 403s).
 *   - `Copilot-Integration-Id: copilot-developer-cli` — REQUIRED; without it
 *     only 8 legacy models are visible and Claude 400s.
 *   - `X-GitHub-Api-Version: 2026-08-01`
 *   - `Openai-Intent: conversation-edits`
 *   - `User-Agent: bound`
 *   - `x-initiator: "agent" | "user"` — "agent" when the latest message is a
 *     tool result / non-user-initiated, else "user".
 *   - `Copilot-Vision-Request: true` — only when the request carries images.
 *
 * On the Anthropic Messages route the @ai-sdk/anthropic provider sets an
 * `x-api-key` (and the base provider an `authorization`); the wrapper STRIPS
 * both and installs the Copilot Bearer so the SDK's placeholder key never rides
 * the wire.
 *
 * Pure over an injected base fetch + a token getter, so header assembly is
 * unit-testable with no network.
 */

export const COPILOT_INTEGRATION_ID = "copilot-developer-cli";
export const COPILOT_API_VERSION = "2026-08-01";
export const COPILOT_OPENAI_INTENT = "conversation-edits";

/** Per-request facts the driver computes once per turn and threads in here. */
export interface CopilotRequestContext {
	/** "agent" when the latest message is a tool result / non-user-initiated. */
	initiator: "agent" | "user";
	/** True when the request carries any image content. */
	hasImages: boolean;
	/**
	 * Auto-session token to send as `Copilot-Session-Token` (model:"auto"
	 * routing only). Scoped to the selected model; omitted otherwise.
	 */
	sessionToken?: string;
}

export interface CopilotFetchConfig {
	/** Returns the current (refreshed) ghu_ access token. */
	getAccessToken: () => Promise<string>;
	/** A snapshot getter for the per-turn request context. */
	getRequestContext: () => CopilotRequestContext;
	baseFetch?: typeof fetch;
}

/**
 * Decorate an outgoing Copilot API request with the required headers. Strips
 * any SDK-injected auth (`x-api-key`, `authorization`) and sets the Bearer so a
 * placeholder key the AI SDK provider installs can never leak onto the wire.
 */
export function createCopilotFetch(config: CopilotFetchConfig): typeof fetch {
	const baseFetch = config.baseFetch ?? fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const accessToken = await config.getAccessToken();
		const ctx = config.getRequestContext();

		// Strip SDK-injected auth before setting ours — @ai-sdk/anthropic sends
		// x-api-key, the base provider an authorization header.
		request.headers.delete("x-api-key");
		request.headers.delete("authorization");
		request.headers.set("Authorization", `Bearer ${accessToken}`);

		request.headers.set("Copilot-Integration-Id", COPILOT_INTEGRATION_ID);
		request.headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION);
		request.headers.set("Openai-Intent", COPILOT_OPENAI_INTENT);
		request.headers.set("User-Agent", "bound");
		request.headers.set("x-initiator", ctx.initiator);
		if (ctx.hasImages) {
			request.headers.set("Copilot-Vision-Request", "true");
		}
		if (ctx.sessionToken) {
			request.headers.set("Copilot-Session-Token", ctx.sessionToken);
		}
		return baseFetch(request);
	}) as typeof fetch;
}

/**
 * Decorate a bare Copilot control-plane request (model catalog, auto-session)
 * that rides the Copilot API host but is NOT an AI SDK inference call. Same
 * header set minus the per-turn initiator/vision/session knobs (those are
 * inference-only), and no x-api-key to strip (there is no SDK on this path).
 */
export function createCopilotControlFetch(config: {
	getAccessToken: () => Promise<string>;
	baseFetch?: typeof fetch;
}): typeof fetch {
	const baseFetch = config.baseFetch ?? fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const accessToken = await config.getAccessToken();
		request.headers.set("Authorization", `Bearer ${accessToken}`);
		request.headers.set("Copilot-Integration-Id", COPILOT_INTEGRATION_ID);
		request.headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION);
		request.headers.set("Openai-Intent", COPILOT_OPENAI_INTENT);
		request.headers.set("User-Agent", "bound");
		return baseFetch(request);
	}) as typeof fetch;
}

/**
 * Decide the `x-initiator` value from the conversation. The latest message
 * being a tool result (or otherwise not a plain user turn) means this request
 * was initiated by the agent, not the user — Copilot keys quota/telemetry off
 * this. A message whose role is "user" → "user"; anything else (tool_result,
 * assistant, developer, cache) → "agent".
 */
export function resolveInitiator(latestRole: string | undefined): "agent" | "user" {
	return latestRole === "user" ? "user" : "agent";
}
