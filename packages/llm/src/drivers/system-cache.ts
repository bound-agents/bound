import type { ModelMessage } from "ai";

/**
 * System-block cache anchoring for the providers whose cache marker rides on
 * a system message's `providerOptions`: Bedrock Converse (`bedrock.cachePoint`)
 * and Anthropic Messages (`anthropic.cacheControl`).
 *
 * The system prompt is sent as a `role: "system"` `ModelMessage` at index 0
 * rather than via `streamText({system: <string>})`: the AI SDK normalizes the
 * top-level `system` string into a system block WITHOUT `providerOptions`, so
 * no cache marker reaches the wire and the only anchor is the message-level
 * marker, which moves every turn as history grows and orphans prior cache
 * entries. Both `@ai-sdk/amazon-bedrock` and `@ai-sdk/anthropic` read the
 * marker from a system message's `providerOptions` (their `case "system"`
 * prompt-converter branches), so routing the system block through the
 * messages array keeps the anchor on the byte-stable system prefix (R-VC25).
 */
export type SystemCacheProvider = "anthropic" | "bedrock";

export interface CachedSystemMessageParams {
	/** The system prompt text. When falsy/empty, no system block is produced. */
	system?: string;
	/** Whether to attach the provider's cache marker to the system block. */
	cacheEnabled: boolean;
	cacheTtl?: "5m" | "1h";
}

function cacheMarker(
	provider: SystemCacheProvider,
	cacheTtl: "5m" | "1h" | undefined,
): NonNullable<ModelMessage["providerOptions"]> {
	const ttl = cacheTtl ? { ttl: cacheTtl } : {};
	return provider === "bedrock"
		? { bedrock: { cachePoint: { type: "default", ...ttl } } }
		: { anthropic: { cacheControl: { type: "ephemeral", ...ttl } } };
}

/**
 * The system message that opens the messages array, or `null` when `system`
 * is empty (the caller passes the messages through unchanged). The cache
 * marker is present iff `cacheEnabled`. Byte-stable for the same inputs.
 */
export function buildCachedSystemMessage(
	provider: SystemCacheProvider,
	params: CachedSystemMessageParams,
): ModelMessage | null {
	if (!params.system) return null;
	const message: ModelMessage = { role: "system", content: params.system };
	if (params.cacheEnabled) message.providerOptions = cacheMarker(provider, params.cacheTtl);
	return message;
}

/** Whether any post-bridge message carries the provider's cache marker. */
export function hasMessageCacheMarker(
	provider: SystemCacheProvider,
	messages: ModelMessage[],
): boolean {
	return messages.some((m) => {
		const opts = m.providerOptions as
			{ bedrock?: { cachePoint?: unknown }; anthropic?: { cacheControl?: unknown } } | undefined;
		return provider === "bedrock"
			? opts?.bedrock?.cachePoint !== undefined
			: opts?.anthropic?.cacheControl !== undefined;
	});
}

/**
 * Whether the SYSTEM block carries a cache marker. The system anchor is
 * independent of the message-level marker: a `cache_ttl` means the caller
 * intends caching; without one, message-level marker presence is the fallback
 * signal. A missing message-level marker must never disable the system anchor
 * when caching was requested.
 */
export function shouldEnableSystemCache(
	provider: SystemCacheProvider,
	params: { cacheTtl: string | undefined; bridgeMessages: ModelMessage[] },
): boolean {
	if (params.cacheTtl !== undefined) return true;
	return hasMessageCacheMarker(provider, params.bridgeMessages);
}
