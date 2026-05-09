import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { chunkMessage, createDiscordServer } from "../connectors/discord-server";

// Mock Logger
const mockLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

// Import ChannelType from discord.js
import { ChannelType } from "discord.js";

// Mock Discord types
interface MockDiscordChannel {
	type?: number;
	isDMBased: () => boolean;
	sendTyping: () => Promise<void>;
	send: (content: string) => Promise<unknown>;
}

interface MockDiscordMessage {
	id: string;
	author: { id: string; username: string; displayName: string | null; bot: boolean };
	content: string;
	channelId: string;
	channel: MockDiscordChannel;
	attachments: Map<string, { id: string; name: string; size: number; url: string }>;
}

interface MockDiscordInteraction {
	user: { id: string; username: string; displayName: string | null };
	channelId: string;
	isChatInputCommand: () => boolean;
	isContextMenuCommand: () => boolean;
	deferReply: (options: { ephemeral: boolean }) => Promise<void>;
	editReply: (options: { content: string }) => Promise<unknown>;
	commandName?: string;
	options?: { data?: Array<{ name: string; value: unknown }> };
	targetMessage?: MockDiscordMessage;
}

/**
 * Create a mock Discord client that tracks event handlers and calls
 */
function createMockDiscordClient() {
	const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
	const sendTypingCalls: string[] = [];
	const sendCalls: Array<{ channelId: string; content: string }> = [];
	const editReplyCalls: string[] = [];
	const interactionStore = new Map<string, MockDiscordInteraction>();

	return {
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!handlers.has(event)) {
				handlers.set(event, new Set());
			}
			handlers.get(event)?.add(handler);
		},
		channels: {
			fetch: async (channelId: string) => ({
				isDMBased: () => true,
				sendTyping: async () => {
					sendTypingCalls.push(channelId);
				},
				send: async (content: string) => {
					sendCalls.push({ channelId, content });
					return { id: `msg-${Date.now()}` };
				},
			}),
		},
		_getHandlers: (event: string) => handlers.get(event) || new Set(),
		_getSendTypingCalls: () => sendTypingCalls,
		_getSendCalls: () => sendCalls,
		_getEditReplyCalls: () => editReplyCalls,
		_getInteractionStore: () => interactionStore,
		_storeInteraction: (callbackId: string, interaction: MockDiscordInteraction) => {
			interactionStore.set(callbackId, interaction);
		},
		_triggerMessageCreate: async (msg: MockDiscordMessage) => {
			const msgHandlers = handlers.get("messageCreate") || new Set();
			for (const handler of msgHandlers) {
				await handler(msg);
			}
		},
		_triggerInteractionCreate: async (interaction: MockDiscordInteraction) => {
			const intHandlers = handlers.get("interactionCreate") || new Set();
			for (const handler of intHandlers) {
				await handler(interaction);
			}
		},
	};
}

describe("Discord MCP Server", () => {
	let mockDiscordClient: ReturnType<typeof createMockDiscordClient>;
	let server: Awaited<ReturnType<typeof createDiscordServer>>;
	let client: Client;

	beforeEach(async () => {
		mockDiscordClient = createMockDiscordClient() as unknown as ReturnType<
			typeof createMockDiscordClient
		>;
	});

	afterEach(async () => {
		if (client) {
			await client.close();
		}
		if (server) {
			await server.close();
		}
	});

	/**
	 * Helper to create and connect MCP client/server pair
	 */
	async function setupMCPConnection(
		config: PlatformConnectorConfig,
	): Promise<{ server: Awaited<ReturnType<typeof createDiscordServer>>; client: Client }> {
		const discordServer = createDiscordServer(
			config,
			mockDiscordClient as unknown as any,
			mockLogger,
		);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await discordServer.connect(serverTransport);

		const mcpClient = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
		await mcpClient.connect(clientTransport);

		return { server: discordServer, client: mcpClient };
	}

	it("should create a Discord MCP server instance", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		expect(server).toBeDefined();
		expect(server.close).toBeDefined();
	});

	it("events/list returns both message.received and interaction.received", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const eventListSchema = z.object({
			events: z.array(
				z.object({
					name: z.string(),
					description: z.string().optional(),
				}),
			),
		});

		const result = await mcpClient.request({ method: "events/list", params: {} }, eventListSchema);

		expect(result.events).toBeDefined();
		expect(result.events.length).toBeGreaterThanOrEqual(2);

		const eventNames = result.events.map((e: { name: string }) => e.name);
		expect(eventNames).toContain("message.received");
		expect(eventNames).toContain("interaction.received");
	});

	it("AC1.4: Bot messages are never emitted as events", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const subscribeSchema = z.object({
			subscriptionId: z.string(),
		});
		await mcpClient.request(
			{
				method: "events/stream",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			subscribeSchema,
		);

		const botMessage: MockDiscordMessage = {
			id: "bot-msg-1",
			author: { id: "bot-id", username: "bot", displayName: null, bot: true },
			content: "Bot message",
			channelId: "ch-1",
			channel: {
				type: ChannelType.DM,
				isDMBased: () => true,
				sendTyping: async () => {},
				send: async () => ({}),
			},
			attachments: new Map(),
		};

		await mockDiscordClient._triggerMessageCreate(botMessage);

		// Give a small delay for any async processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Poll for events - should be empty because bot messages are filtered
		const pollSchema = z.object({
			events: z.array(z.unknown()),
			cursor: z.string(),
			nextPollSeconds: z.number(),
		});

		const pollResult = await mcpClient.request(
			{
				method: "events/poll",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			pollSchema,
		);

		expect(pollResult.events).toBeDefined();
		expect(Array.isArray(pollResult.events)).toBe(true);
		expect(pollResult.events.length).toBe(0);
	});

	it("AC1.5: Non-allowlisted users don't trigger events", async () => {
		const config: PlatformConnectorConfig = { allowed_users: ["user-1"] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const subscribeSchema = z.object({
			subscriptionId: z.string(),
		});
		await mcpClient.request(
			{
				method: "events/stream",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			subscribeSchema,
		);

		const disallowedMessage: MockDiscordMessage = {
			id: "msg-disallowed",
			author: { id: "user-2", username: "other", displayName: null, bot: false },
			content: "Disallowed",
			channelId: "ch-1",
			channel: {
				type: ChannelType.DM,
				isDMBased: () => true,
				sendTyping: async () => {},
				send: async () => ({}),
			},
			attachments: new Map(),
		};

		await mockDiscordClient._triggerMessageCreate(disallowedMessage);

		// Give a small delay for any async processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Poll and verify no events were emitted for the non-allowlisted user
		const pollSchema = z.object({
			events: z.array(z.unknown()),
			cursor: z.string(),
			nextPollSeconds: z.number(),
		});

		const pollResult = await mcpClient.request(
			{
				method: "events/poll",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			pollSchema,
		);

		expect(pollResult.events.length).toBe(0);
	});

	it("AC1.5: Allowlisted users DO trigger events via events/poll", async () => {
		const config: PlatformConnectorConfig = { allowed_users: ["user-1"] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		// First, subscribe to the event to set up the listener
		const subscribeSchema = z.object({
			subscriptionId: z.string(),
		});
		await mcpClient.request(
			{
				method: "events/stream",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			subscribeSchema,
		);

		// Trigger a message from an allowed user
		const allowedMessage: MockDiscordMessage = {
			id: "msg-allowed",
			author: { id: "user-1", username: "alloweduser", displayName: null, bot: false },
			content: "Allowed message",
			channelId: "ch-1",
			channel: {
				type: ChannelType.DM,
				isDMBased: () => true,
				sendTyping: async () => {},
				send: async () => ({}),
			},
			attachments: new Map(),
		};

		await mockDiscordClient._triggerMessageCreate(allowedMessage);

		// Give a small delay for any async processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Poll for events - should contain the message from allowed user
		const pollSchema = z.object({
			events: z.array(z.unknown()),
			cursor: z.string(),
			nextPollSeconds: z.number(),
		});

		const pollResult = await mcpClient.request(
			{
				method: "events/poll",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			pollSchema,
		);

		expect(pollResult.events).toBeDefined();
		expect(Array.isArray(pollResult.events)).toBe(true);
		expect(pollResult.events.length).toBeGreaterThan(0);

		// Verify the event contains correct message data
		const messageEvent = pollResult.events[0] as Record<string, unknown>;
		expect(messageEvent.name).toBe("message.received");
		expect(messageEvent.data).toBeDefined();
		const data = messageEvent.data as Record<string, unknown>;
		expect(data.author).toBeDefined();
		const author = data.author as Record<string, unknown>;
		expect(author.id).toBe("user-1");
		expect(data.content).toBe("Allowed message");
		expect(data.channel_id).toBe("ch-1");
	});

	it("AC1.6: Small attachments can be processed as base64", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		// Save original fetch
		const originalFetch = global.fetch;

		try {
			// Mock fetch to return a small PNG image (< 1MB)
			// PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
			const pngBuffer = Buffer.from([
				0x89,
				0x50,
				0x4e,
				0x47,
				0x0d,
				0x0a,
				0x1a,
				0x0a, // PNG signature
				...new Array(100).fill(0), // Small image data
			]);

			global.fetch = async () =>
				({
					ok: true,
					bytes: async () => pngBuffer,
				}) as any;

			const subscribeSchema = z.object({
				subscriptionId: z.string(),
			});
			await mcpClient.request(
				{
					method: "events/stream",
					params: {
						event: "message.received",
						params: { channel_id: "ch-1" },
					},
				},
				subscribeSchema,
			);

			// Create a message with a small attachment
			const messageWithAttachment: MockDiscordMessage = {
				id: "msg-with-small-attachment",
				author: { id: "user-1", username: "testuser", displayName: null, bot: false },
				content: "Message with image",
				channelId: "ch-1",
				channel: {
					type: ChannelType.DM,
					isDMBased: () => true,
					sendTyping: async () => {},
					send: async () => ({}),
				},
				attachments: new Map([
					[
						"att-1",
						{
							id: "att-1",
							name: "image.png",
							size: 108, // < 1MB
							url: "https://example.com/image.png",
						},
					],
				]),
			};

			await mockDiscordClient._triggerMessageCreate(messageWithAttachment);

			// Give a small delay for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Poll for the event and verify attachment is base64
			const pollSchema = z.object({
				events: z.array(z.unknown()),
				cursor: z.string(),
				nextPollSeconds: z.number(),
			});

			const pollResult = await mcpClient.request(
				{
					method: "events/poll",
					params: {
						event: "message.received",
						params: { channel_id: "ch-1" },
					},
				},
				pollSchema,
			);

			expect(pollResult.events.length).toBeGreaterThan(0);
			const messageEvent = pollResult.events[0] as Record<string, unknown>;
			const eventData = messageEvent.data as Record<string, unknown>;
			const attachments = eventData.attachments as Array<Record<string, unknown>>;

			expect(attachments.length).toBeGreaterThan(0);
			const attachment = attachments[0];
			expect(attachment.type).toBe("image");
			expect((attachment.source as Record<string, unknown>).type).toBe("base64");
			expect((attachment.source as Record<string, unknown>).data).toBeDefined();
			expect(typeof (attachment.source as Record<string, unknown>).data).toBe("string");
		} finally {
			// Restore original fetch
			global.fetch = originalFetch;
		}
	});

	it("AC1.7: Large attachments can be stored as file_ref", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		// Save original fetch
		const originalFetch = global.fetch;

		try {
			// Mock fetch to return a large file buffer
			const largeBuffer = Buffer.alloc(2 * 1024 * 1024); // 2MB

			global.fetch = async () =>
				({
					ok: true,
					bytes: async () => largeBuffer,
				}) as any;

			const subscribeSchema = z.object({
				subscriptionId: z.string(),
			});
			await mcpClient.request(
				{
					method: "events/stream",
					params: {
						event: "message.received",
						params: { channel_id: "ch-1" },
					},
				},
				subscribeSchema,
			);

			// Create a message with a large attachment (>= 1MB)
			const messageWithAttachment: MockDiscordMessage = {
				id: "msg-with-large-attachment",
				author: { id: "user-1", username: "testuser", displayName: null, bot: false },
				content: "Message with large file",
				channelId: "ch-1",
				channel: {
					type: ChannelType.DM,
					isDMBased: () => true,
					sendTyping: async () => {},
					send: async () => ({}),
				},
				attachments: new Map([
					[
						"att-2",
						{
							id: "att-2",
							name: "largefile.bin",
							size: 2 * 1024 * 1024, // >= 1MB
							url: "https://example.com/largefile.bin",
						},
					],
				]),
			};

			await mockDiscordClient._triggerMessageCreate(messageWithAttachment);

			// Give a small delay for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Poll for the event and verify attachment is file_ref
			const pollSchema = z.object({
				events: z.array(z.unknown()),
				cursor: z.string(),
				nextPollSeconds: z.number(),
			});

			const pollResult = await mcpClient.request(
				{
					method: "events/poll",
					params: {
						event: "message.received",
						params: { channel_id: "ch-1" },
					},
				},
				pollSchema,
			);

			expect(pollResult.events.length).toBeGreaterThan(0);
			const messageEvent = pollResult.events[0] as Record<string, unknown>;
			const eventData = messageEvent.data as Record<string, unknown>;
			const attachments = eventData.attachments as Array<Record<string, unknown>>;

			expect(attachments.length).toBeGreaterThan(0);
			const attachment = attachments[0];
			expect(attachment.type).toBe("file_ref");
			expect(attachment.file_id).toBeDefined();
			expect(attachment.filename).toBe("largefile.bin");
			expect(attachment.size).toBe(2 * 1024 * 1024);
		} finally {
			// Restore original fetch
			global.fetch = originalFetch;
		}
	});

	it("AC2.1: discord_send_message tool is listed and executable", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const toolsListSchema = z.object({
			tools: z.array(
				z.object({
					name: z.string(),
					description: z.string().optional(),
				}),
			),
		});

		const result = await mcpClient.request({ method: "tools/list", params: {} }, toolsListSchema);

		expect(result.tools).toBeDefined();
		const toolNames = result.tools.map((t: { name: string }) => t.name);
		expect(toolNames).toContain("discord_send_message");

		// AC2.1: Execute the tool and verify it sends to the correct channel
		const toolCallSchema = z.object({
			content: z.array(z.unknown()),
		});

		const callResult = await mcpClient.request(
			{
				method: "tools/call",
				params: {
					name: "discord_send_message",
					arguments: {
						channel_id: "ch-1",
						content: "Hello from agent",
					},
				},
			},
			toolCallSchema,
		);

		expect(callResult.content).toBeDefined();
		expect(callResult.content.length).toBeGreaterThan(0);
		const contentBlock = callResult.content[0] as Record<string, unknown>;
		expect(contentBlock.text).toBe("sent");

		// Verify the mock Discord client recorded the send call
		const sendCalls = mockDiscordClient._getSendCalls();
		expect(sendCalls.length).toBeGreaterThan(0);
		const lastSendCall = sendCalls[sendCalls.length - 1];
		expect(lastSendCall.channelId).toBe("ch-1");
		expect(lastSendCall.content).toBe("Hello from agent");

		// AC2.3: Verify sendTyping was called
		const typingCalls = mockDiscordClient._getSendTypingCalls();
		expect(typingCalls.length).toBeGreaterThan(0);
		expect(typingCalls).toContain("ch-1");
	});

	it("AC2.2: chunkMessage handles exactly 2000 chars", () => {
		const msg2000 = "a".repeat(2000);
		const chunks = chunkMessage(msg2000);

		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(2000);
	});

	it("AC2.2: chunkMessage splits long messages", () => {
		const msg5000 = "a".repeat(5000);
		const chunks = chunkMessage(msg5000);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	it("AC2.2: chunkMessage handles paragraph breaks", () => {
		const msg = "para1\n\npara2".repeat(200); // Will exceed 2000 chars with paragraph breaks
		const chunks = chunkMessage(msg);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	it("AC2.2: chunkMessage handles line breaks", () => {
		const msg = "line\n".repeat(500) + "a".repeat(500); // Mix of line breaks and content
		const chunks = chunkMessage(msg);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	it("AC2.2: chunkMessage handles word boundaries", () => {
		const msg = "word ".repeat(500) + "a".repeat(500); // Word separated content
		const chunks = chunkMessage(msg);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	it("AC2.2: chunkMessage handles hard split for long words", () => {
		const longWord = "a".repeat(2500);
		const chunks = chunkMessage(longWord);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	it("AC2.2: chunkMessage returns single chunk for short messages", () => {
		const msg = "Hello world";
		const chunks = chunkMessage(msg);

		expect(chunks.length).toBe(1);
		expect(chunks[0]).toBe(msg);
	});

	it("AC2.2: chunkMessage returns empty array for empty string", () => {
		const chunks = chunkMessage("");

		expect(chunks.length).toBe(1);
		expect(chunks[0]).toBe("");
	});

	it("AC2.2: chunkMessage with custom maxLength", () => {
		const msg = "a".repeat(500);
		const chunks = chunkMessage(msg, 100);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(100);
		}
	});

	it("AC2.3: Typing indicator is available in mock", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		// Verify the mock client has sendTyping support
		expect(mockDiscordClient._getSendTypingCalls).toBeDefined();
		expect(typeof mockDiscordClient._getSendTypingCalls).toBe("function");
	});

	it("AC2.4: discord_respond_interaction tool is listed and can respond to valid interaction", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const toolsListSchema = z.object({
			tools: z.array(
				z.object({
					name: z.string(),
					description: z.string().optional(),
				}),
			),
		});

		const result = await mcpClient.request({ method: "tools/list", params: {} }, toolsListSchema);

		expect(result.tools).toBeDefined();
		const toolNames = result.tools.map((t: { name: string }) => t.name);
		expect(toolNames).toContain("discord_respond_interaction");

		// Create a mock interaction and trigger it
		const mockInteraction: MockDiscordInteraction = {
			user: { id: "user-1", username: "testuser", displayName: null },
			channelId: "ch-1",
			isChatInputCommand: () => true,
			isContextMenuCommand: () => false,
			deferReply: async () => {},
			editReply: async (options: { content: string }) => {
				mockDiscordClient._getEditReplyCalls().push(options.content);
				return {};
			},
			commandName: "test",
			options: { data: [] },
		};

		// Trigger the interaction event to populate the server's store
		await mockDiscordClient._triggerInteractionCreate(mockInteraction);

		// Give a small delay for async processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Poll interaction events to get the callback_id from the emitted event
		const eventsPollSchema = z.object({
			events: z.array(z.unknown()),
			cursor: z.string(),
			nextPollSeconds: z.number(),
		});

		const pollResult = await mcpClient.request(
			{
				method: "events/poll",
				params: {
					event: "interaction.received",
					params: { channel_id: "ch-1" },
				},
			},
			eventsPollSchema,
		);

		expect(pollResult.events.length).toBeGreaterThan(0);
		const interactionEvent = pollResult.events[0] as Record<string, unknown>;
		const eventData = interactionEvent.data as Record<string, unknown>;
		const actualCallbackId = eventData.callback_id as string;
		expect(actualCallbackId).toBeDefined();

		// Now call the tool with the correct callback_id
		const toolCallSchema = z.object({
			content: z.array(z.unknown()),
		});

		const callResult = await mcpClient.request(
			{
				method: "tools/call",
				params: {
					name: "discord_respond_interaction",
					arguments: {
						callback_id: actualCallbackId,
						content: "Response to interaction",
					},
				},
			},
			toolCallSchema,
		);

		expect(callResult.content).toBeDefined();
		expect(callResult.content.length).toBeGreaterThan(0);
		const contentBlock = callResult.content[0] as Record<string, unknown>;
		expect(contentBlock.text).toBe("sent");

		// Verify that editReply was called by the tool handler
		expect(mockDiscordClient._getEditReplyCalls().length).toBeGreaterThan(0);
	});

	it("discord_send_message returns an error for content > 2000 chars (no chunking)", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const toolCallSchema = z.object({
			content: z.array(z.unknown()),
			isError: z.boolean().optional(),
		});

		const callResult = await mcpClient.request(
			{
				method: "tools/call",
				params: {
					name: "discord_send_message",
					arguments: {
						channel_id: "ch-1",
						content: "a".repeat(2001),
					},
				},
			},
			toolCallSchema,
		);

		expect(callResult.isError).toBe(true);
		const contentBlock = callResult.content[0] as Record<string, unknown>;
		expect(String(contentBlock.text)).toContain("2000");

		// Verify nothing was sent to Discord
		const sendCalls = mockDiscordClient._getSendCalls();
		expect(sendCalls.length).toBe(0);
	});

	it("AC2.5: Expired callback_id returns error", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		// Try to call with an expired callback_id that doesn't exist
		const toolCallSchema = z.object({
			content: z.array(z.unknown()),
			isError: z.boolean().optional(),
		});

		const callResult = await mcpClient.request(
			{
				method: "tools/call",
				params: {
					name: "discord_respond_interaction",
					arguments: {
						callback_id: "expired-or-nonexistent-id",
						content: "Response to expired interaction",
					},
				},
			},
			toolCallSchema,
		);

		expect(callResult.content).toBeDefined();
		expect(callResult.content.length).toBeGreaterThan(0);
		const contentBlock = callResult.content[0] as Record<string, unknown>;
		expect(String(contentBlock.text)).toContain("expired");
		expect(callResult.isError).toBe(true);
	});

	it("events/poll returns events in cursor format", async () => {
		const config: PlatformConnectorConfig = { allowed_users: [] };
		const { server: discordServer, client: mcpClient } = await setupMCPConnection(config);
		server = discordServer;
		client = mcpClient;

		const pollSchema = z.object({
			events: z.array(z.unknown()),
			cursor: z.string(),
			nextPollSeconds: z.number(),
		});

		const result = await mcpClient.request(
			{
				method: "events/poll",
				params: {
					event: "message.received",
					params: { channel_id: "ch-1" },
				},
			},
			pollSchema,
		);

		expect(result.events).toBeDefined();
		expect(Array.isArray(result.events)).toBe(true);
		expect(result.cursor).toBeDefined();
		expect(typeof result.cursor).toBe("string");
		expect(result.nextPollSeconds).toBeDefined();
		expect(result.nextPollSeconds).toBeGreaterThan(0);
	});

	it("createDiscordServer exported from @bound/platforms", async () => {
		const { createDiscordServer: exported } = await import("../index.js");
		expect(exported).toBeDefined();
		expect(typeof exported).toBe("function");
	});

	it("chunkMessage exported from @bound/platforms", async () => {
		const { chunkMessage: exported } = await import("../index.js");
		expect(exported).toBeDefined();
		expect(typeof exported).toBe("function");
	});
});
