import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, writeOutbox } from "@bound/core";
import type { IntakePayload, Thread, User } from "@bound/shared";
import type { Logger, PlatformConnectorConfig, TypedEventEmitter } from "@bound/shared";
import type { PlatformConnector } from "../connector.js";
import type { DiscordClientManager } from "./discord-client-manager.js";

// Discord.js types — imported dynamically in connect()
type DiscordInteraction = import("discord.js").Interaction;

/** Interaction token expires in 15 min; use 14 min for safety margin. */
const INTERACTION_TTL_MS = 14 * 60 * 1000;

/** Discord's message content limit. */
const DISCORD_MAX_LENGTH = 2000;

interface StoredInteraction {
	/** The Discord.js interaction object — needed for editReply. */
	interaction: { editReply(options: { content: string }): Promise<unknown> };
	/** ISO timestamp when this entry expires. */
	expiresAt: string;
}

export class DiscordInteractionConnector implements PlatformConnector {
	readonly platform = "discord-interaction";
	readonly delivery = "broadcast" as const;

	/** Map from bound thread ID to stored interaction. Pruned lazily on access. */
	private interactions = new Map<string, StoredInteraction>();
	private onInteractionCreate: ((interaction: DiscordInteraction) => void) | null = null;

	constructor(
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly eventBus: TypedEventEmitter,
		private readonly logger: Logger,
		private readonly clientManager: DiscordClientManager,
	) {}

	async connect(_hostBaseUrl?: string): Promise<void> {
		const client = this.clientManager.getClient();

		// Register "File for Later" context menu command (idempotent upsert — AC1.1, AC1.2)
		if (!client.application) {
			throw new Error("DiscordInteractionConnector: client.application not available");
		}
		await client.application.commands.create({
			name: "File for Later",
			type: 3, // ApplicationCommandType.Message
		});
		this.logger.info("Registered 'File for Later' context menu command");

		// Register interaction listener
		this.onInteractionCreate = (interaction) => {
			this.handleInteraction(interaction).catch((err) => {
				this.logger.error("Interaction handler error", { error: String(err) });
			});
		};
		client.on("interactionCreate", this.onInteractionCreate);
	}

	async disconnect(): Promise<void> {
		try {
			const client = this.clientManager.getClient();
			if (this.onInteractionCreate) {
				client.off("interactionCreate", this.onInteractionCreate);
			}
		} catch {
			// Client already disconnected
		}
		this.onInteractionCreate = null;
		this.interactions.clear();
	}

	/**
	 * Deliver agent response via editReply on the stored interaction.
	 * AC6.1: valid interaction -> editReply
	 * AC6.2: truncate to 2000 chars
	 * AC6.3: expired/missing -> warn, don't throw
	 */
	async deliver(threadId: string, _messageId: string, content: string): Promise<void> {
		const stored = this.interactions.get(threadId);

		if (!stored) {
			this.logger.warn("No stored interaction for thread", { threadId });
			return;
		}

		// Lazy TTL check
		if (new Date(stored.expiresAt) <= new Date()) {
			this.logger.warn("Interaction token expired", { threadId, expiresAt: stored.expiresAt });
			this.interactions.delete(threadId);
			return;
		}

		// AC6.2: truncate to Discord's limit
		const truncated =
			content.length > DISCORD_MAX_LENGTH ? content.slice(0, DISCORD_MAX_LENGTH) : content;

		try {
			await stored.interaction.editReply({ content: truncated });
		} catch (err) {
			// Discord may reject if token actually expired (race with TTL check)
			this.logger.warn("editReply failed", { threadId, error: String(err) });
		} finally {
			this.interactions.delete(threadId);
		}
	}

	/**
	 * Store an interaction for later delivery via editReply.
	 * Called from the interaction handler after pipeline setup.
	 */
	storeInteraction(
		threadId: string,
		interaction: { editReply(options: { content: string }): Promise<unknown> },
	): void {
		this.interactions.set(threadId, {
			interaction,
			expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString(),
		});
	}

	private findOrCreateUser(discordId: string, displayName: string): User {
		const existing = this.db
			.query<User, [string]>(
				"SELECT * FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
			)
			.get(discordId);
		if (existing) return existing;

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
				"SELECT * FROM threads WHERE user_id = ? AND interface = 'discord-interaction' AND deleted = 0 LIMIT 1",
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
				interface: "discord-interaction",
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

	private getHubSiteId(): string {
		const hub = this.db
			.query<{ value: string }, []>(
				"SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
			)
			.get();
		return hub?.value ?? this.siteId;
	}

	/**
	 * Resolve trust signal for the target message's author.
	 * - Bot itself: "(this bot)"
	 * - Recognized bound user: "(recognized — bound user \"name\")"
	 * - Unknown: "(unrecognized)"
	 */
	private resolveTrustSignal(authorId: string, _authorBot: boolean): string {
		// AC4.3: Check if target is the bot itself
		try {
			const client = this.clientManager.getClient();
			if (client.user && authorId === client.user.id) {
				return "(this bot)";
			}
		} catch {
			// Client not connected — fall through to DB lookup
		}

		// AC4.1/AC4.2: Look up in users table
		const boundUser = this.db
			.query<{ display_name: string }, [string]>(
				"SELECT display_name FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
			)
			.get(authorId);

		if (boundUser) {
			return `(recognized — bound user "${boundUser.display_name}")`;
		}
		return "(unrecognized)";
	}

	private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		// AC2.5: Only handle message context menu commands named "File for Later"
		if (!interaction.isMessageContextMenuCommand()) return;
		if (interaction.commandName !== "File for Later") return;

		// AC2.1: Defer with ephemeral response as first action
		await interaction.deferReply({ ephemeral: true });

		// AC2.3: Allowlist check on the invoking user
		if (
			this.config.allowed_users.length > 0 &&
			!this.config.allowed_users.includes(interaction.user.id)
		) {
			await interaction.editReply({
				content: "Error: You are not authorized to use this command.",
			});
			return;
		}

		// AC2.4: Validate extractable content
		const targetMessage = interaction.targetMessage;
		const hasContent = targetMessage.content && targetMessage.content.trim().length > 0;
		const hasImages = targetMessage.attachments.some(
			(att) => att.contentType?.startsWith("image/") ?? false,
		);
		if (!hasContent && !hasImages) {
			await interaction.editReply({ content: "Error: This message has no extractable content." });
			return;
		}

		// AC3.1: Find or create user for the invoking user
		const user = this.findOrCreateUser(
			interaction.user.id,
			interaction.user.displayName ?? interaction.user.username,
		);

		// AC3.2: Find or create thread with interface = 'discord-interaction'
		const thread = this.findOrCreateThread(user.id);

		// AC4.1/AC4.2/AC4.3: Resolve trust signal for the target author
		const trustSignal = this.resolveTrustSignal(targetMessage.author.id, targetMessage.author.bot);

		// Build filing prompt (AC3.3)
		const channelName =
			interaction.channel && "name" in interaction.channel
				? `#${interaction.channel.name}`
				: "unknown channel";
		const guildName = interaction.guild?.name ?? "DM";
		const timestamp = targetMessage.createdAt?.toISOString() ?? new Date().toISOString();

		const filingPrompt = [
			"File this message for future reference.",
			"",
			`From: @${targetMessage.author.displayName ?? targetMessage.author.username} ${trustSignal}`,
			`Channel: ${channelName} in ${guildName}`,
			`Sent: ${timestamp}`,
			"",
			targetMessage.content,
		].join("\n");

		// AC3.3: Persist user message with filing prompt
		const now = new Date().toISOString();
		const messageId = randomUUID();
		insertRow(
			this.db,
			"messages",
			{
				id: messageId,
				thread_id: thread.id,
				role: "user",
				content: filingPrompt,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: this.siteId,
				deleted: 0,
			},
			this.siteId,
		);

		// Store interaction for later delivery (Phase 4 polls and calls deliver())
		this.storeInteraction(thread.id, interaction);

		// AC3.4: Write intake relay
		try {
			const hubSiteId = this.getHubSiteId();
			writeOutbox(this.db, {
				id: randomUUID(),
				source_site_id: this.siteId,
				target_site_id: hubSiteId,
				kind: "intake",
				ref_id: null,
				idempotency_key: `intake:discord-interaction:${targetMessage.id}:${interaction.user.id}`,
				stream_id: null,
				payload: JSON.stringify({
					platform: "discord-interaction",
					platform_event_id: targetMessage.id,
					thread_id: thread.id,
					user_id: user.id,
					message_id: messageId,
					content: filingPrompt,
				} satisfies IntakePayload),
				created_at: now,
				expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			});

			this.eventBus.emit("sync:trigger", { reason: "discord-interaction-intake" });
		} catch (err) {
			this.logger.error("Failed to write intake relay", { error: String(err) });
			await interaction.editReply({
				content: "Error: Failed to process this message. Please try again.",
			});
		}

		this.logger.info("File for Later interaction processed", {
			userId: interaction.user.id,
			messageId: targetMessage.id,
			threadId: thread.id,
		});
	}
}
