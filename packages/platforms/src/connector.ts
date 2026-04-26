import type { ToolDefinition } from "@bound/llm";

/**
 * Post-loop delivery verdict returned by `PlatformConnector.verifyDelivery`.
 * Discriminated on `kind` so the caller can branch without type-checking.
 */
export type DeliveryVerdict =
	| { kind: "delivered" }
	| { kind: "intentional-silence" }
	| { kind: "missing"; nudge: string };

/**
 * A PlatformConnector integrates one external messaging platform (Discord, Slack, Telegram, etc.)
 * with the bound relay pipeline.
 *
 * Broadcast connectors (Discord) maintain a persistent gateway connection; only the elected
 * leader connects. Exclusive-delivery connectors (Telegram, Slack Events API) receive events
 * via webhook HTTP POST and re-register their URL on leader failover.
 */
export interface PlatformConnector {
	/** Platform identifier, e.g. "discord", "slack", "telegram". Must be unique per registry. */
	readonly platform: string;

	/**
	 * Delivery model:
	 * - "broadcast": connector maintains a persistent connection (gateway/websocket).
	 *   Only the elected leader connects.
	 * - "exclusive": connector receives events via HTTP webhook.
	 *   On failover the new leader re-registers its own URL.
	 */
	readonly delivery: "broadcast" | "exclusive";

	/**
	 * Establish the platform connection.
	 * For broadcast connectors: open the gateway websocket.
	 * For exclusive-delivery connectors: register the webhook URL at the platform.
	 *
	 * @param hostBaseUrl - Base URL of this host (e.g. "https://host.example.com").
	 *   Used by exclusive-delivery connectors to register the webhook URL.
	 *   Broadcast connectors may ignore this parameter.
	 */
	connect(hostBaseUrl?: string): Promise<void>;

	/** Tear down the platform connection. */
	disconnect(): Promise<void>;

	/**
	 * Send a response message to the platform.
	 *
	 * @param threadId  - Internal thread ID (used to look up the platform channel/user).
	 * @param messageId - Internal message ID of the assistant response.
	 * @param content   - Text content to send. May need chunking per platform limits.
	 * @param attachments - Optional attachments (platform-specific format).
	 */
	deliver(
		threadId: string,
		messageId: string,
		content: string,
		attachments?: Array<{ filename: string; data: Buffer }>,
	): Promise<void>;

	/**
	 * Handle an inbound webhook payload from the platform.
	 * Only exclusive-delivery connectors implement this method.
	 *
	 * @param rawBody - Raw HTTP request body (string).
	 * @param headers - HTTP request headers (for signature verification).
	 */
	handleWebhookPayload?(rawBody: string, headers: Record<string, string>): Promise<void>;

	/**
	 * Contribute platform-specific tool definitions to the agent loop.
	 *
	 * @param threadId - The thread ID the agent loop is processing. Closures returned
	 *   in the map must capture this value so execution is bound to the correct thread.
	 * @param readFileFn - Optional file reader function from a virtual filesystem (e.g. ClusterFs).
	 *   When provided, platform tools use this to read files instead of node:fs/promises.
	 *   Enables reading files created by bash commands in the sandbox's virtual FS.
	 * @returns A map from tool name to tool definition + execute closure. The execute
	 *   closure receives the LLM's input object and returns a result string.
	 */
	/**
	 * Called when the agent loop finishes processing a thread (success or error).
	 * Connectors can use this to clean up per-thread state like typing indicators.
	 */
	onLoopComplete?(threadId: string): void;

	/**
	 * Decide whether the agent's turn actually reached the user through this
	 * platform. Called after the loop completes for a thread whose interface
	 * matches this connector.
	 *
	 * @param threadId     - The thread the loop just processed.
	 * @param turnStartAt  - ISO timestamp marking the start of this turn.
	 *   Messages produced in this turn are newer than this.
	 *
	 * Return value semantics:
	 *   - `delivered`            — the agent emitted at least one successful
	 *     egress tool call (e.g. `discord_send_message`) in this turn; the
	 *     reply reached the user and no follow-up is required.
	 *   - `intentional-silence`  — the turn was triggered by a prior
	 *     delivery-retry nudge, and the agent deliberately chose not to reply.
	 *     Respect the silence; do not nudge again.
	 *   - `missing`              — no egress tool call landed this turn and no
	 *     nudge has been issued. `nudge` is the developer-role message text
	 *     the caller should enqueue as a notification so the next turn has a
	 *     chance to call the egress tool.
	 *
	 * Connectors without an explicit egress-tool contract (webhook stub,
	 * auto-send platforms) need not implement this method — the absence is
	 * treated as "delivered".
	 */
	verifyDelivery?(threadId: string, turnStartAt: string): Promise<DeliveryVerdict>;

	getPlatformTools?(
		threadId: string,
		readFileFn?: (path: string) => Promise<Uint8Array>,
	): Map<
		string,
		{
			toolDefinition: ToolDefinition;
			execute: (input: Record<string, unknown>) => Promise<string>;
		}
	>;
}
