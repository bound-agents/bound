import { randomUUID } from "node:crypto";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import { formatError } from "@bound/shared";
import type { Database } from "bun:sqlite";
import type { Client } from "discord.js";
import { ChannelType, GatewayIntentBits, Partials } from "discord.js";
import { isAllowlisted } from "./allowlist";
import { findOrCreateThread, mapDiscordUser } from "./thread-mapping";

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
	"application/xhtml+xml",
	"application/x-yaml",
	"application/x-sh",
	"application/graphql",
]);

function isTextMime(mimeType: string): boolean {
	const base = mimeType.split(";")[0].trim().toLowerCase();
	return TEXT_MIME_PREFIXES.some((p) => base.startsWith(p)) || TEXT_MIME_EXACT.has(base);
}

export interface DiscordAttachment {
	name: string;
	contentType: string;
	url: string;
	size: number;
}

/**
 * Download Discord attachments, store them in the files table, and append
 * their content (or metadata for binary files) to the message text.
 * Extracted for testability; `fetcher` is injectable.
 */
export async function buildAttachmentContent(
	textContent: string,
	attachments: DiscordAttachment[],
	db: Database,
	siteId: string,
	hostOrigin: string,
	fetcher: (url: string) => Promise<ArrayBuffer> = async (url) => {
		const res = await fetch(url);
		return res.arrayBuffer();
	},
): Promise<string> {
	let content = textContent;

	for (const att of attachments) {
		try {
			const data = await fetcher(att.url);
			const binary = !isTextMime(att.contentType);
			const fileContent = binary
				? Buffer.from(data).toString("base64")
				: new TextDecoder().decode(data);
			const now = new Date().toISOString();

			insertRow(
				db,
				"files",
				{
					id: randomUUID(),
					path: `/home/user/uploads/discord/${att.name}`,
					content: fileContent,
					is_binary: binary ? 1 : 0,
					size_bytes: data.byteLength,
					created_at: now,
					modified_at: now,
					deleted: 0,
					created_by: "discord",
					host_origin: hostOrigin,
				},
				siteId,
			);

			if (binary) {
				content += `\n\n[Attached file: ${att.name} (binary, ${att.size} bytes)]`;
			} else {
				content += `\n\n[Attached file: ${att.name}]\n${new TextDecoder().decode(data)}`;
			}
		} catch (err) {
			// Non-fatal: note the attachment even if download failed
			content += `\n\n[Attached file: ${att.name} — download failed: ${formatError(err)}]`;
		}
	}

	return content;
}

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
				console.log(
					`[discord] User mapping failed for ${msg.author.id} — check discord_id in allowlist.json`,
				);
				return;
			}

			const thread = findOrCreateThread(this.ctx.db, user.id, this.ctx.siteId);
			console.log(`[discord] DM from ${msg.author.tag}: thread=${thread.id.slice(0, 8)}`);

			// Build message content including any attachments
			const attachments: DiscordAttachment[] = msg.attachments.map((a) => ({
				name: a.name ?? "attachment",
				contentType: a.contentType ?? "application/octet-stream",
				url: a.url,
				size: a.size,
			}));
			const content = await buildAttachmentContent(
				msg.content,
				attachments,
				this.ctx.db,
				this.ctx.siteId,
				this.ctx.hostName,
			);

			insertRow(
				this.ctx.db,
				"messages",
				{
					id: randomUUID(),
					thread_id: thread.id,
					role: "user",
					content,
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
					.query(
						"SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
					)
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
				.query(
					"SELECT id FROM threads WHERE user_id = ? AND interface = 'discord' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
				)
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
 * Returns true only if platforms.json exists and its host field matches this machine's hostname.
 */
export function shouldActivate(ctx: AppContext): boolean {
	const platformsConfig = ctx.optionalConfig.platforms;
	if (!platformsConfig || !platformsConfig.ok) return false;
	// For now, check if Discord connector is configured
	// TODO(Phase 6): This entire file will be deleted
	const config = platformsConfig.value as unknown as { connectors?: Array<{ platform: string }> };
	const connectors = config.connectors || [];
	const discordConnector = connectors.find((c) => c.platform === "discord");
	return !!discordConnector;
}
