import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "@bound/shared";
import { DiscordClientManager } from "../connectors/discord-client-manager.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

describe("DiscordClientManager", () => {
	describe("getClient()", () => {
		it("should throw when not connected", () => {
			const logger = createMockLogger();
			const manager = new DiscordClientManager(logger);

			expect(() => {
				manager.getClient();
			}).toThrow("Discord client not connected");
		});

		it("should return client after manual injection (test setup)", () => {
			const logger = createMockLogger();
			const manager = new DiscordClientManager(logger);

			const mockClient = { user: { tag: "TestBot#0000" } };
			(manager as any).client = mockClient;

			const client = manager.getClient();
			expect(client).toBe(mockClient);
		});
	});

	describe("disconnect()", () => {
		it("should be no-op when already disconnected", async () => {
			const logger = createMockLogger();
			const manager = new DiscordClientManager(logger);

			// First disconnect should not throw
			await manager.disconnect();

			// Second disconnect should also not throw
			await manager.disconnect();
		});

		it("should call destroy() on the client", async () => {
			const logger = createMockLogger();
			const manager = new DiscordClientManager(logger);

			let destroyCalled = false;
			const mockClient = {
				destroy: () => {
					destroyCalled = true;
				},
			};
			(manager as any).client = mockClient;

			await manager.disconnect();

			expect(destroyCalled).toBe(true);
			expect(() => manager.getClient()).toThrow("Discord client not connected");
		});
	});

	describe("connect() idempotent behavior", () => {
		it("should log warning and return when already connected", async () => {
			const logger = createMockLogger();
			let warnCalled = false;
			logger.warn = () => {
				warnCalled = true;
			};

			const manager = new DiscordClientManager(logger);

			// Manually set client to simulate already connected state
			(manager as any).client = { test: "mock" };

			await manager.connect("test-token");

			expect(warnCalled).toBe(true);
		});
	});

	describe("AC5.1: Client constructor receives all required intents and partials", () => {
		it("should verify source code contains all 4 intents", () => {
			// Read source file to verify code contains intent references
			const sourceCode = readFileSync(
				resolve(__dirname, "../connectors/discord-client-manager.ts"),
				"utf-8",
			);

			// Verify the source code contains references to all 4 required intents
			expect(sourceCode).toContain("GatewayIntentBits.DirectMessages");
			expect(sourceCode).toContain("GatewayIntentBits.DirectMessageReactions");
			expect(sourceCode).toContain("GatewayIntentBits.MessageContent");
			expect(sourceCode).toContain("GatewayIntentBits.Guilds");

			// Verify they're all in an array (intents configuration)
			expect(sourceCode).toContain("intents: [");
		});

		it("should verify source code contains all 3 partials", () => {
			// Read source file to verify code contains partial references
			const sourceCode = readFileSync(
				resolve(__dirname, "../connectors/discord-client-manager.ts"),
				"utf-8",
			);

			// Verify the source code contains references to all 3 required partials
			expect(sourceCode).toContain("Partials.Channel");
			expect(sourceCode).toContain("Partials.Message");
			expect(sourceCode).toContain("Partials.Reaction");

			// Verify they're all in an array (partials configuration)
			expect(sourceCode).toContain("partials: [");
		});

		it("should verify client lifecycle methods exist and are callable", () => {
			// Verify the class has all required methods
			const logger = createMockLogger();
			const manager = new DiscordClientManager(logger);

			expect(typeof manager.connect).toBe("function");
			expect(typeof manager.disconnect).toBe("function");
			expect(typeof manager.getClient).toBe("function");
		});
	});
});
