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

		this.client.on("clientReady", (c) => {
			console.log(`[discord] Bot ready as ${c.user.tag}`);
		});

		this.client.on("messageCreate", async (msg) => {
			if (msg.author.bot) return;
			if (msg.channel.type !== ChannelType.DM) return;

			if (!isAllowlisted(msg.author.id, this.ctx.db)) {
				return;
			}

			const user = mapDiscordUser(this.ctx.db, msg.author.id);
			if (!user) {
				console.log(`[discord] User mapping failed for ${msg.author.id} — check discord_id in allowlist.json`);
				return;
			}

			const thread = findOrCreateThread(this.ctx.db, user.id, this.ctx.siteId);
			console.log(`[discord] DM from ${msg.author.tag}: thread=${thread.id.slice(0, 8)}`);

			insertRow(
				this.ctx.db,
				"messages",
				{
					id: randomUUID(),
					thread_id: thread.id,
					role: "user",
					content: msg.content,
					model_id: null,
					tool_name: null,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: this.ctx.hostName,
				},
				this.ctx.siteId,
			);

			const abortController = new AbortController();
			activeLoops.set(thread.id, abortController);

			try {
				await msg.channel.sendTyping();
				const typingInterval = setInterval(() => {
					msg.channel.sendTyping().catch(() => {});
				}, 8000);

				const agentLoop = this.agentLoopFactory({
					threadId: thread.id,
					userId: user.id,
					abortSignal: abortController.signal,
				});

				const result = await agentLoop.run();
				clearInterval(typingInterval);

				if (result.error) {
					console.error(`[discord] Agent error: ${result.error}`);
				}

				const lastMessage = this.ctx.db
					.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
					.get(thread.id) as { content: string } | null;

				if (lastMessage?.content) {
					const text = lastMessage.content;
					for (let i = 0; i < text.length; i += 2000) {
						await msg.channel.send(text.slice(i, i + 2000));
					}
				}
			} catch (error) {
				console.error(`[discord] Error: ${formatError(error)}`);
				try {
					await msg.channel.send(`Error: ${formatError(error)}`);
				} catch {
					// Ignore send errors during error reporting
				}
			} finally {
				activeLoops.delete(thread.id);
			}
		});

		this.client.on("messageReactionAdd", async (reaction, user) => {
			if (user.bot) return;
			if (reaction.emoji.name !== "❌" && reaction.emoji.name !== "cancel") return;
			if (!reaction.message.channel.isDMBased()) return;
			if (!reaction.message.author?.bot) return;

			const dbUser = mapDiscordUser(this.ctx.db, user.id);
			if (!dbUser) return;

			const thread = this.ctx.db
				.query("SELECT id FROM threads WHERE user_id = ? AND interface = 'discord' AND deleted = 0 ORDER BY created_at DESC LIMIT 1")
				.get(dbUser.id) as { id: string } | null;

			if (!thread) return;

			const controller = activeLoops.get(thread.id);
			if (controller) {
				controller.abort();
				console.log(`[discord] Cancelled agent loop for thread ${thread.id.slice(0, 8)}`);
			}
		});

		await this.client.login(this.botToken);
	}

	async stop(): Promise<void> {
		if (this.client) {
			await this.client.destroy();
		}
	}
}

/**
 * Check if Discord should activate on this host.
 * Returns true only if discord.json exists and its host field matches this machine's hostname.
 */
export function shouldActivate(ctx: AppContext): boolean {
	const discordConfig = ctx.optionalConfig.discord;
	if (!discordConfig || !discordConfig.ok) return false;
	return (discordConfig.value.host as string) === ctx.hostName;
}
