import type { Database } from "bun:sqlite";
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
		const truncated = content.length > DISCORD_MAX_LENGTH
			? content.slice(0, DISCORD_MAX_LENGTH)
			: content;

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

	private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		// AC2.5: Only handle message context menu commands named "File for Later"
		if (!interaction.isMessageContextMenuCommand()) return;
		if (interaction.commandName !== "File for Later") return;

		// AC2.1: Defer with ephemeral response as first action
		await interaction.deferReply({ ephemeral: true });

		// Phase 3 adds: allowlist check, content validation, filing pipeline
		// Phase 4 adds: response polling and delivery

		this.logger.info("File for Later interaction received", {
			userId: interaction.user.id,
			messageId: interaction.targetMessage.id,
		});
	}
}
