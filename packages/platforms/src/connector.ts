import type { ToolDefinition } from "@bound/llm";

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
	 * @returns A map from tool name to tool definition + execute closure. The execute
	 *   closure receives the LLM's input object and returns a result string.
	 */
	getPlatformTools?(threadId: string): Map<
		string,
		{
			toolDefinition: ToolDefinition;
			execute: (input: Record<string, unknown>) => Promise<string>;
		}
	>;
}
