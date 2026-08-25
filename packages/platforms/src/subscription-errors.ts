/**
 * Cross-boundary signal for "a subscription was rejected because the target is
 * permanently invalid" — as opposed to a transient stream failure.
 *
 * A connector's `events/stream` handler throws an error carrying this `code`
 * when it definitively will never deliver events for the requested subscription
 * (e.g. the Discord bot lacks View Channel permission on the target channel).
 * The MCP SDK serializes handler errors to JSON-RPC `{code, message}` and the
 * client rebuilds an `McpError` with `.code` preserved, so the numeric code is
 * the only thing that survives the in-memory transport — an `instanceof` check
 * would not. `PlatformMcpRegistry` keys off this code to tell a permanent
 * rejection (roll the handle back / don't retry) from a transient one (leave
 * the handle, retry on the next reconnect).
 *
 * Chosen inside the JSON-RPC server-error band (-32000..-32099), distinct from
 * the SDK's own codes (ParseError/InvalidRequest/MethodNotFound/InvalidParams/
 * InternalError).
 */
export const SUBSCRIPTION_REJECTED_CODE = -32050;

/**
 * Discord-specific alias kept for call-site readability in the connector; the
 * value is the generic {@link SUBSCRIPTION_REJECTED_CODE} the registry checks.
 */
export const CHANNEL_ACCESS_DENIED_CODE = SUBSCRIPTION_REJECTED_CODE;

/** True when an error (from `client.request`) carries the subscription-rejected code. */
export function isSubscriptionRejected(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === SUBSCRIPTION_REJECTED_CODE
	);
}
