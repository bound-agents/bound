import { describe, expect, it } from "bun:test";
import {
	allowlistSchema,
	configSchemaMap,
	cronSchedulesSchema,
	heartbeatConfigSchema,
	keyringSchema,
	mcpSchema,
	modelBackendsSchema,
	networkSchema,
	overlaySchema,
	platformsSchema,
	syncSchema,
	userEntrySchema,
} from "../config-schemas.js";
import {
	RELAY_KINDS,
	RELAY_KIND_REGISTRY,
	RELAY_REQUEST_KINDS,
	RELAY_RESPONSE_KINDS,
	type RelayDispatch,
} from "../types.js";

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

		it("allows duplicate backend IDs for pooling", () => {
			const config = {
				backends: [
					{
						id: "my-backend",
						provider: "anthropic",
						model: "claude-3-opus",
						api_key: "key-1",
						context_window: 200000,
						tier: 5,
					},
					{
						id: "my-backend",
						provider: "anthropic",
						model: "claude-3-sonnet",
						api_key: "key-2",
						context_window: 200000,
						tier: 3,
					},
				],
				default: "my-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		describe("thinking field", () => {
			// Regression: prior to 2026-04-25, `thinking` was not declared on the
			// schema. Zod's default strip mode silently dropped it from parse
			// output, which meant ModelRouter.getThinkingConfig() returned
			// undefined for every backend even when the JSON config set
			// `"thinking": { "type": "enabled" }`. The Bedrock driver then sent
			// `inferenceConfig.thinking: false` and no
			// `additionalModelRequestFields`, so the model produced fake thinking
			// blocks in plain text output.
			it("preserves `thinking: { type: 'enabled' }` through parse", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "enabled" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0]).toHaveProperty("thinking");
				expect(result.data.backends[0].thinking).toEqual({ type: "enabled" });
			});

			it("preserves `thinking: { type: 'enabled', budget_tokens: 12000 }` through parse", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "enabled", budget_tokens: 12000 },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toEqual({
					type: "enabled",
					budget_tokens: 12000,
				});
			});

			it("accepts `thinking: true` shorthand through parse", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: true,
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toBe(true);
			});

			it("allows backends without a thinking field (thinking is optional)", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toBeUndefined();
			});

			it("rejects negative budget_tokens", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "enabled", budget_tokens: -1 },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			});

			// Opus 4.7 replaced `{type: "enabled", budget_tokens: N}` with
			// adaptive thinking. The model errors on `thinking.type.enabled` and
			// requires `thinking.type.adaptive` plus `output_config.effort`
			// (xhigh is the 4.7-recommended default for coding/agentic work).
			// Also: on 4.7, thinking content is OMITTED by default — display
			// must be "summarized" to get the text back in stream chunks.
			it("accepts `thinking: { type: 'adaptive' }`", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "adaptive" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toEqual({ type: "adaptive" });
			});

			it("accepts `thinking: { type: 'adaptive', display: 'summarized' }`", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "adaptive", display: "summarized" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toEqual({
					type: "adaptive",
					display: "summarized",
				});
			});

			it("accepts `display: 'omitted'`", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "adaptive", display: "omitted" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
			});

			it("rejects unknown display values", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "adaptive", display: "verbose" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			});

			it("rejects unknown thinking type values (e.g. 'auto')", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "auto" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			});
		});

		describe("effort field", () => {
			// `effort` is an output_config knob on the Claude API, not a
			// thinking sub-field. It's Opus-tier on 4.6+ and required on 4.7
			// to control thinking depth (since budget_tokens was removed).
			// Valid values per Anthropic docs: low | medium | high | xhigh | max.
			// xhigh is new on Opus 4.7 and the recommended default for
			// coding/agentic work; max is Opus-tier only.
			for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
				it(`accepts effort: '${effort}'`, () => {
					const config = {
						backends: [
							{
								id: "opus",
								provider: "bedrock",
								model: "global.anthropic.claude-opus-4-7",
								region: "us-west-2",
								context_window: 200000,
								tier: 1,
								thinking: { type: "adaptive" },
								effort,
							},
						],
						default: "opus",
					};
					const result = modelBackendsSchema.safeParse(config);
					expect(result.success).toBe(true);
					if (!result.success) return;
					expect(result.data.backends[0].effort).toBe(effort);
				});
			}

			it("rejects unknown effort values", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							thinking: { type: "adaptive" },
							effort: "extreme",
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			});

			it("allows effort without thinking (e.g. non-thinking Opus workloads)", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							tier: 1,
							effort: "medium",
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
			});
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

		it("accepts empty connectors array for spoke nodes without platforms", () => {
			const config = {
				connectors: [],
			};
			const result = platformsSchema.safeParse(config);
			expect(result.success).toBe(true);
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
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("validates sync config with relay settings", () => {
			const config = {
				hub: "https://hub.example.com",
				relay: {
					inference_timeout_ms: 60_000,
				},
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("validates sync config without hub (hub-only mode)", () => {
			const config = {
				relay: {
					inference_timeout_ms: 60_000,
				},
			};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("validates empty sync config (hub-only, defaults)", () => {
			const config = {};
			const result = syncSchema.safeParse(config);
			expect(result.success).toBe(true);
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

		it("requires command field for stdio transport", () => {
			const config = {
				servers: [
					{
						name: "filesystem",
						transport: "stdio",
						args: ["mcp-server.js"],
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("requires url field for http transport", () => {
			const config = {
				servers: [
					{
						name: "web",
						transport: "http",
						headers: { "X-API-Key": "secret" },
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("allows optional args and env for stdio transport", () => {
			const config = {
				servers: [
					{
						name: "filesystem",
						command: "node",
						transport: "stdio",
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("allows optional headers for http transport", () => {
			const config = {
				servers: [
					{
						name: "web",
						url: "https://mcp.example.com",
						transport: "http",
					},
				],
			};
			const result = mcpSchema.safeParse(config);
			expect(result.success).toBe(true);
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

	describe("heartbeatConfigSchema", () => {
		it("validates correct heartbeat config with defaults", () => {
			const result = heartbeatConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.enabled).toBe(true);
				expect(result.data.interval_ms).toBe(1_800_000);
			}
		});

		it("validates heartbeat config with custom interval", () => {
			const result = heartbeatConfigSchema.safeParse({
				enabled: true,
				interval_ms: 900_000,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.interval_ms).toBe(900_000);
			}
		});

		it("validates disabled heartbeat config", () => {
			const result = heartbeatConfigSchema.safeParse({
				enabled: false,
				interval_ms: 1_800_000,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.enabled).toBe(false);
			}
		});

		it("rejects interval_ms: 0", () => {
			const result = heartbeatConfigSchema.safeParse({
				interval_ms: 0,
			});
			expect(result.success).toBe(false);
		});

		it("rejects negative interval_ms", () => {
			const result = heartbeatConfigSchema.safeParse({
				interval_ms: -1,
			});
			expect(result.success).toBe(false);
		});

		it("rejects interval_ms below 60 seconds", () => {
			const result = heartbeatConfigSchema.safeParse({
				interval_ms: 59_999,
			});
			expect(result.success).toBe(false);
		});

		it("accepts interval_ms at exactly 60 seconds", () => {
			const result = heartbeatConfigSchema.safeParse({
				interval_ms: 60_000,
			});
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

		it("accepts cron schedules without heartbeat key", () => {
			const config = {
				daily_summary: {
					schedule: "0 9 * * *",
					thread: "summary-thread",
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("accepts cron schedules with heartbeat key", () => {
			const config = {
				heartbeat: {
					enabled: true,
					interval_ms: 1_800_000,
				},
				daily_summary: {
					schedule: "0 9 * * *",
					thread: "summary-thread",
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("defaults heartbeat to undefined when not provided", () => {
			const config = {
				daily_summary: {
					schedule: "0 9 * * *",
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.heartbeat).toBeUndefined();
			}
		});

		it("accepts heartbeat with disabled:true", () => {
			const config = {
				heartbeat: {
					enabled: false,
				},
			};
			const result = cronSchedulesSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.heartbeat?.enabled).toBe(false);
			}
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

// RELAY_KIND_REGISTRY completeness tests — ensures the registry is the
// single source of truth and derived arrays stay consistent.
describe("RELAY_KIND_REGISTRY completeness", () => {
	it("every kind in the registry has a valid dispatch mode", () => {
		const validModes: RelayDispatch[] = ["sync", "async", "response"];
		for (const [_kind, meta] of Object.entries(RELAY_KIND_REGISTRY)) {
			expect(validModes).toContain(meta.dispatch);
		}
	});

	it("derived RELAY_KINDS covers all registry entries", () => {
		const registryKinds = Object.keys(RELAY_KIND_REGISTRY).sort();
		const derivedKinds = [...RELAY_KINDS].sort();
		expect(derivedKinds).toEqual(registryKinds);
	});

	it("derived RELAY_REQUEST_KINDS matches non-response registry entries", () => {
		const expected = Object.entries(RELAY_KIND_REGISTRY)
			.filter(([, meta]) => meta.dispatch !== "response")
			.map(([kind]) => kind)
			.sort();
		const actual = [...RELAY_REQUEST_KINDS].sort();
		expect(actual).toEqual(expected);
	});

	it("derived RELAY_RESPONSE_KINDS matches response registry entries", () => {
		const expected = Object.entries(RELAY_KIND_REGISTRY)
			.filter(([, meta]) => meta.dispatch === "response")
			.map(([kind]) => kind)
			.sort();
		const actual = [...RELAY_RESPONSE_KINDS].sort();
		expect(actual).toEqual(expected);
	});

	it("every sync kind is also a request kind (not response)", () => {
		const syncKinds = Object.entries(RELAY_KIND_REGISTRY)
			.filter(([, meta]) => meta.dispatch === "sync")
			.map(([kind]) => kind);
		for (const kind of syncKinds) {
			expect(RELAY_REQUEST_KINDS).toContain(kind);
		}
	});
});

/**
 * Guardrail: every top-level config schema must REJECT unknown keys
 * (Zod strict mode) rather than silently stripping them.
 *
 * Background — on 2026-04-25 a `thinking` key on model_backends.json was
 * silently dropped by the default Zod strip behavior, which meant
 * extended thinking was fully disabled at runtime while the user's
 * config file appeared correct. Tests, typecheck, and config-load all
 * looked green. The Bedrock driver emitted `inferenceConfig.thinking:
 * false` and the model produced fake <frosting>...</frosting> reasoning
 * inline.
 *
 * Structural fix: treat config files as closed schemas. Any unknown key
 * should fail parse so the user sees the exact key name and can correct
 * it, instead of the field disappearing into a black hole.
 *
 * Each entry below is a MINIMAL valid config for the schema. The
 * guardrail: add an unknown key, expect parse failure.
 */
describe("Config schemas — unknown-key rejection (strict mode guardrail)", () => {
	const sentinelKey = "__unknown_field_guardrail_sentinel__";
	const sentinelValue = "should-fail";

	// Minimal, valid configs for each top-level schema registered in
	// configSchemaMap. Adding a new schema to configSchemaMap requires
	// adding a fixture here — intentional, because the whole point is
	// that every config schema participates in the guardrail.
	const fixtures: Record<keyof typeof configSchemaMap, unknown> = {
		"allowlist.json": {
			default_web_user: "alice",
			users: { alice: { display_name: "Alice" } },
		},
		"model_backends.json": {
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
		},
		"network.json": {
			allowedUrlPrefixes: ["https://api.example.com"],
			allowedMethods: ["GET"],
		},
		"platforms.json": {
			connectors: [],
		},
		"sync.json": {
			hub: "https://hub.example.com",
		},
		"keyring.json": {
			hosts: {
				peer1: { public_key: "abc123", url: "https://peer1.example.com" },
			},
		},
		"mcp.json": {
			servers: [],
		},
		"overlay.json": {
			mounts: {},
		},
		"cron_schedules.json": {},
	};

	for (const [filename, baseConfig] of Object.entries(fixtures)) {
		const schema = configSchemaMap[filename as keyof typeof configSchemaMap];

		it(`${filename}: rejects an unknown top-level key`, () => {
			const configWithExtra = { ...(baseConfig as object), [sentinelKey]: sentinelValue };
			const result = schema.safeParse(configWithExtra);
			expect(result.success).toBe(false);
			if (!result.success) {
				// Error message should name the offending key so users
				// can find and fix it immediately.
				expect(result.error.message).toContain(sentinelKey);
			}
		});

		it(`${filename}: accepts the baseline fixture (sanity — fixture is valid)`, () => {
			const result = schema.safeParse(baseConfig);
			// If this fails, the fixture needs updating; the guardrail
			// test above is meaningless otherwise.
			expect(result.success).toBe(true);
		});
	}

	// Nested schemas: extras on nested objects are just as dangerous as
	// extras on the root. A `thinking` field on a backend entry was the
	// original incident — cover that directly.
	it("model_backends.json: rejects an unknown key nested inside a backend entry", () => {
		const config = {
			backends: [
				{
					id: "ollama-local",
					provider: "ollama",
					model: "llama2",
					base_url: "http://localhost:11434",
					context_window: 4096,
					tier: 1,
					[sentinelKey]: sentinelValue,
				},
			],
			default: "ollama-local",
		};
		const result = configSchemaMap["model_backends.json"].safeParse(config);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).toContain(sentinelKey);
		}
	});
});
