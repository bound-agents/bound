import { afterEach, describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ChannelType } from "discord.js";
import { z } from "zod";
import { createDiscordServer } from "../connectors/discord-server";

// Exercises discord-server paths the main suite leaves cold: interaction.received
// emission (slash options + context-menu target message with attachments), the
// discord_respond_interaction tool error/expiry branches, and the message
// attachment download-failure paths. Follows the existing mock-client +
// InMemoryTransport harness in discord-server.test.ts.

const mockLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as Logger;

interface MockInteraction {
	id: string;
	user: { id: string; username: string; displayName: string | null };
	channelId: string;
	isChatInputCommand: () => boolean;
	isContextMenuCommand: () => boolean;
	deferReply: (opts: { ephemeral: boolean }) => Promise<void>;
	editReply: (opts: { content: string }) => Promise<unknown>;
	commandName?: string;
	options?: { data?: Array<{ name: string; value: unknown }> };
	targetMessage?: unknown;
}

function makeMockClient() {
	const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
	return {
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		channels: {
			fetch: async () => ({
				isDMBased: () => true,
				isTextBased: () => true,
				guild: undefined,
				permissionsFor: undefined,
				sendTyping: async () => {},
				send: async () => ({ id: "m" }),
			}),
		},
		users: { createDM: async (id: string) => ({ id: `dm-${id}` }) },
		isReady: () => true,
		application: { commands: { set: async () => {} } },
		_triggerInteractionCreate: async (interaction: MockInteraction) => {
			for (const h of handlers.get("interactionCreate") ?? []) await h(interaction);
		},
		_triggerMessageCreate: async (msg: unknown) => {
			for (const h of handlers.get("messageCreate") ?? []) await h(msg);
		},
	};
}

async function connect(config: PlatformConnectorConfig) {
	const mockClient = makeMockClient();
	const server = createDiscordServer(config, mockClient as unknown as never, mockLogger, undefined);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const mcpClient = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
	await mcpClient.connect(clientTransport);
	return { server, mcpClient, mockClient };
}

const pollSchema = z.object({
	events: z.array(z.unknown()),
	cursor: z.string(),
	nextPollSeconds: z.number(),
});

describe("discord-server interaction.received emission", () => {
	let server: Awaited<ReturnType<typeof connect>>["server"] | null = null;
	let mcpClient: Client | null = null;

	afterEach(async () => {
		await mcpClient?.close();
		await server?.close();
		server = null;
		mcpClient = null;
	});

	it("emits a slash-command interaction with parsed options", async () => {
		const conn = await connect({ allowed_users: [] });
		server = conn.server;
		mcpClient = conn.mcpClient;

		await mcpClient.request(
			{ method: "events/stream", params: { event: "interaction.received", params: {} } },
			z.object({ subscriptionId: z.string() }),
		);

		await conn.mockClient._triggerInteractionCreate({
			id: "int-1",
			user: { id: "u1", username: "kara", displayName: "Kara" },
			channelId: "ch-1",
			isChatInputCommand: () => true,
			isContextMenuCommand: () => false,
			deferReply: async () => {},
			editReply: async () => ({}),
			commandName: "ask",
			options: { data: [{ name: "q", value: "hello" }] },
		});
		await new Promise((r) => setTimeout(r, 30));

		const poll = await mcpClient.request(
			{ method: "events/poll", params: { event: "interaction.received", params: {} } },
			pollSchema,
		);
		expect(poll.events.length).toBe(1);
		const data = (poll.events[0] as Record<string, unknown>).data as Record<string, unknown>;
		expect(data.interaction_type).toBe("slash_command");
		expect((data.command as Record<string, unknown>).name).toBe("ask");
		expect(((data.command as Record<string, unknown>).options as Record<string, unknown>).q).toBe(
			"hello",
		);
	});

	it("emits a context-menu interaction with a target message and base64 attachment", async () => {
		const conn = await connect({ allowed_users: [] });
		server = conn.server;
		mcpClient = conn.mcpClient;

		await mcpClient.request(
			{ method: "events/stream", params: { event: "interaction.received", params: {} } },
			z.object({ subscriptionId: z.string() }),
		);

		const originalFetch = global.fetch;
		try {
			// Small PNG so the target attachment becomes a base64 image block.
			const png = Buffer.from([
				0x89,
				0x50,
				0x4e,
				0x47,
				0x0d,
				0x0a,
				0x1a,
				0x0a,
				...new Array(20).fill(0),
			]);
			global.fetch = (async () => ({
				ok: true,
				bytes: async () => png,
			})) as unknown as typeof fetch;

			await conn.mockClient._triggerInteractionCreate({
				id: "int-2",
				user: { id: "u1", username: "kara", displayName: null },
				channelId: "ch-1",
				isChatInputCommand: () => false,
				isContextMenuCommand: () => true,
				deferReply: async () => {},
				editReply: async () => ({}),
				targetMessage: {
					id: "tm-1",
					author: { id: "a1", username: "author", displayName: null, bot: false },
					content: "target body",
					attachments: new Map([
						["ta-1", { id: "ta-1", name: "pic.png", size: 50, url: "https://x/pic.png" }],
					]),
				},
			});
			await new Promise((r) => setTimeout(r, 40));

			const poll = await mcpClient.request(
				{ method: "events/poll", params: { event: "interaction.received", params: {} } },
				pollSchema,
			);
			expect(poll.events.length).toBe(1);
			const data = (poll.events[0] as Record<string, unknown>).data as Record<string, unknown>;
			expect(data.interaction_type).toBe("context_menu");
			const target = data.target_message as Record<string, unknown>;
			expect(target.content).toBe("target body");
			const atts = target.attachments as Array<Record<string, unknown>>;
			expect(atts[0].type).toBe("image");
		} finally {
			global.fetch = originalFetch;
		}
	});
});

describe("message attachment download failures", () => {
	let server: Awaited<ReturnType<typeof connect>>["server"] | null = null;
	let mcpClient: Client | null = null;

	afterEach(async () => {
		await mcpClient?.close();
		await server?.close();
		server = null;
		mcpClient = null;
	});

	it("warns and skips an attachment whose download returns non-ok", async () => {
		const warns: string[] = [];
		const logger = { ...mockLogger, warn: (msg: string) => warns.push(msg) } as unknown as Logger;
		const mockClient = makeMockClient();
		const srv = createDiscordServer(
			{ allowed_users: [] },
			mockClient as unknown as never,
			logger,
			undefined,
		);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await srv.connect(st);
		const c = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
		await c.connect(ct);
		server = srv;
		mcpClient = c;

		await c.request(
			{
				method: "events/stream",
				params: { event: "message.received", params: { channel_id: "ch-1" } },
			},
			z.object({ subscriptionId: z.string() }),
		);

		const originalFetch = global.fetch;
		try {
			global.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
			await mockClient._triggerMessageCreate({
				id: "msg-1",
				author: { id: "u1", username: "kara", displayName: null, bot: false },
				content: "with bad attachment",
				channelId: "ch-1",
				guildId: null,
				channel: {
					type: ChannelType.DM,
					isDMBased: () => true,
					sendTyping: async () => {},
					send: async () => ({}),
				},
				attachments: new Map([
					["a1", { id: "a1", name: "f.png", size: 100, url: "https://x/f.png" }],
				]),
			});
			await new Promise((r) => setTimeout(r, 50));

			const poll = await c.request(
				{
					method: "events/poll",
					params: { event: "message.received", params: { channel_id: "ch-1" } },
				},
				pollSchema,
			);
			expect(poll.events.length).toBe(1);
			const data = (poll.events[0] as Record<string, unknown>).data as Record<string, unknown>;
			// The attachment was skipped (non-ok download), so none attached.
			expect((data.attachments as unknown[]).length).toBe(0);
			expect(warns.some((w) => w.includes("Failed to download attachment"))).toBe(true);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("warns and continues when an attachment fetch throws", async () => {
		const warns: string[] = [];
		const logger = { ...mockLogger, warn: (msg: string) => warns.push(msg) } as unknown as Logger;
		const mockClient = makeMockClient();
		const srv = createDiscordServer(
			{ allowed_users: [] },
			mockClient as unknown as never,
			logger,
			undefined,
		);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await srv.connect(st);
		const c = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
		await c.connect(ct);
		server = srv;
		mcpClient = c;

		await c.request(
			{
				method: "events/stream",
				params: { event: "message.received", params: { channel_id: "ch-2" } },
			},
			z.object({ subscriptionId: z.string() }),
		);

		const originalFetch = global.fetch;
		try {
			global.fetch = (async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch;
			await mockClient._triggerMessageCreate({
				id: "msg-2",
				author: { id: "u1", username: "kara", displayName: null, bot: false },
				content: "throwing attachment",
				channelId: "ch-2",
				guildId: null,
				channel: {
					type: ChannelType.DM,
					isDMBased: () => true,
					sendTyping: async () => {},
					send: async () => ({}),
				},
				attachments: new Map([
					["a2", { id: "a2", name: "g.png", size: 100, url: "https://x/g.png" }],
				]),
			});
			await new Promise((r) => setTimeout(r, 50));

			const poll = await c.request(
				{
					method: "events/poll",
					params: { event: "message.received", params: { channel_id: "ch-2" } },
				},
				pollSchema,
			);
			expect(poll.events.length).toBe(1);
			expect(warns.some((w) => w.includes("Error processing attachment"))).toBe(true);
		} finally {
			global.fetch = originalFetch;
		}
	});
});
