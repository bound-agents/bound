import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, writeOutbox } from "@bound/core";
import type {
	IntakePayload,
	Logger,
	PlatformConnectorConfig,
	Thread,
	TypedEventEmitter,
	User,
} from "@bound/shared";
import type { PlatformConnector } from "../connector.js";

// Discord.js types only — imported dynamically in connect() to avoid hard dep at module load
type DiscordClient = import("discord.js").Client;
type DiscordMessage = import("discord.js").Message;

/**
 * Platform connector for Discord DM-based conversations.
 *
 * On message receipt: persists the user + message via insertRow(), then writes
 * an `intake` relay to relay_outbox targeting the hub. The relay processor on
 * the hub routes it to the appropriate host via the intake pipeline.
 *
 * On deliver: looks up the Discord user ID from the thread's user.platform_ids,
 * opens a DM channel, and sends the content chunked at 2000 characters.
 */
export class DiscordConnector implements PlatformConnector {
	readonly platform = "discord";
	readonly delivery = "broadcast" as const;

	private client: DiscordClient | null = null;
	/** Typing indicators per thread — cleared when platform:deliver fires for that thread. */
	private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

	constructor(
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly eventBus: TypedEventEmitter,
		private readonly logger: Logger,
	) {}

	async connect(_hostBaseUrl?: string): Promise<void> {
		const token = this.config.token;
		if (!token) {
			throw new Error("DiscordConnector: token is required in platforms.json connector config");
		}

		const { Client, GatewayIntentBits, Partials, ChannelType } = await import("discord.js");

		this.client = new Client({
			intents: [
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.DirectMessageReactions,
				GatewayIntentBits.MessageContent,
			],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});

		this.client.on("clientReady", (client) => {
			this.logger.info("Logged in as Discord bot", { tag: client.user.tag });
		});

		this.client.on("messageCreate", (msg) => {
			// Filter: only handle non-bot DM messages
			if (msg.author.bot) return;
			if (msg.channel.type !== ChannelType.DM) return;

			this.onMessage(msg).catch((err) => {
				this.logger.error("onMessage error", { error: String(err) });
			});
		});

		await this.client.login(token);
	}

	async disconnect(): Promise<void> {
		for (const threadId of this.typingTimers.keys()) {
			this.stopTyping(threadId);
		}
		this.client?.destroy();
		this.client = null;
	}

	async deliver(
		threadId: string,
		_messageId: string,
		content: string,
		_attachments?: unknown[],
	): Promise<void> {
		if (!this.client) {
			throw new Error("DiscordConnector: not connected");
		}

		// Stop typing indicator now that we have a response
		this.stopTyping(threadId);

		const channel = await this.getDMChannelForThread(threadId);
		if (!channel) {
			this.logger.warn("No DM channel found for thread", { threadId });
			return;
		}

		// Chunk content at Discord's 2000-character limit (AC6.3)
		for (let i = 0; i < content.length; i += 2000) {
			await channel.send(content.slice(i, i + 2000));
		}
	}

	private async onMessage(msg: DiscordMessage): Promise<void> {
		// Allowlist check — reads allowed_users from platforms.json config (AC6.5)
		if (
			this.config.allowed_users.length > 0 &&
			!this.config.allowed_users.includes(msg.author.id)
		) {
			return; // Silently reject non-allowlisted users
		}

		// Find or create the bound user record (using platform_ids JSON)
		const user = this.findOrCreateUser(
			msg.author.id,
			msg.author.displayName ?? msg.author.username,
		);

		// Find or create the thread for this user
		const thread = this.findOrCreateThread(user.id);

		// Persist the incoming message via insertRow (AC6.2)
		const messageId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			this.db,
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
				host_origin: this.siteId,
				deleted: 0,
			},
			this.siteId,
		);

		// Start typing indicator — refreshed every 8s (Discord typing expires at ~10s).
		// Cleared when platform:deliver fires for this thread or after 5 minutes.
		this.startTyping(thread.id, msg.channel as { sendTyping(): Promise<void> });

		// Write intake relay to outbox — no direct agent loop invocation (AC6.1)
		const hubSiteId = this.getHubSiteId();
		writeOutbox(this.db, {
			id: randomUUID(),
			source_site_id: this.siteId,
			target_site_id: hubSiteId,
			kind: "intake",
			ref_id: null,
			idempotency_key: `intake:discord:${msg.id}`,
			stream_id: null,
			payload: JSON.stringify({
				platform: "discord",
				platform_event_id: msg.id,
				thread_id: thread.id,
				user_id: user.id,
				message_id: messageId,
				content: msg.content,
			} satisfies IntakePayload),
			created_at: now,
			expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		});

		this.eventBus.emit("sync:trigger", { reason: "discord-intake" });
	}

	private startTyping(threadId: string, channel: { sendTyping(): Promise<void> }): void {
		this.stopTyping(threadId); // Clear any existing timer for this thread
		// Send immediately, then every 8s (Discord typing expires ~10s)
		channel.sendTyping().catch(() => {});
		const timer = setInterval(() => {
			channel.sendTyping().catch(() => {});
		}, 8_000);
		this.typingTimers.set(threadId, timer);
		// Safety cap: stop after 5 minutes regardless
		setTimeout(() => this.stopTyping(threadId), 5 * 60 * 1000);
	}

	private stopTyping(threadId: string): void {
		const timer = this.typingTimers.get(threadId);
		if (timer !== undefined) {
			clearInterval(timer);
			this.typingTimers.delete(threadId);
		}
	}

	private findOrCreateUser(discordId: string, displayName: string): User {
		// Look up user by platform_ids.discord JSON field
		const existing = this.db
			.query<User, [string]>(
				"SELECT * FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
			)
			.get(discordId);
		if (existing) return existing;

		// Create new user with platform_ids = {"discord": "<id>"}
		const userId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			this.db,
			"users",
			{
				id: userId,
				display_name: displayName,
				platform_ids: JSON.stringify({ discord: discordId }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			this.siteId,
		);
		const result = this.db
			.query<User, [string]>("SELECT * FROM users WHERE id = ? LIMIT 1")
			.get(userId);
		if (!result) {
			throw new Error(`User ${userId} not found after insertRow`);
		}
		return result;
	}

	private findOrCreateThread(userId: string): Thread {
		const existing = this.db
			.query<Thread, [string]>(
				"SELECT * FROM threads WHERE user_id = ? AND interface = 'discord' AND deleted = 0 LIMIT 1",
			)
			.get(userId);
		if (existing) return existing;

		const threadId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			this.db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: this.siteId,
				color: 0,
				title: null,
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			this.siteId,
		);
		const result = this.db
			.query<Thread, [string]>("SELECT * FROM threads WHERE id = ? LIMIT 1")
			.get(threadId);
		if (!result) {
			throw new Error(`Thread ${threadId} not found after insertRow`);
		}
		return result;
	}

	private async getDMChannelForThread(
		threadId: string,
	): Promise<{ send(content: string): Promise<unknown> } | null> {
		const thread = this.db
			.query<{ user_id: string }, [string]>(
				"SELECT user_id FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
			)
			.get(threadId);
		if (!thread) return null;

		const user = this.db
			.query<{ platform_ids: string | null }, [string]>(
				"SELECT platform_ids FROM users WHERE id = ? AND deleted = 0 LIMIT 1",
			)
			.get(thread.user_id);
		if (!user?.platform_ids) return null;

		const platformIds = JSON.parse(user.platform_ids) as Record<string, string>;
		const discordId = platformIds.discord;
		if (!discordId) return null;

		if (!this.client) {
			throw new Error("Discord client not initialized");
		}
		const discordUser = await this.client.users.fetch(discordId);
		return discordUser.createDM();
	}

	private getHubSiteId(): string {
		const hub = this.db
			.query<{ value: string }, []>(
				"SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
			)
			.get();
		return hub?.value ?? this.siteId; // Fall back to self in single-host mode
	}
}
