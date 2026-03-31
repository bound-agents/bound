import type { Logger } from "@bound/shared";

// Discord.js types only — imported dynamically in connect()
type DiscordClient = import("discord.js").Client;

/**
 * Owns the Discord.js Client instance and gateway lifecycle.
 * Shared between DiscordConnector (DMs) and DiscordInteractionConnector (context menus).
 */
export class DiscordClientManager {
	private client: DiscordClient | null = null;

	constructor(private readonly logger: Logger) {}

	/**
	 * Create and log in the Discord.js client with combined intents.
	 * Intents cover both DM handling and guild interaction metadata.
	 * Idempotent — if already connected, logs a warning and returns.
	 */
	async connect(token: string): Promise<void> {
		if (this.client) {
			this.logger.warn("DiscordClientManager: already connected, skipping");
			return;
		}

		const { Client, GatewayIntentBits, Partials } = await import("discord.js");

		this.client = new Client({
			intents: [
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.DirectMessageReactions,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.Guilds,
			],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});

		await this.client.login(token);
		this.logger.info("Discord client connected");
	}

	/** Destroy the client and release resources. No-op if already disconnected. */
	async disconnect(): Promise<void> {
		if (this.client) {
			this.client.destroy();
			this.client = null;
			this.logger.info("Discord client disconnected");
		}
	}

	/** Returns the live client. Throws if not connected. */
	getClient(): DiscordClient {
		if (!this.client) {
			throw new Error("Discord client not connected");
		}
		return this.client;
	}
}
