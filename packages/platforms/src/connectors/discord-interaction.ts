import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, writeOutbox } from "@bound/core";
import { MAX_FILE_STORAGE_BYTES } from "@bound/shared";
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

/** Max chars to inline from a text file. Larger files get a preview + path reference. */
const MAX_INLINE_TEXT_CHARS = 50_000;

/** MIME types whose content can be inlined as text for the LLM to read */
const TEXT_READABLE_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/html",
	"text/csv",
	"text/xml",
	"application/json",
	"application/yaml",
	"application/x-yaml",
	"application/xml",
	"application/javascript",
	"application/typescript",
]);

/** File extensions treated as text-readable when MIME type is ambiguous */
const TEXT_EXTENSIONS = new Set([
	".md",
	".txt",
	".json",
	".csv",
	".py",
	".ts",
	".js",
	".yaml",
	".yml",
	".toml",
	".xml",
	".html",
	".css",
	".sh",
	".bash",
	".zsh",
	".rs",
	".go",
	".java",
	".kt",
	".c",
	".cpp",
	".h",
	".hpp",
	".rb",
	".lua",
	".sql",
]);

/** Polling interval for agent response. Matches bound-mcp pattern. */
const POLL_INTERVAL_MS = 500;

/** Maximum time to wait for agent response. */
const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes

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

	/** Set by disconnect() to abort any active polling loops. */
	private disconnecting = false;

	constructor(
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly eventBus: TypedEventEmitter,
		private readonly logger: Logger,
		private readonly clientManager: DiscordClientManager,
		private readonly pollTimeoutMs: number = MAX_POLL_MS,
	) {}

	async connect(_hostBaseUrl?: string): Promise<void> {
		this.disconnecting = false;

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
		this.disconnecting = true;

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

		// Empty-content delivers are typing-stop signals from executeProcess.
		// The DM connector ignores them (no-op loop), but editReply rejects
		// empty messages (Discord API 50006). Skip without consuming the stored
		// interaction so pollForResponse can still deliver the real response.
		if (!content) return;

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

	/**
	 * Poll the local DB for an assistant response on the thread.
	 * Adapted from packages/mcp-server/src/handler.ts:24-43.
	 *
	 * Unlike bound-mcp which polls via HTTP, this queries the DB directly
	 * since the interaction connector runs on the platform leader host.
	 *
	 * Checks this.disconnecting to abort early on shutdown.
	 */
	private async pollForResponse(threadId: string, afterTimestamp: string): Promise<void> {
		const startTime = Date.now();

		while (true) {
			// Abort if connector is shutting down
			if (this.disconnecting) {
				this.logger.info("Polling aborted — connector disconnecting", { threadId });
				this.interactions.delete(threadId);
				return;
			}
			// Query for assistant response created after the user's filing message
			const response = this.db
				.query<{ id: string; content: string }, [string, string]>(
					"SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND created_at > ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
				)
				.get(threadId, afterTimestamp);

			if (response) {
				// AC8.1: Found response — deliver via editReply
				await this.deliver(threadId, response.id, response.content);
				return;
			}

			// AC8.2: Check timeout
			if (Date.now() - startTime >= this.pollTimeoutMs) {
				this.logger.warn("Polling timed out waiting for agent response", { threadId });
				// Deliver timeout error via editReply
				const stored = this.interactions.get(threadId);
				if (stored && new Date(stored.expiresAt) > new Date()) {
					try {
						await stored.interaction.editReply({
							content: "Error: Timed out waiting for agent response after 5 minutes.",
						});
					} catch (err) {
						this.logger.warn("editReply failed for timeout message", {
							threadId,
							error: String(err),
						});
					}
				}
				this.interactions.delete(threadId);
				return;
			}

			// Wait before next poll (same pattern as bound-mcp handler.ts:42)
			await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}

	private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		// AC2.5: Only handle message context menu commands named "File for Later"
		if (!interaction.isMessageContextMenuCommand()) return;
		if (interaction.commandName !== "File for Later") return;

		// AC2.1: Defer with ephemeral response as first action
		// MessageFlags.Ephemeral = 1 << 6 = 64 (avoids deprecated "ephemeral" option)
		await interaction.deferReply({ flags: 64 });

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
		const hasFiles = targetMessage.attachments.some(
			(att) => att.contentType && !att.contentType.startsWith("image/"),
		);
		if (!hasContent && !hasImages && !hasFiles) {
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
		// Use guild name if cached, fall back to guildId, then "DM" only if truly a DM
		const guildName =
			interaction.guild?.name ?? ((interaction as unknown as { guildId?: string }).guildId || "DM");
		const timestamp = targetMessage.createdAt?.toISOString() ?? new Date().toISOString();
		// Use same timestamp for both file and message rows
		const now = new Date().toISOString();

		// Collect image attachment URLs
		// Discord.js Collection.filter() returns a Collection (extends Map).
		// Use .values() to iterate attachment objects, not [key, value] entries.
		const imageUrls: string[] = [];
		for (const att of targetMessage.attachments
			.filter((a: { contentType?: string | null }) => a.contentType?.startsWith("image/") ?? false)
			.values()) {
			imageUrls.push((att as unknown as { url: string }).url);
		}

		// Download and store non-image file attachments
		const storedFiles: Array<{
			name: string;
			path: string;
			contentType: string;
			inlineContent?: string;
		}> = [];
		for (const att of targetMessage.attachments
			.filter(
				(a: { contentType?: string | null }) =>
					a.contentType != null && !a.contentType.startsWith("image/"),
			)
			.values()) {
			const a = att as unknown as {
				name: string;
				url: string;
				contentType: string;
				size: number;
			};
			if (a.size > MAX_FILE_STORAGE_BYTES) {
				this.logger.warn("[discord-interaction] File attachment exceeds size limit, skipping", {
					name: a.name,
					size: a.size,
					limit: MAX_FILE_STORAGE_BYTES,
				});
				continue;
			}
			try {
				const response = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
				if (!response.ok) {
					this.logger.warn("[discord-interaction] Failed to download file attachment", {
						url: a.url,
						status: response.status,
					});
					continue;
				}
				const bytes = await response.arrayBuffer();
				const safeName =
					a.name.replace(/\.\./g, "").replace(/[/\\]/g, "_").replace(/^_+/, "") || "unnamed";
				const filePath = `/home/user/uploads/${safeName}`;

				// Determine if the file content is text-readable
				const ext = a.name.includes(".") ? `.${a.name.split(".").pop()?.toLowerCase()}` : "";
				const baseContentType = a.contentType.split(";")[0].trim();
				const isTextReadable =
					TEXT_READABLE_TYPES.has(baseContentType) ||
					baseContentType.startsWith("text/") ||
					TEXT_EXTENSIONS.has(ext);

				const textContent = isTextReadable ? new TextDecoder().decode(bytes) : null;
				const storedContent = textContent ?? Buffer.from(bytes).toString("base64");

				const fileId = randomUUID();
				insertRow(
					this.db,
					"files",
					{
						id: fileId,
						path: filePath,
						content: storedContent,
						is_binary: textContent ? 0 : 1,
						size_bytes: bytes.byteLength,
						created_at: now,
						modified_at: now,
						host_origin: this.siteId,
						deleted: 0,
						created_by: user.id,
					},
					this.siteId,
				);
				storedFiles.push({
					name: a.name,
					path: filePath,
					contentType: a.contentType,
					inlineContent: textContent ?? undefined,
				});
			} catch (err) {
				this.logger.warn("[discord-interaction] Error downloading file attachment, skipping", {
					name: a.name,
					error: String(err),
				});
			}
		}

		const filingPromptParts = [
			"File this message for future reference.",
			"",
			`From: @${targetMessage.author.displayName ?? targetMessage.author.username} ${trustSignal}`,
			`Channel: ${channelName} in ${guildName}`,
			`Sent: ${timestamp}`,
			"",
		];
		if (targetMessage.content) {
			filingPromptParts.push(targetMessage.content);
		}
		if (imageUrls.length > 0) {
			if (targetMessage.content) filingPromptParts.push("");
			filingPromptParts.push(...imageUrls.map((url, i) => `[Image ${i + 1}]: ${url}`));
		}
		if (storedFiles.length > 0) {
			if (targetMessage.content || imageUrls.length > 0) filingPromptParts.push("");
			for (let i = 0; i < storedFiles.length; i++) {
				const f = storedFiles[i];
				if (f.inlineContent) {
					if (f.inlineContent.length <= MAX_INLINE_TEXT_CHARS) {
						filingPromptParts.push(`[File ${i + 1}: ${f.name}]\n\n${f.inlineContent}`);
					} else {
						const preview = f.inlineContent.slice(0, MAX_INLINE_TEXT_CHARS);
						filingPromptParts.push(
							`[File ${i + 1}: ${f.name} — ${f.inlineContent.length} chars, showing first ${MAX_INLINE_TEXT_CHARS}]\n\n${preview}\n\n[... truncated, full file at ${f.path}]`,
						);
					}
				} else {
					filingPromptParts.push(
						`[File ${i + 1}]: ${f.name} (${f.contentType}) stored at ${f.path}`,
					);
				}
			}
		}

		const filingPrompt = filingPromptParts.join("\n");

		// AC3.3: Persist user message with filing prompt
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
			return;
		}

		this.logger.info("File for Later interaction processed", {
			userId: interaction.user.id,
			messageId: targetMessage.id,
			threadId: thread.id,
		});

		// Phase 4: Poll for agent response and deliver
		// Use the user message's created_at as the "after" boundary
		await this.pollForResponse(thread.id, now);
	}
}
