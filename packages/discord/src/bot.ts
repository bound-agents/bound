import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { Client } from "discord.js";
import { GatewayIntentBits } from "discord.js";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

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

		this.client.on("messageCreate", (msg) => {
			// Ignore bot messages
			if (msg.author.bot) {
				return;
			}

			// Ignore non-DM messages
			if (msg.channel.type !== 1) {
				return;
			}

			this.ctx.logger.debug("Received DM", {
				authorId: msg.author.id,
				content: msg.content,
			});
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
