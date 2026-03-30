import { describe, expect, it } from "bun:test";
import {
	allowlistSchema,
	configSchemaMap,
	cronSchedulesSchema,
	keyringSchema,
	mcpSchema,
	modelBackendsSchema,
	networkSchema,
	overlaySchema,
	platformsSchema,
	syncSchema,
	userEntrySchema,
} from "../config-schemas.js";
import { RELAY_REQUEST_KINDS } from "../types.js";

describe("Config schemas", () => {
	describe("allowlistSchema", () => {
		it("validates correct allowlist config", () => {
			const config = {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice", platforms: { discord: "123456" } },
					bob: { display_name: "Bob" },
				},
			};
			const result = allowlistSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects empty users object", () => {
			const config = {
				default_web_user: "alice",
				users: {},
			};
			const result = allowlistSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects when default_web_user references undefined user", () => {
			const config = {
				default_web_user: "nonexistent",
				users: {
					alice: { display_name: "Alice" },
				},
			};
			const result = allowlistSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("requires display_name for users", () => {
			const config = {
				default_web_user: "alice",
				users: {
					alice: { platforms: { discord: "123456" } },
				},
			};
			const result = allowlistSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("modelBackendsSchema", () => {
		it("validates correct model backends config", () => {
			const config = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
						model: "llama2",
						base_url: "http://localhost:11434",
						context_window: 4096,
						tier: 1,
					},
				],
				default: "ollama-local",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects empty backends array with non-empty default", () => {
			const config = {
				backends: [],
				default: "some-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("accepts empty backends for hub-only mode (no local inference)", () => {
			// A hub that relays inference to spokes needs no local backends.
			const config = {
				backends: [],
				default: "",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects when default references undefined backend", () => {
			const config = {
				backends: [
					{
						id: "backend1",
						provider: "ollama",
						model: "llama2",
						base_url: "http://localhost:11434",
						context_window: 4096,
						tier: 1,
					},
				],
				default: "nonexistent-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("requires base_url for ollama provider", () => {
			const config = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
						model: "llama2",
						context_window: 4096,
						tier: 1,
					},
				],
				default: "ollama-local",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("requires base_url for openai-compatible provider", () => {
			const config = {
				backends: [
					{
						id: "openai-compat",
						provider: "openai-compatible",
						model: "gpt-4",
						context_window: 8192,
						tier: 3,
					},
				],
				default: "openai-compat",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects negative context_window", () => {
			const config = {
				backends: [
					{
						id: "bad-backend",
						provider: "anthropic",
						model: "claude-3",
						context_window: -1,
						tier: 3,
					},
				],
				default: "bad-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects tier outside 1-5 range", () => {
			const config = {
				backends: [
					{
						id: "bad-tier",
						provider: "anthropic",
						model: "claude-3",
						context_window: 200000,
						tier: 6,
					},
				],
				default: "bad-tier",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("networkSchema", () => {
		it("validates correct network config", () => {
			const config = {
				allowedUrlPrefixes: ["https://api.example.com", "https://data.example.com"],
				allowedMethods: ["GET", "POST"],
			};
			const result = networkSchema.safeParse(config);
			expect(result.success).toBe(true);
		});
	});

	describe("platformsSchema", () => {
		it("validates correct platforms config", () => {
			const config = {
				connectors: [
					{
						platform: "discord",
						token: "Bot.MyToken",
						leadership: "auto",
					},
				],
			};
			const result = platformsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires at least one connector", () => {
			const config = {
				connectors: [],
			};
			const result = platformsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects invalid leadership value", () => {
			const config = {
				connectors: [
					{
						platform: "discord",
						token: "Bot.MyToken",
						leadership: "invalid",
					},
				],
			};
			const result = platformsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("syncSchema", () => {
		it("validates correct sync config", () => {
			const config = {
				hub: "https://hub.example.com",
				sync_interval_seconds: 60,
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("uses default sync_interval_seconds if not provided", () => {
			const config = {
				hub: "https://hub.example.com",
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.sync_interval_seconds).toBe(30);
			}
		});

		it("rejects non-positive sync_interval_seconds", () => {
			const config = {
				hub: "https://hub.example.com",
				sync_interval_seconds: 0,
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("keyringSchema", () => {
		it("validates correct keyring config", () => {
			const config = {
				hosts: {
					host1: {
						public_key: "key123",
						url: "https://host1.example.com",
					},
					host2: {
						public_key: "key456",
						url: "https://host2.example.com",
					},
				},
			};
			const result = keyringSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires valid URLs", () => {
			const config = {
				hosts: {
					host1: {
						public_key: "key123",
						url: "not-a-url",
					},
				},
			};
			const result = keyringSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("mcpSchema", () => {
		it("validates correct mcp config", () => {
			const config = {
				servers: [
					{
						name: "filesystem",
						command: "node",
						args: ["mcp-server.js"],
						transport: "stdio",
					},
					{
						name: "web",
						url: "https://mcp.example.com",
						transport: "http",
						allow_tools: ["fetch", "search"],
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires valid transport enum", () => {
			const config = {
				servers: [
					{
						name: "test",
						transport: "invalid",
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});

	describe("overlaySchema", () => {
		it("validates correct overlay config", () => {
			const config = {
				mounts: {
					"/real/path": "/mount/path",
					"/another/real": "/another/mount",
				},
			};
			const result = overlaySchema.safeParse(config);
			expect(result.success).toBe(true);
		});
	});

	describe("cronSchedulesSchema", () => {
		it("validates correct cron schedules config", () => {
			const config = {
				daily_summary: {
					schedule: "0 9 * * *",
					thread: "summary-thread",
					payload: "daily",
				},
				hourly_check: {
					schedule: "0 * * * *",
					requires: ["initialize"],
					model_hint: "fast",
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires schedule field", () => {
			const config = {
				task: {
					thread: "some-thread",
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(false);
		});
	});
});

describe("platform-connectors Phase 1 config schema validation", () => {
	// AC1.6: discord_id in allowlist.json entry must fail with helpful message
	it("AC1.6: userEntrySchema rejects discord_id with message referencing platforms.discord", () => {
		const result = userEntrySchema.safeParse({
			display_name: "Alice",
			discord_id: "12345",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages.some((m) => m.includes("platforms.discord"))).toBe(true);
		}
	});

	// AC1.7: platforms.discord in allowlist.json entry must pass
	it("AC1.7: userEntrySchema accepts platforms.discord field", () => {
		const result = userEntrySchema.safeParse({
			display_name: "Alice",
			platforms: { discord: "12345" },
		});
		expect(result.success).toBe(true);
	});

	// AC2.1: valid Discord connector config parses successfully
	it("AC2.1: platformsSchema accepts valid Discord connector config", () => {
		const result = platformsSchema.safeParse({
			connectors: [
				{
					platform: "discord",
					token: "Bot.MyToken",
					leadership: "auto",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	// AC2.2: invalid leadership value "manual" must fail Zod validation
	it("AC2.2: platformsSchema rejects invalid leadership value 'manual'", () => {
		const result = platformsSchema.safeParse({
			connectors: [
				{
					platform: "discord",
					token: "Bot.MyToken",
					leadership: "manual",
				},
			],
		});
		expect(result.success).toBe(false);
	});

	// AC2.3: configSchemaMap must not contain "discord.json"
	it("AC2.3: configSchemaMap has no 'discord.json' entry", () => {
		expect("discord.json" in configSchemaMap).toBe(false);
	});

	// AC2.4: discordSchema and DiscordConfig must not be exported from @bound/shared
	it("AC2.4: discordSchema is not exported from config-schemas", async () => {
		const mod = await import("../config-schemas.js");
		expect("discordSchema" in mod).toBe(false);
	});
});

// AC3.1 tests — new relay kinds exist
describe("platform-connectors.AC3.1 — new relay kinds exist", () => {
	it("AC3.1: RELAY_REQUEST_KINDS contains intake", () => {
		expect(RELAY_REQUEST_KINDS).toContain("intake");
	});

	it("AC3.1: RELAY_REQUEST_KINDS contains platform_deliver", () => {
		expect(RELAY_REQUEST_KINDS).toContain("platform_deliver");
	});

	it("AC3.1: RELAY_REQUEST_KINDS contains event_broadcast", () => {
		expect(RELAY_REQUEST_KINDS).toContain("event_broadcast");
	});
});
