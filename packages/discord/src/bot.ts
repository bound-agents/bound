import { randomUUID } from "node:crypto";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import type { Client } from "discord.js";
import { ChannelType, GatewayIntentBits } from "discord.js";
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
			intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
		});

		this.client.on("messageCreate", async (msg) => {
			// Ignore bot messages
			if (msg.author.bot) {
				return;
			}

			// Ignore non-DM messages
			if (msg.channel.type !== ChannelType.DM) {
				return;
			}

			// Check if user is allowlisted
			if (!isAllowlisted(msg.author.id, this.ctx.db)) {
				this.ctx.logger.debug("Non-allowlisted user attempted DM", {
					authorId: msg.author.id,
				});
				return;
			}

			// Map Discord user to database user
			const user = mapDiscordUser(this.ctx.db, msg.author.id);
			if (!user) {
				this.ctx.logger.debug("User mapping failed", {
					authorId: msg.author.id,
				});
				return;
			}

			// Find or create thread for this user
			const thread = findOrCreateThread(this.ctx.db, user.id, this.ctx.siteId);

			this.ctx.logger.debug("Processing DM for user", {
				userId: user.id,
				threadId: thread.id,
				content: msg.content,
			});

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
				// Trigger agent loop
				const agentLoop = this.agentLoopFactory({
					threadId: thread.id,
					userId: user.id,
					abortSignal: abortController.signal,
				});

				const result = await agentLoop.run();

				this.ctx.logger.debug("Agent loop completed", {
					threadId: thread.id,
					messagesCreated: result.messagesCreated,
					error: result.error,
				});

				// Fetch the last assistant message from the thread
				const lastMessage = this.ctx.db
					.query(
						`SELECT * FROM messages
					WHERE thread_id = ? AND role = 'assistant'
					ORDER BY created_at DESC
					LIMIT 1`,
					)
					.get(thread.id) as { content: string } | null;

				if (lastMessage?.content) {
					// Send response to Discord
					await msg.reply({
						content: lastMessage.content,
					});
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.ctx.logger.error("Agent loop failed", {
					threadId: thread.id,
					error: errorMsg,
				});

				// Optionally notify user of error
				try {
					await msg.reply({
						content: `Error: ${errorMsg}`,
					});
				} catch {
					// Ignore reply errors
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
