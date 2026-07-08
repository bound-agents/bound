import { randomUUID } from "node:crypto";
import { sniffImageMediaType } from "@bound/llm";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { z } from "zod";
import { CHANNEL_ACCESS_DENIED_CODE } from "../subscription-errors.js";

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

/**
 * Compare two snowflake-string cursors. Returns negative if a < b, 0 if equal,
 * positive if a > b. Uses BigInt to avoid Number precision loss above 2^53;
 * Discord snowflakes routinely exceed that range (~1.4e18 by 2026). Falls back
 * to lexicographic comparison if either input isn't parseable as a BigInt, so
 * legacy non-numeric cursors keep working.
 */
function compareSnowflakeCursors(a: string, b: string): number {
	try {
		const aBig = BigInt(a);
		const bBig = BigInt(b);
		if (aBig < bBig) return -1;
		if (aBig > bBig) return 1;
		return 0;
	} catch {
		return a.localeCompare(b);
	}
}

/**
 * Throws a subscription-rejection error if the bot definitively cannot view the
 * target channel of a `message.received` subscription. DMs are exempt — they
 * are gated by the `allowed_users` allowlist, not per-channel permissions, and
 * carry no `guild`/`permissionsFor`. A guild channel is rejected ONLY on a
 * definitive negative: the channel is fetched, its guild + bot member + channel
 * permissions all resolve, and `ViewChannel` is absent. Every unresolvable case
 * (fetch throws, channel missing, cold guild-member cache, no `permissionsFor`)
 * is treated as "cannot confirm" and does NOT throw — a subscription-time gate
 * must not nuke a legitimate handle just because the cache is cold during a
 * failover reconnect. `code` rides on the thrown error so the registry can tell
 * a permanent access denial (roll the handle back) from a transient stream
 * failure (leave it, retry later).
 */
async function assertBotCanViewChannel(client: DiscordClient, channelId: string): Promise<void> {
	let channel: unknown;
	try {
		channel = await client.channels.fetch(channelId);
	} catch {
		return; // transient/unresolvable — do not block
	}
	if (!channel) return;
	const c = channel as {
		isDMBased?: () => boolean;
		guild?: { members?: { me?: unknown } };
		permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
	};
	// DMs are gated by allowed_users, not channel permissions.
	if (c.isDMBased?.() === true) return;
	const me = c.guild?.members?.me;
	if (!me || typeof c.permissionsFor !== "function") return; // unresolvable — do not block
	const perms = c.permissionsFor(me);
	if (!perms) return; // unresolvable — do not block
	if (!perms.has(PermissionFlagsBits.ViewChannel)) {
		const err = new Error(
			`Cannot subscribe to channel ${channelId}: bot lacks View Channel permission`,
		) as Error & { code?: number };
		err.code = CHANNEL_ACCESS_DENIED_CODE;
		throw err;
	}
}

/** Event subscription storage */
interface Subscription {
	subscriptionId: string;
	eventName: string;
	params: Record<string, unknown>;
}
interface BufferedEvent {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	/**
	 * Cursor is the Discord-issued snowflake (msg.id / interaction.id), which
	 * is monotonic per channel, globally unique, and survives daemon restarts.
	 * Using an in-process counter here previously caused a cursor collision
	 * after restart: a fresh `nextCursor = 1` would re-emit cursor "1" while
	 * the persisted handle.cursor in DB still held "1" from the prior delivery,
	 * so deliverBatch's `compareCursors > 0` filter dropped every "first
	 * message after restart" as a stale replay. Snowflakes monotonically
	 * advance (~ms-precision timestamp + worker + sequence), so collisions
	 * across restarts are not a thing.
	 */
	cursor: string;
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
	const mcpServer = new McpServer(
		{
			name: "discord-mcp",
			version: "1.0.0",
		},
		{
			// Server-level orientation prose, surfaced to threads bound to this
			// connector via PlatformMcpRegistry.getInstructionsForThread(). This
			// is the decoupled channel for connector-specific guidance: bound
			// core makes no claims about a connector's tools or formatting — the
			// connector authors its own. Send semantics and the character limit
			// are already self-described by the send tool's description/schema;
			// this carries only the Discord markdown dialect, which has no other
			// protocol-native home.
			instructions:
				"Discord formatting: **bold**, *italic*, __underline__, ~~strikethrough~~, " +
				"`inline code`, ```code blocks```, > block quotes, >>> multi-line quotes, " +
				"# ## ### headers, -# subtext, [masked links](url), ||spoilers||, " +
				"- bulleted lists (2-space indent to nest). " +
				"Tables do NOT render — use lists or code blocks instead. " +
				"Messages over 2000 characters are rejected; split long content across multiple calls.",
		},
	);
	const server = mcpServer.server;

	// Internal state. NOTE: no in-process cursor counter — we use the
	// Discord-issued snowflake (msg.id / interaction.id) directly as cursor.
	// See BufferedEvent.cursor docstring for the restart-collision rationale.
	const eventBuffer: BufferedEvent[] = [];
	const subscriptions = new Map<string, Subscription>();
	const interactionStore = new Map<string, StoredInteraction>();
	const recentMessageIds = new Set<string>();

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

		const bufferedEvent: BufferedEvent = {
			eventId,
			name: eventName,
			timestamp: now,
			data: eventData,
			// eventId === cursor for Discord (both are the snowflake). Kept as
			// distinct fields because the wire shape allows other connectors to
			// decouple them if their identity scheme differs from their ordering.
			cursor: eventId,
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
						cursor: bufferedEvent.cursor,
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
						properties: {},
						required: [],
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

		// Validate required params per event type
		if (eventName === "message.received") {
			if (!eventParams.channel_id || typeof eventParams.channel_id !== "string") {
				throw new Error("message.received requires channel_id in event params");
			}
			// Reject subscriptions to a guild channel the bot cannot view. A
			// dead subscription (bot lacks View Channel) would otherwise sit in
			// the handle/task tables forever, never delivering — Discord never
			// sends messageCreate for a channel the bot can't see. Throwing here
			// (before subscriptions.set) refuses registration; the code on the
			// error lets the registry roll the handle back rather than retry.
			await assertBotCanViewChannel(client, eventParams.channel_id);
		}

		const subscriptionId = randomUUID();
		subscriptions.set(subscriptionId, {
			subscriptionId,
			eventName,
			params: eventParams,
		});

		// If cursor provided, replay buffered events. Cursors are snowflake
		// strings — compare via BigInt to avoid Number precision loss above 2^53.
		const cursor = params.cursor as string | undefined;
		if (cursor) {
			const matchingEvents = eventBuffer.filter(
				(e) =>
					compareSnowflakeCursors(e.cursor, cursor) > 0 &&
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
					cursor: bufferedEvent.cursor,
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

		// Validate required params per event type
		if (eventName === "message.received") {
			if (!eventParams.channel_id || typeof eventParams.channel_id !== "string") {
				throw new Error("message.received requires channel_id in event params");
			}
		}

		// Cursors are snowflake strings — only filter when caller supplied one;
		// when absent we treat as "from the beginning of the buffer."
		const matchingEvents = eventBuffer.filter(
			(e) =>
				(cursorStr === undefined || compareSnowflakeCursors(e.cursor, cursorStr) > 0) &&
				e.name === eventName &&
				Object.entries(eventParams).every(([key, value]) => e.data[key] === value),
		);

		return {
			events: matchingEvents.map((e) => ({
				eventId: e.eventId,
				name: e.name,
				timestamp: e.timestamp,
				data: e.data,
				cursor: e.cursor,
			})),
			cursor:
				matchingEvents.length > 0
					? matchingEvents[matchingEvents.length - 1].cursor
					: cursorStr || "0",
			nextPollSeconds: 2,
		};
	});

	mcpServer.registerTool(
		"discord_send_message",
		{
			description:
				"Send a message to a Discord channel — a DM or a guild text channel. " +
				"Returns an error if content exceeds 2000 characters.",
			inputSchema: {
				channel_id: z.string().describe("The Discord channel ID to send to (DM or guild channel)"),
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
				// Accept any text-bearing channel (DM or guild text). isTextBased()
				// covers DMs, guild text, threads, and announcement channels;
				// non-text channels (category, stage, voice-without-text) lack a
				// usable send() surface and are rejected.
				if (!channel || channel.isTextBased?.() !== true) {
					return {
						content: [{ type: "text", text: "Error: channel not found or not a text channel" }],
						isError: true,
					};
				}

				const sendableChannel = channel as DiscordMessage["channel"] & {
					sendTyping(): Promise<void>;
					send(content: string): Promise<unknown>;
				};
				await sendableChannel.sendTyping();
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

	mcpServer.registerTool(
		"discord_list_channels",
		{
			description:
				"List Discord channels available for binding. Returns a flat array mixing two entry shapes. " +
				"DM entries, derived from the bot's `allowed_users` allowlist, map an allowed user ID to its DM " +
				"channel ID (`{user_id, channel_id}`), opening the DM if not already open (idempotent on Discord's " +
				"side; does not notify the user); a per-user `createDM` failure is surfaced inline as " +
				"`{user_id, error}`. Guild entries, derived from the guild text channels the bot can currently see, " +
				"carry `{guild_id, guild_name, channel_id, channel_name}` (no `user_id`). Discriminate DM vs guild " +
				"entries by the presence of `user_id` vs `guild_id`. When `allowed_users` is empty the tool emits no " +
				"DM entries (Discord exposes no 'list my DM channels' API to bots); guild channels are still listed. " +
				"An empty array means the bot has neither an allowlist nor any visible guild text channels.",
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => {
			type ChannelEntry =
				| { user_id: string; channel_id: string }
				| { user_id: string; error: string }
				| {
						guild_id: string;
						guild_name: string;
						channel_id: string;
						channel_name: string;
				  };
			const entries: ChannelEntry[] = [];

			// DM entries from the allowlist (unchanged behavior).
			if (config.allowed_users.length > 0) {
				const results = await Promise.allSettled(
					config.allowed_users.map(async (userId) => {
						const dm = await client.users.createDM(userId);
						return { user_id: userId, channel_id: dm.id };
					}),
				);

				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					const userId = config.allowed_users[i];
					if (result.status === "fulfilled") {
						entries.push(result.value);
					} else {
						const errorMessage =
							result.reason instanceof Error ? result.reason.message : String(result.reason);
						// Keep the warn log for operators reading the daemon log; the
						// inline error-shape entry is the additive caller-facing channel.
						logger.warn("[discord-server] Failed to resolve DM for allowed user", {
							userId,
							error: errorMessage,
						});
						entries.push({ user_id: userId, error: errorMessage });
					}
				}
			}

			// Guild text channels the bot can currently see. Enumerated from the
			// discord.js guild/channel cache, which the Guilds intent populates —
			// no per-channel API call needed. Only text-bearing channels are
			// listed; categories/stage/voice-without-text are skipped.
			//
			// The Guilds intent seeds the cache with EVERY channel in a guild the
			// bot is a member of, regardless of per-channel View Channel overwrites
			// — so the raw cache includes rooms the bot cannot actually read.
			// Filter those out: enumerating a channel the bot can't see invites a
			// subscription that will never deliver (Discord never sends
			// messageCreate for it). Skip ONLY on a definitive negative (guild
			// member + channel permissions both resolve and ViewChannel is absent);
			// when permissions can't be resolved, fall back to listing rather than
			// hiding everything (no regression vs. the pre-filter behavior).
			const guilds = (
				client as {
					guilds?: {
						cache?: Map<
							string,
							{
								id: string;
								name: string;
								members?: { me?: unknown };
								channels?: { cache?: Map<string, unknown> };
							}
						>;
					};
				}
			).guilds?.cache;
			if (guilds) {
				for (const guild of guilds.values()) {
					const channelCache = guild.channels?.cache;
					if (!channelCache) continue;
					const me = guild.members?.me ?? null;
					for (const rawChannel of channelCache.values()) {
						const channel = rawChannel as {
							id: string;
							name?: string;
							isTextBased?: () => boolean;
							permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
						};
						if (channel.isTextBased?.() !== true) continue;
						// Definitive View Channel denial → skip. Unresolvable → keep.
						if (me && typeof channel.permissionsFor === "function") {
							const perms = channel.permissionsFor(me);
							if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) continue;
						}
						entries.push({
							guild_id: guild.id,
							guild_name: guild.name,
							channel_id: channel.id,
							channel_name: channel.name ?? "",
						});
					}
				}
			}

			return {
				content: [{ type: "text", text: JSON.stringify(entries) }],
			};
		},
	);

	// Setup Discord client listeners
	setupDiscordListeners(client, config, logger, emitEvent, interactionStore, recentMessageIds);

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
): void {
	client.on("messageCreate", async (msg: DiscordMessage) => {
		try {
			// Skip bot messages
			if (msg.author.bot) return;

			// Accept DMs and guild text channels. Guild threads/announcement/
			// voice-text channels all report isTextBased(); use that rather than
			// enumerating ChannelType so new text-bearing channel kinds work
			// without a code change. Non-text channels (categories, stage) are
			// dropped.
			const isDm = msg.channel.type === ChannelType.DM;
			const isGuildText = !isDm && msg.guildId != null && msg.channel.isTextBased?.() === true;
			if (!isDm && !isGuildText) return;

			// Author gate. DMs use the `allowed_users` allowlist. Guild channels
			// are gated by the channel subscription itself (the agent only hears
			// a channel it explicitly attached to), so any member of an attached
			// channel may trigger the agent — `allowed_users` does not apply
			// there.
			if (
				isDm &&
				config.allowed_users.length > 0 &&
				!config.allowed_users.includes(msg.author.id)
			) {
				return;
			}

			// Dedup
			if (recentMessageIds.has(msg.id)) return;
			recentMessageIds.add(msg.id);
			if (recentMessageIds.size > 100) {
				const first = recentMessageIds.values().next().value;
				if (first) recentMessageIds.delete(first);
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

			// Resolve a human-readable channel name for guild channels (DMs have
			// no name). Guarded behind optional chaining because the DM channel
			// shape lacks `name`.
			const channelName = (msg.channel as { name?: string | null }).name ?? undefined;

			// Emit event
			emitEvent(msg.id, "message.received", {
				author: {
					id: msg.author.id,
					username: msg.author.username,
					display_name: msg.author.displayName ?? msg.author.username,
				},
				channel_id: msg.channelId,
				// guild_id is null for DMs, the guild snowflake for guild channels.
				// It lets the agent (and downstream context) distinguish a DM from
				// a server channel and address the right surface.
				guild_id: msg.guildId ?? null,
				channel_name: channelName,
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

			// Emit event. Use the Discord-issued interaction.id (snowflake) as
			// the eventId so deliverBatch's deduplicationSet can suppress
			// re-deliveries if Discord ever re-sends. Mirrors the message.received
			// path above (which uses msg.id). Generating a fresh randomUUID()
			// here would defeat dedup. Note: interaction.id is also unique per
			// interaction-instance (Discord doesn't reuse it), so this is safe
			// against legitimate-but-distinct interactions colliding.
			emitEvent(interaction.id, "interaction.received", eventData);
		} catch (err) {
			logger.error("[discord-server] interactionCreate handler error", {
				error: String(err),
			});
		}
	});
}
