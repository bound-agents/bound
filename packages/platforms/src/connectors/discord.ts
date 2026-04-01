import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { insertRow, writeOutbox } from "@bound/core";
import type { ContentBlock, ToolDefinition } from "@bound/llm";
import {
	MAX_FILE_STORAGE_BYTES,
	type IntakePayload,
	type Logger,
	type PlatformConnectorConfig,
	type Thread,
	type TypedEventEmitter,
	type User,
} from "@bound/shared";
import type { PlatformConnector } from "../connector.js";
import type { DiscordClientManager } from "./discord-client-manager.js";

// Discord.js types only — imported dynamically in connect() to avoid hard dep at module load
type DiscordMessage = import("discord.js").Message;

/** Attachments >= this size are stored as file_ref entries in the files table. */
const ATTACHMENT_FILE_REF_THRESHOLD = 1024 * 1024; // 1 MB

/** Discord image MIME types supported as ContentBlock image variants */
const DISCORD_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

	private onClientReady: ((client: { user: { tag: string } }) => void) | null = null;
	private onMessageCreate: ((msg: DiscordMessage) => void) | null = null;
	/** Dedup: track recently-seen Discord message IDs to guard against gateway replays. */
	private recentMessageIds = new Set<string>();
	/** Typing indicators per thread — cleared when platform:deliver fires for that thread. */
	private typingTimers = new Map<
		string,
		{ interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
	>();

	constructor(
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly eventBus: TypedEventEmitter,
		private readonly logger: Logger,
		private readonly clientManager: DiscordClientManager,
	) {}

	async connect(_hostBaseUrl?: string): Promise<void> {
		// Token validation removed — registry validates before creating connectors
		// clientManager.connect() removed — compound connector drives lifecycle

		const client = this.clientManager.getClient();

		const { ChannelType } = await import("discord.js");

		// Guard against double-registration: remove old handlers before registering
		// new ones. Without this, calling connect() twice (e.g., leader re-election)
		// would fire onMessage multiple times per Discord event, duplicating messages.
		if (this.onClientReady) client.off("clientReady", this.onClientReady);
		if (this.onMessageCreate) client.off("messageCreate", this.onMessageCreate);

		this.onClientReady = (c) => {
			this.logger.info("Logged in as Discord bot", { tag: c.user.tag });
		};

		this.onMessageCreate = (msg) => {
			if (msg.author.bot) return;
			if (msg.channel.type !== ChannelType.DM) return;
			this.onMessage(msg).catch((err) => {
				this.logger.error("onMessage error", { error: String(err) });
			});
		};

		client.on("clientReady", this.onClientReady);
		client.on("messageCreate", this.onMessageCreate);
	}

	async disconnect(): Promise<void> {
		for (const threadId of this.typingTimers.keys()) {
			this.stopTyping(threadId);
		}
		try {
			const client = this.clientManager.getClient();
			if (this.onClientReady) client.off("clientReady", this.onClientReady);
			if (this.onMessageCreate) client.off("messageCreate", this.onMessageCreate);
		} catch {
			// Client already disconnected — handlers already cleaned up by destroy()
		}
		this.onClientReady = null;
		this.onMessageCreate = null;
		// clientManager.disconnect() removed — compound connector drives lifecycle
	}

	async deliver(
		threadId: string,
		_messageId: string,
		content: string,
		attachments?: Array<{ filename: string; data: Buffer }>,
	): Promise<void> {
		// No client null check needed — getDMChannelForThread uses clientManager.getClient()
		const channel = await this.getDMChannelForThread(threadId);

		// Stop typing indicator now that we have the channel (or failed to get it)
		this.stopTyping(threadId);

		if (!channel) {
			this.logger.warn("No DM channel found for thread", { threadId });
			return;
		}

		if (attachments && attachments.length > 0) {
			// Attachment delivery: send content + files in a single message.
			// The discord_send_message tool already validates content ≤ 2000 chars,
			// so no chunking is needed here.
			await channel.send({
				content: content || undefined,
				files: attachments.map((a) => ({ attachment: a.data, name: a.filename })),
			});
		} else {
			// Text-only delivery: chunk at Discord's 2000-character limit (AC6.3).
			for (let i = 0; i < content.length; i += 2000) {
				await channel.send(content.slice(i, i + 2000));
			}
		}
	}

	getPlatformTools(
		threadId: string,
		readFileFn?: (path: string) => Promise<Uint8Array>,
	): Map<
		string,
		{
			toolDefinition: ToolDefinition;
			execute: (input: Record<string, unknown>) => Promise<string>;
		}
	> {
		const toolDefinition: ToolDefinition = {
			type: "function",
			function: {
				name: "discord_send_message",
				description:
					"Send a message to the Discord user in this conversation. " +
					"If you do not call this tool, the user sees nothing (silence). " +
					"Multiple calls produce multiple separate messages in order.",
				parameters: {
					type: "object",
					properties: {
						content: {
							type: "string",
							description: "Text content to send. Maximum 2000 characters.",
						},
						attachments: {
							type: "array",
							description: "Optional list of absolute filesystem paths to attach.",
							items: { type: "string" },
						},
					},
					required: ["content"],
				},
			},
		};

		const execute = async (input: Record<string, unknown>): Promise<string> => {
			const content = input.content;
			const attachmentPaths = input.attachments as string[] | undefined;

			// Validate content
			if (typeof content !== "string") {
				return "Error: content must be a string";
			}
			if (content.length > 2000) {
				return `Error: content exceeds 2000 characters (got ${content.length})`;
			}

			// Load attachment files (fail-fast on first unreadable path — no partial delivery).
			// Use async readFile to avoid blocking the event loop.
			let loadedFiles: Array<{ filename: string; data: Buffer }> | undefined;
			if (attachmentPaths && attachmentPaths.length > 0) {
				loadedFiles = [];
				for (const filePath of attachmentPaths) {
					try {
						const data: Uint8Array | Buffer = readFileFn
							? await readFileFn(filePath)
							: await readFile(filePath);
						const filename = filePath.split("/").pop() ?? filePath;
						loadedFiles.push({ filename, data: Buffer.from(data) });
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return `Error: cannot read attachment at path "${filePath}": ${msg}`;
					}
				}
			}

			await this.deliver(threadId, randomUUID(), content, loadedFiles);
			return "sent";
		};

		const tools = new Map<
			string,
			{
				toolDefinition: ToolDefinition;
				execute: (input: Record<string, unknown>) => Promise<string>;
			}
		>();
		tools.set("discord_send_message", { toolDefinition, execute });
		return tools;
	}

	private async onMessage(msg: DiscordMessage): Promise<void> {
		// Dedup: Discord.js gateway can replay the same messageCreate event
		// (shard reconnect, packet replay). Track recent IDs and skip dupes.
		if (this.recentMessageIds.has(msg.id)) return;
		this.recentMessageIds.add(msg.id);
		// Prune set lazily — keep at most 100 entries
		if (this.recentMessageIds.size > 100) {
			const first = this.recentMessageIds.values().next().value;
			if (first) this.recentMessageIds.delete(first);
		}

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

		// Build message content — may be string (text only) or JSON ContentBlock[] (with images)
		const contentBlocks: ContentBlock[] = [];

		if (msg.content) {
			contentBlocks.push({ type: "text", text: msg.content });
		}

		// Use same timestamp for both file and message rows
		const now = new Date().toISOString();

		// Process image attachments
		if (msg.attachments?.values) {
			for (const attachment of msg.attachments.values()) {
				const contentType = attachment.contentType ?? "";
				if (!DISCORD_IMAGE_TYPES.has(contentType)) continue; // Skip non-image attachments

				const mediaType = contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

				// Enforce shared file size limit for synced storage
				if (attachment.size > MAX_FILE_STORAGE_BYTES) {
					this.logger.warn("[discord] Attachment exceeds size limit, skipping", {
						attachmentId: attachment.id,
						size: attachment.size,
						limit: MAX_FILE_STORAGE_BYTES,
					});
					continue;
				}

				try {
					const response = await fetch(attachment.url, {
						signal: AbortSignal.timeout(30_000),
					});
					if (!response.ok) {
						this.logger.warn("[discord] Failed to download attachment", {
							url: attachment.url,
							status: response.status,
						});
						continue;
					}
					const bytes = await response.bytes();
					const base64Data = Buffer.from(bytes).toString("base64");

					if (attachment.size >= ATTACHMENT_FILE_REF_THRESHOLD) {
						// Large attachment: store in files table and use file_ref source
						const fileId = randomUUID();
						insertRow(
							this.db,
							"files",
							{
								id: fileId,
								path: `discord-attachments/${attachment.id}/${attachment.name}`,
								content: base64Data,
								is_binary: 1,
								size_bytes: attachment.size,
								created_at: now,
								modified_at: now,
								host_origin: this.siteId,
								deleted: 0,
								created_by: user.id,
							},
							this.siteId,
						);
						contentBlocks.push({
							type: "image",
							source: { type: "file_ref", file_id: fileId },
							description: attachment.description ?? attachment.name,
						});
					} else {
						// Inline: embed as base64 directly in ContentBlock
						contentBlocks.push({
							type: "image",
							source: { type: "base64", media_type: mediaType, data: base64Data },
							description: attachment.description ?? attachment.name,
						});
					}
				} catch (err) {
					this.logger.warn("[discord] Error processing attachment, skipping", {
						attachmentId: attachment.id,
						error: String(err),
					});
				}
			}
		}

		// Determine the stored content format
		// - If no attachments were processed: store plain text (backward-compatible)
		// - If image blocks were added: store as JSON ContentBlock[]
		const hasImageBlocks = contentBlocks.some((b) => b.type === "image");
		const messageContent = hasImageBlocks ? JSON.stringify(contentBlocks) : msg.content;

		// Persist the incoming message via insertRow (AC6.2)
		const messageId = randomUUID();
		insertRow(
			this.db,
			"messages",
			{
				id: messageId,
				thread_id: thread.id,
				role: "user",
				content: messageContent,
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
		try {
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
					attachments: msg.attachments
						? Array.from(msg.attachments.values()).map((a) => ({
								filename: a.name,
								content_type: a.contentType ?? "application/octet-stream",
								size: a.size,
								url: a.url,
								description: a.description ?? undefined,
							}))
						: undefined,
				} satisfies IntakePayload),
				created_at: now,
				expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			});

			this.eventBus.emit("sync:trigger", { reason: "discord-intake" });
		} catch (err) {
			this.stopTyping(thread.id);
			this.logger.error("Failed to write intake relay to outbox", { error: String(err) });
		}
	}

	private startTyping(threadId: string, channel: { sendTyping(): Promise<void> }): void {
		this.stopTyping(threadId); // Clear any existing timer for this thread
		// Send immediately, then every 8s (Discord typing expires ~10s)
		channel.sendTyping().catch(() => {});
		const interval = setInterval(() => {
			channel.sendTyping().catch(() => {});
		}, 8_000);
		// Safety cap: stop after 5 minutes regardless
		const timeout = setTimeout(() => this.stopTyping(threadId), 5 * 60 * 1000);
		this.typingTimers.set(threadId, { interval, timeout });
	}

	private stopTyping(threadId: string): void {
		const handles = this.typingTimers.get(threadId);
		if (handles !== undefined) {
			clearInterval(handles.interval);
			clearTimeout(handles.timeout);
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

	private async getDMChannelForThread(threadId: string): Promise<{
		send(
			content:
				| string
				| {
						content?: string;
						files?: Array<{ attachment: Buffer; name: string }>;
				  },
		): Promise<unknown>;
	} | null> {
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

		const client = this.clientManager.getClient();
		const discordUser = await client.users.fetch(discordId);
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
