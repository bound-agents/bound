import { randomUUID } from "node:crypto";
import { sniffImageMediaType } from "@bound/llm";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChannelType } from "discord.js";
import { z } from "zod";

// Discord.js types imported dynamically to avoid hard dep at module load
type DiscordClient = import("discord.js").Client;
type DiscordMessage = import("discord.js").Message;
type DiscordInteraction = import("discord.js").Interaction;

/** Local type for event data attachments (supports file_ref not in @bound/llm ContentBlock) */
type EventAttachment =
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
	| { type: "file_ref"; file_id: string; filename: string; size: number };

/** Attachment threshold: >= 1 MB is file_ref, < 1 MB is base64 */
const ATTACHMENT_FILE_REF_THRESHOLD = 1024 * 1024;

/** Event subscription storage */
interface Subscription {
	subscriptionId: string;
	eventName: string;
	params: Record<string, unknown>;
}

/** Event buffer entry */
interface BufferedEvent {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	cursor: number;
}

/** Interaction store entry */
interface StoredInteraction {
	interaction: DiscordInteraction;
	createdAt: number;
}

/**
 * Factory function to create a Discord MCP Server.
 *
 * Returns a configured MCP Server that:
 * - Declares event types via events/list handler
 * - Streams events via events/stream with subscription support
 * - Exposes discord_send_message and discord_respond_interaction tools
 * - Filters by allowlist
 * - Handles attachments inline (base64 < 1MB, file_ref >= 1MB)
 */
export function createDiscordServer(
	config: PlatformConnectorConfig,
	client: DiscordClient,
	logger: Logger,
): McpServer {
	const mcpServer = new McpServer({
		name: "discord-mcp",
		version: "1.0.0",
	});
	const server = mcpServer.server;

	// Internal state
	let nextCursor = 1;
	const eventBuffer: BufferedEvent[] = [];
	const subscriptions = new Map<string, Subscription>();
	const interactionStore = new Map<string, StoredInteraction>();
	const recentMessageIds = new Set<string>();
	const seenChannelIds = new Set<string>(); // Track new DM channels for list_changed events

	// events/* are bound-specific; not in the MCP SDK schema set, so we declare them here.
	// All other request/notification types use SDK-provided schemas via registerTool.
	const eventsListSchema = z.object({ method: z.literal("events/list") });
	const eventsStreamSchema = z.object({
		method: z.literal("events/stream"),
		params: z.object({
			event: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
			cursor: z.string().optional(),
		}),
	});
	const eventsPollSchema = z.object({
		method: z.literal("events/poll"),
		params: z.object({
			event: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
			cursor: z.string().optional(),
		}),
	});

	// Cleanup expired interactions every 60 seconds
	const interactionCleanupInterval = setInterval(() => {
		const now = Date.now();
		const ttl = 14 * 60 * 1000; // 14 minutes
		for (const [callbackId, { createdAt }] of interactionStore.entries()) {
			if (now - createdAt > ttl) {
				interactionStore.delete(callbackId);
			}
		}
	}, 60_000);
	interactionCleanupInterval.unref();

	// Helper to send notifications
	function sendNotification(method: string, params: Record<string, unknown>): void {
		server.notification({
			method,
			params,
		} as Record<string, unknown> & { method: string; params: Record<string, unknown> });
	}

	// Helper to add event to buffer and emit to subscriptions
	function emitEvent(eventId: string, eventName: string, eventData: Record<string, unknown>): void {
		const now = new Date().toISOString();
		const cursor = nextCursor++;

		const bufferedEvent: BufferedEvent = {
			eventId,
			name: eventName,
			timestamp: now,
			data: eventData,
			cursor,
		};

		eventBuffer.push(bufferedEvent);
		if (eventBuffer.length > 1000) {
			eventBuffer.shift();
		}

		// Emit to matching subscriptions
		for (const subscription of subscriptions.values()) {
			if (subscription.eventName === eventName) {
				// Check if params match (channel_id filter, etc.)
				let matches = true;
				for (const [key, value] of Object.entries(subscription.params)) {
					if (eventData[key] !== value) {
						matches = false;
						break;
					}
				}
				if (matches) {
					sendNotification("notifications/events/event", {
						subscriptionId: subscription.subscriptionId,
						eventId: bufferedEvent.eventId,
						name: bufferedEvent.name,
						timestamp: bufferedEvent.timestamp,
						data: bufferedEvent.data,
						cursor: String(bufferedEvent.cursor),
					});
				}
			}
		}
	}

	// Handle events/list request
	server.setRequestHandler(eventsListSchema, async () => {
		return {
			events: [
				{
					name: "message.received",
					description: "Discord message received from a user",
					inputSchema: {
						type: "object",
						properties: {
							channel_id: {
								type: "string",
								description: "Discord channel ID to subscribe to",
							},
						},
						required: ["channel_id"],
					},
				},
				{
					name: "interaction.received",
					description: "Discord interaction (slash command or context menu) received",
					inputSchema: {
						type: "object",
						properties: {
							channel_id: {
								type: "string",
								description: "Discord channel ID to subscribe to",
							},
						},
						required: ["channel_id"],
					},
				},
			],
		};
	});

	// Handle events/stream request
	server.setRequestHandler(eventsStreamSchema, async (request) => {
		const params = request.params || {};
		const eventName = params.event as string;
		const eventParams = (params.params as Record<string, unknown>) || {};

		// Validate event name
		if (eventName !== "message.received" && eventName !== "interaction.received") {
			throw new Error(`Unknown event type: ${eventName}`);
		}

		const subscriptionId = randomUUID();
		subscriptions.set(subscriptionId, {
			subscriptionId,
			eventName,
			params: eventParams,
		});

		// If cursor provided, replay buffered events
		const cursor = params.cursor as string | undefined;
		if (cursor) {
			const cursorNum = Number.parseInt(cursor, 10);
			const matchingEvents = eventBuffer.filter(
				(e) =>
					e.cursor > cursorNum &&
					e.name === eventName &&
					Object.entries(eventParams).every(([key, value]) => e.data[key] === value),
			);

			for (const bufferedEvent of matchingEvents) {
				sendNotification("notifications/events/event", {
					subscriptionId,
					eventId: bufferedEvent.eventId,
					name: bufferedEvent.name,
					timestamp: bufferedEvent.timestamp,
					data: bufferedEvent.data,
					cursor: String(bufferedEvent.cursor),
				});
			}
		}

		return { subscriptionId };
	});

	// Handle events/poll request
	server.setRequestHandler(eventsPollSchema, async (request) => {
		const params = request.params || {};
		const eventName = params.event as string;
		const eventParams = (params.params as Record<string, unknown>) || {};
		const cursorStr = params.cursor as string | undefined;

		// Validate event name
		if (eventName !== "message.received" && eventName !== "interaction.received") {
			throw new Error(`Unknown event type: ${eventName}`);
		}

		const cursor = cursorStr ? Number.parseInt(cursorStr, 10) : 0;
		const matchingEvents = eventBuffer.filter(
			(e) =>
				e.cursor > cursor &&
				e.name === eventName &&
				Object.entries(eventParams).every(([key, value]) => e.data[key] === value),
		);

		return {
			events: matchingEvents.map((e) => ({
				eventId: e.eventId,
				name: e.name,
				timestamp: e.timestamp,
				data: e.data,
				cursor: String(e.cursor),
			})),
			cursor:
				matchingEvents.length > 0
					? String(matchingEvents[matchingEvents.length - 1].cursor)
					: cursorStr || "0",
			nextPollSeconds: 2,
		};
	});

	mcpServer.registerTool(
		"discord_send_message",
		{
			description:
				"Send a message to a Discord DM channel. Returns an error if content exceeds 2000 characters.",
			inputSchema: {
				channel_id: z.string().describe("The Discord channel ID to send to"),
				content: z.string().describe("Message content (must be <= 2000 chars)"),
			},
		},
		async ({ channel_id, content }) => {
			if (content.length > 2000) {
				return {
					content: [
						{
							type: "text",
							text: `Error: content exceeds Discord's 2000-character limit (got ${content.length})`,
						},
					],
					isError: true,
				};
			}

			try {
				const channel = await client.channels.fetch(channel_id);
				if (!channel || !channel.isDMBased()) {
					return {
						content: [{ type: "text", text: "Error: channel not found or not a DM" }],
						isError: true,
					};
				}

				const dmChannel = channel as DiscordMessage["channel"];
				await (dmChannel as { sendTyping(): Promise<void> }).sendTyping();

				const sendableChannel = channel as { send(content: string): Promise<unknown> };
				await sendableChannel.send(content);

				return {
					content: [{ type: "text", text: "sent" }],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${errorMsg}` }],
					isError: true,
				};
			}
		},
	);

	mcpServer.registerTool(
		"discord_respond_interaction",
		{
			description: "Respond to a Discord interaction by editing the ephemeral reply",
			inputSchema: {
				callback_id: z.string().describe("The interaction callback ID from the event data"),
				content: z.string().describe("Response content (max 2000 chars, will be truncated)"),
			},
		},
		async ({ callback_id, content }) => {
			const storedData = interactionStore.get(callback_id);
			if (!storedData) {
				return {
					content: [{ type: "text", text: "Error: interaction not found or expired" }],
					isError: true,
				};
			}

			const ttl = 14 * 60 * 1000; // 14 minutes
			if (Date.now() - storedData.createdAt > ttl) {
				interactionStore.delete(callback_id);
				return {
					content: [{ type: "text", text: "Error: interaction not found or expired" }],
					isError: true,
				};
			}

			const responseContent = content.length > 2000 ? content.slice(0, 2000) : content;

			try {
				const editableInteraction = storedData.interaction as DiscordInteraction & {
					editReply(options: { content: string }): Promise<unknown>;
				};
				await editableInteraction.editReply({ content: responseContent });
				interactionStore.delete(callback_id);
				return {
					content: [{ type: "text", text: "sent" }],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${errorMsg}` }],
					isError: true,
				};
			}
		},
	);

	// Setup Discord client listeners
	setupDiscordListeners(
		client,
		config,
		logger,
		emitEvent,
		interactionStore,
		recentMessageIds,
		seenChannelIds,
		sendNotification,
	);

	// Cleanup on server close
	const originalClose = mcpServer.close.bind(mcpServer);
	mcpServer.close = async (...args) => {
		clearInterval(interactionCleanupInterval);
		return originalClose(...args);
	};

	return mcpServer;
}

/**
 * Setup Discord client event listeners
 */
function setupDiscordListeners(
	client: DiscordClient,
	config: PlatformConnectorConfig,
	logger: Logger,
	emitEvent: (eventId: string, eventName: string, data: Record<string, unknown>) => void,
	interactionStore: Map<string, StoredInteraction>,
	recentMessageIds: Set<string>,
	seenChannelIds: Set<string>,
	sendNotification: (method: string, params: Record<string, unknown>) => void,
): void {
	client.on("messageCreate", async (msg: DiscordMessage) => {
		try {
			// Skip bot messages
			if (msg.author.bot) return;

			// Skip non-DM messages
			if (msg.channel.type !== ChannelType.DM) return;

			// Allowlist check
			if (config.allowed_users.length > 0 && !config.allowed_users.includes(msg.author.id)) {
				return;
			}

			// Dedup
			if (recentMessageIds.has(msg.id)) return;
			recentMessageIds.add(msg.id);
			if (recentMessageIds.size > 100) {
				const first = recentMessageIds.values().next().value;
				if (first) recentMessageIds.delete(first);
			}

			// Track new channels for list_changed emission
			if (!seenChannelIds.has(msg.channelId)) {
				seenChannelIds.add(msg.channelId);
				sendNotification("notifications/events/list_changed", {});
			}

			// Build attachment content blocks
			const attachments: EventAttachment[] = [];
			const attachmentCount = msg.attachments?.size ?? 0;
			if (attachmentCount > 0) {
				for (const attachment of msg.attachments.values()) {
					try {
						const response = await fetch(attachment.url, {
							signal: AbortSignal.timeout(30_000),
						});
						if (!response.ok) {
							logger.warn("[discord-server] Failed to download attachment", {
								url: attachment.url,
								status: response.status,
							});
							continue;
						}

						const bytes = await response.bytes();
						if (attachment.size >= ATTACHMENT_FILE_REF_THRESHOLD) {
							// File ref for large files
							attachments.push({
								type: "file_ref",
								file_id: attachment.id,
								filename: attachment.name,
								size: attachment.size,
							});
						} else {
							// Base64 for small files (images)
							const mediaType = sniffImageMediaType(bytes);
							if (mediaType) {
								attachments.push({
									type: "image",
									source: {
										type: "base64",
										media_type: mediaType as
											| "image/jpeg"
											| "image/png"
											| "image/gif"
											| "image/webp",
										data: Buffer.from(bytes).toString("base64"),
									},
								});
							}
						}
					} catch (err) {
						logger.warn("[discord-server] Error processing attachment", {
							attachmentId: attachment.id,
							error: String(err),
						});
					}
				}
			}

			// Emit event
			emitEvent(msg.id, "message.received", {
				author: {
					id: msg.author.id,
					username: msg.author.username,
					display_name: msg.author.displayName ?? msg.author.username,
				},
				channel_id: msg.channelId,
				content: msg.content,
				attachments,
				message_id: msg.id,
			});
		} catch (err) {
			logger.error("[discord-server] messageCreate handler error", {
				error: String(err),
			});
		}
	});

	client.on("interactionCreate", async (interaction) => {
		try {
			// Only handle slash commands and context menus
			if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) {
				return;
			}

			// Defer with ephemeral flag
			await interaction.deferReply({ ephemeral: true });

			// Generate callback ID and store interaction
			const callbackId = randomUUID();
			const discordInteraction = interaction as DiscordInteraction;
			interactionStore.set(callbackId, {
				interaction: discordInteraction,
				createdAt: Date.now(),
			});

			// Build event data
			const eventData: Record<string, unknown> = {
				callback_id: callbackId,
				interaction_type: interaction.isChatInputCommand() ? "slash_command" : "context_menu",
				user: {
					id: interaction.user.id,
					username: interaction.user.username,
					display_name: interaction.user.displayName ?? interaction.user.username,
				},
				channel_id: interaction.channelId,
			};

			// For context menu: include target message
			if (interaction.isContextMenuCommand()) {
				const contextInteraction = interaction as DiscordInteraction;
				const targetMsg = (contextInteraction as unknown as { targetMessage?: DiscordMessage })
					.targetMessage;
				const targetAttachments: EventAttachment[] = [];

				const targetAttachmentCount = targetMsg?.attachments?.size ?? 0;
				if (targetMsg && targetAttachmentCount > 0) {
					const attachments = targetMsg.attachments;
					if (attachments) {
						for (const attachment of attachments.values()) {
							try {
								const response = await fetch(attachment.url, {
									signal: AbortSignal.timeout(30_000),
								});
								if (!response.ok) continue;

								const bytes = await response.bytes();
								if (attachment.size >= ATTACHMENT_FILE_REF_THRESHOLD) {
									targetAttachments.push({
										type: "file_ref",
										file_id: attachment.id,
										filename: attachment.name,
										size: attachment.size,
									});
								} else {
									const mediaType = sniffImageMediaType(bytes);
									if (mediaType) {
										targetAttachments.push({
											type: "image",
											source: {
												type: "base64",
												media_type: mediaType as
													| "image/jpeg"
													| "image/png"
													| "image/gif"
													| "image/webp",
												data: Buffer.from(bytes).toString("base64"),
											},
										});
									}
								}
							} catch (err) {
								logger.warn("[discord-server] Error processing interaction attachment", {
									error: String(err),
								});
							}
						}
					}
				}

				if (targetMsg) {
					eventData.target_message = {
						content: targetMsg.content,
						author: {
							id: targetMsg.author.id,
							username: targetMsg.author.username,
							display_name: targetMsg.author.displayName ?? targetMsg.author.username,
						},
						attachments: targetAttachments,
					};
				}
			}

			// For slash commands: include command name and options
			if (interaction.isChatInputCommand()) {
				const slashInteraction = interaction as DiscordInteraction & {
					commandName: string;
					options: { data?: Array<{ name: string; value: unknown }> };
				};
				const options: Record<string, unknown> = {};
				if (slashInteraction.options?.data) {
					for (const option of slashInteraction.options.data) {
						options[option.name] = option.value;
					}
				}
				eventData.command = {
					name: slashInteraction.commandName,
					options,
				};
			}

			// Emit event
			emitEvent(randomUUID(), "interaction.received", eventData);
		} catch (err) {
			logger.error("[discord-server] interactionCreate handler error", {
				error: String(err),
			});
		}
	});
}

/**
 * Chunk a message at Discord's 2000 character limit
 * Priority: paragraph breaks -> line breaks -> word boundaries -> hard split
 */
export function chunkMessage(content: string, maxLength = 2000): string[] {
	if (content.length <= maxLength) {
		return [content];
	}

	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Try paragraph breaks first
		const paragraphSplit = remaining.substring(0, maxLength).lastIndexOf("\n\n");
		if (paragraphSplit > 0) {
			chunks.push(remaining.substring(0, paragraphSplit));
			remaining = remaining.substring(paragraphSplit + 2);
			continue;
		}

		// Try line breaks
		const lineSplit = remaining.substring(0, maxLength).lastIndexOf("\n");
		if (lineSplit > 0) {
			chunks.push(remaining.substring(0, lineSplit));
			remaining = remaining.substring(lineSplit + 1);
			continue;
		}

		// Try word boundaries
		const wordSplit = remaining.substring(0, maxLength).lastIndexOf(" ");
		if (wordSplit > 0) {
			chunks.push(remaining.substring(0, wordSplit));
			remaining = remaining.substring(wordSplit + 1);
			continue;
		}

		// Hard split
		chunks.push(remaining.substring(0, maxLength));
		remaining = remaining.substring(maxLength);
	}

	return chunks;
}
