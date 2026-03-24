import { randomUUID } from "node:crypto";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import { formatError } from "@bound/shared";
import type { Client } from "discord.js";
import { ChannelType, GatewayIntentBits, Partials } from "discord.js";
import { isAllowlisted } from "./allowlist";
import { findOrCreateThread, mapDiscordUser } from "./thread-mapping";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

// Map to track active agent loops per thread (for cancellation)
const activeLoops = new Map<string, AbortController>();

export class DiscordBot {
	private client: Client | null = null;

	constructor(
		private ctx: AppContext,
		private agentLoopFactory: AgentLoopFactory,
		private botToken: string,
	) {}

	async start(): Promise<void> {
		const { Client } = await import("discord.js");

		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.DirectMessageReactions,
				GatewayIntentBits.MessageContent,
			],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});

		this.client.on("ready", () => {
			console.log(`[discord] Bot ready as ${this.client?.user?.tag ?? "unknown"}`);
			console.log(`[discord] Listening for DMs from allowlisted users`);
		});

		this.client.on("messageCreate", async (msg) => {
			// Ignore bot messages
			if (msg.author.bot) {
				return;
			}

			console.log(`[discord] Message received: channel=${msg.channel.type} author=${msg.author.tag} (${msg.author.id}) content="${msg.content.slice(0, 50)}"`);

			// Ignore non-DM messages
			if (msg.channel.type !== ChannelType.DM) {
				console.log("[discord] Ignoring non-DM message");
				return;
			}

			// Check if user is allowlisted
			if (!isAllowlisted(msg.author.id, this.ctx.db)) {
				console.log(`[discord] User ${msg.author.id} not in allowlist, ignoring`);
				return;
			}

			// Map Discord user to database user
			const user = mapDiscordUser(this.ctx.db, msg.author.id);
			if (!user) {
				console.log(`[discord] User mapping failed for Discord ID ${msg.author.id} — is discord_id set in allowlist.json?`);
				return;
			}

			// Find or create thread for this user
			const thread = findOrCreateThread(this.ctx.db, user.id, this.ctx.siteId);

			console.log(`[discord] Processing DM: user=${user.id} thread=${thread.id}`);

			// Persist user message to DB
			const messageId = randomUUID();
			const now = new Date().toISOString();

			insertRow(
				this.ctx.db,
				"messages",
				{
					id: messageId,
					thread_id: thread.id,
					role: "user",
					content: msg.content,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: this.ctx.hostName,
				},
				this.ctx.siteId,
			);

			// Create abort controller for this loop (allows cancellation via reaction)
			const abortController = new AbortController();
			activeLoops.set(thread.id, abortController);

			try {
				// Show typing indicator during generation
				await msg.channel.sendTyping();
				const typingInterval = setInterval(() => {
					msg.channel.sendTyping().catch(() => {});
				}, 8000); // Discord typing indicator lasts ~10s, refresh every 8s

				// Trigger agent loop
				const agentLoop = this.agentLoopFactory({
					threadId: thread.id,
					userId: user.id,
					abortSignal: abortController.signal,
				});

				const result = await agentLoop.run();
				clearInterval(typingInterval);

				console.log(`[discord] Agent loop completed: ${result.messagesCreated} messages, ${result.toolCallsMade} tools${result.error ? `, error: ${result.error}` : ""}`);

				// Fetch the last assistant message from the thread
				const lastMessage = this.ctx.db
					.query(
						`SELECT content FROM messages
					WHERE thread_id = ? AND role = 'assistant'
					ORDER BY created_at DESC
					LIMIT 1`,
					)
					.get(thread.id) as { content: string } | null;

				if (lastMessage?.content) {
					// Send as regular messages (not replies) — in DMs, reply targets are redundant
					// Split long messages at 2000 char Discord limit
					const text = lastMessage.content;
					for (let i = 0; i < text.length; i += 2000) {
						await msg.channel.send(text.slice(i, i + 2000));
					}
				}
			} catch (error) {
				const errorMsg = formatError(error);
				console.error(`[discord] Agent loop failed: ${errorMsg}`);

				try {
					await msg.channel.send(`Error: ${errorMsg}`);
				} catch {
					// Ignore send errors
				}
			} finally {
				// Clean up active loop tracker
				activeLoops.delete(thread.id);
			}
		});

		// Register reaction-based cancel handler
		this.client.on("messageReactionAdd", async (reaction, user) => {
			// Ignore bot reactions
			if (user.bot) {
				return;
			}

			// Only handle cross (❌) emoji and "cancel" text
			const isCrossEmoji = reaction.emoji.name === "❌";
			const isCancelEmoji = reaction.emoji.name === "cancel";

			if (!isCrossEmoji && !isCancelEmoji) {
				return;
			}

			// Must be in DM
			if (!reaction.message.channel.isDMBased()) {
				return;
			}

			// Must be a bot message
			if (!reaction.message.author?.bot) {
				return;
			}

			// Find thread for this user
			const dbUser = mapDiscordUser(this.ctx.db, user.id);
			if (!dbUser) {
				return;
			}

			// Find active thread
			const thread = this.ctx.db
				.query(
					`SELECT * FROM threads
					WHERE user_id = ? AND interface = 'discord' AND deleted = 0
					ORDER BY created_at DESC
					LIMIT 1`,
				)
				.get(dbUser.id) as { id: string } | null;

			if (!thread) {
				return;
			}

			// Cancel the agent loop for this thread
			const abortController = activeLoops.get(thread.id);
			if (abortController) {
				abortController.abort();
				this.ctx.logger.info("Agent loop cancelled via reaction", {
					threadId: thread.id,
					userId: dbUser.id,
				});
			}
		});

		await this.client.login(this.botToken);
		this.ctx.logger.info("Discord bot connected", { token: "***" });
	}

	async stop(): Promise<void> {
		if (this.client) {
			await this.client.destroy();
			this.ctx.logger.info("Discord bot disconnected");
		}
	}
}

/**
 * Check if Discord should activate on this host.
 * Reads discord.json config from optionalConfig and verifies the host matches this machine.
 */
export function shouldActivate(ctx: AppContext): boolean {
	// Check if discord config was loaded
	const discordConfig = ctx.optionalConfig.discord;

	if (!discordConfig || !discordConfig.ok) {
		// discord.json not found or failed to load
		return false;
	}

	// Config is loaded and valid, check host
	const config = discordConfig.value;
	return (config.host as string) === ctx.hostName;
}
