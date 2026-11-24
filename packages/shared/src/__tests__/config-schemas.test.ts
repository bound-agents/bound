import { describe, expect, it } from "bun:test";
import {
	allowlistSchema,
	configSchemaMap,
	keyringSchema,
	mcpSchema,
	modelBackendsSchema,
	networkSchema,
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
						id: "local-compat",
						provider: "openai-compatible",
						model: "llama3",
						base_url: "http://localhost:11434/v1",
						context_window: 4096,
					},
				],
				default: "local-compat",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects a backend that declares the removed `tier` field, naming the key (R-RT3)", () => {
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "local-compat",
						provider: "openai-compatible",
						model: "llama3",
						base_url: "http://localhost:11434/v1",
						context_window: 4096,
						tier: 1,
					},
				],
				default: "local-compat",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const unrecognized = result.error.issues.find((i) => i.code === "unrecognized_keys");
				expect(unrecognized).toBeDefined();
				expect((unrecognized as { keys: string[] }).keys).toContain("tier");
				expect(result.error.message).toContain("tier");
			}
		});

		it("leaves price_per_m_input/output unset when the operator omits them (distinguishable from an explicit 0)", () => {
			// The catalog precedence (2026-11-21-model-catalog.md §3) treats an
			// EXPLICITLY-SET config price as an operator override that beats
			// models.dev, while an UNSET field falls through to provider/models.dev
			// pricing. A schema `.default(0)` collapses those two cases, so the price
			// fields stay optional and absent when the operator omits them.
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "nopricing",
						provider: "bedrock",
						model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
						region: "us-east-1",
						context_window: 200_000,
					},
				],
				default: "nopricing",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const b = result.data.backends[0];
				expect(b.price_per_m_input).toBeUndefined();
				expect(b.price_per_m_output).toBeUndefined();
			}
		});

		it("preserves an explicit price_per_m_input/output of 0 as a set override", () => {
			// An operator who deliberately pins a price to 0 (free local model) must be
			// able to override a nonzero models.dev price. The parsed value is present.
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "free",
						provider: "openai-compatible",
						model: "llama3",
						base_url: "http://localhost:11434/v1",
						context_window: 4096,
						price_per_m_input: 0,
						price_per_m_output: 0,
					},
				],
				default: "free",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const b = result.data.backends[0];
				expect(b.price_per_m_input).toBe(0);
				expect(b.price_per_m_output).toBe(0);
			}
		});

		it("accepts arbitrary valid cache durations and rejects garbage", () => {
			for (const cache_ttl of ["5m", "1h", "30m", "PT30M"]) {
				const result = modelBackendsSchema.safeParse({
					backends: [
						{
							id: "cached",
							provider: "bedrock",
							model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
							region: "us-east-1",
							context_window: 200_000,
							cache_ttl,
						},
					],
					default: "cached",
				});
				expect(result.success, cache_ttl).toBe(true);
			}

			const invalid = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "cached",
						provider: "bedrock",
						model: "openai.gpt-5.6",
						region: "us-east-1",
						cache_ttl: "garbage",
					},
				],
				default: "cached",
			});
			expect(invalid.success).toBe(false);
		});

		it("accepts an optional per-backend system prompt suffix", () => {
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "specialized",
						provider: "bedrock",
						model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
						region: "us-east-1",
						context_window: 200_000,
						system_prompt_suffix: "Use the backend-specific policy.",
					},
				],
				default: "specialized",
			});
			expect(result.success).toBe(true);
		});

		it("accepts an optional models_dev block and applies defaults when present", () => {
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "b",
						provider: "bedrock",
						model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
						region: "us-east-1",
						context_window: 200_000,
					},
				],
				default: "b",
				models_dev: { enabled: false },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.models_dev?.enabled).toBe(false);
				// Unset fields take their schema defaults.
				expect(result.data.models_dev?.url).toBe("https://models.dev/api.json");
				expect(result.data.models_dev?.refresh_interval_ms).toBe(24 * 60 * 60 * 1000);
			}
		});

		it("rejects an unknown key inside models_dev (strict)", () => {
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "b",
						provider: "bedrock",
						model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
						region: "us-east-1",
						context_window: 200_000,
					},
				],
				default: "b",
				models_dev: { enabled: true, bogus: 1 },
			});
			expect(result.success).toBe(false);
		});

		it("accepts an optional logical_model on a backend", () => {
			const result = modelBackendsSchema.safeParse({
				backends: [
					{
						id: "opus",
						provider: "bedrock",
						model: "anthropic.claude-opus-4-20250101-v1:0",
						region: "us-east-1",
						context_window: 200_000,
						logical_model: "claude-opus-4",
					},
				],
				default: "opus",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.backends[0].logical_model).toBe("claude-opus-4");
			}
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
						provider: "openai-compatible",
						model: "llama2",
						base_url: "http://localhost:11434/v1",
						context_window: 4096,
					},
				],
				default: "nonexistent-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects an unrecognized provider (enum is closed)", () => {
			const config = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
						model: "llama2",
						base_url: "http://localhost:11434",
						context_window: 4096,
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
					},
				],
				default: "openai-compat",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("accepts opencode-go provider with api_key and no base_url", () => {
			const config = {
				backends: [
					{
						id: "opencode-go",
						provider: "opencode-go",
						model: "glm-5.1",
						api_key: "test-key",
						context_window: 128000,
					},
				],
				default: "opencode-go",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires api_key for opencode-go provider", () => {
			const config = {
				backends: [
					{
						id: "opencode-go",
						provider: "opencode-go",
						model: "glm-5.1",
						context_window: 128000,
					},
				],
				default: "opencode-go",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("accepts bedrock-mantle with explicit openai_responses provider_mode", () => {
			const config = {
				backends: [
					{
						id: "mantle-gpt",
						provider: "bedrock-mantle",
						provider_mode: "openai_responses",
						model: "openai.gpt-5.5",
						region: "us-east-1",
						context_window: 272000,
					},
				],
				default: "mantle-gpt",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("accepts bedrock-mantle with explicit anthropic provider_mode and no api_key", () => {
			const config = {
				backends: [
					{
						id: "mantle-sonnet",
						provider: "bedrock-mantle",
						provider_mode: "anthropic",
						model: "anthropic.claude-sonnet-5",
						region: "us-east-1",
						context_window: 200000,
					},
				],
				default: "mantle-sonnet",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("requires provider_mode for bedrock-mantle", () => {
			const config = {
				backends: [
					{
						id: "mantle-gpt",
						provider: "bedrock-mantle",
						model: "openai.gpt-5.5",
						region: "us-east-1",
						context_window: 272000,
					},
				],
				default: "mantle-gpt",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		// --- umans (config-light, self-configuring) ---

		it("accepts a config-light umans namespace (provider+id+api_key only) (AC.1)", () => {
			const config = {
				backends: [{ id: "umans", provider: "umans", api_key: "sk-test" }],
				default: "umans",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects a umans namespace missing api_key, naming umans (AC.2)", () => {
			const config = {
				backends: [{ id: "umans", provider: "umans" }],
				default: "umans",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(JSON.stringify(result.error.issues)).toContain("umans");
			}
		});

		it("rejects a umans row that sets model/context_window (AC.2)", () => {
			const config = {
				backends: [
					{
						id: "umans",
						provider: "umans",
						api_key: "sk-test",
						model: "umans-coder",
						context_window: 200000,
					},
				],
				default: "umans",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("rejects a umans row that sets pricing (AC.2)", () => {
			const config = {
				backends: [{ id: "umans", provider: "umans", api_key: "sk-test", price_per_m_input: 3 }],
				default: "umans",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		// --- github-copilot (self-configuring namespace form) ---

		it("accepts a github-copilot namespace entry with no model (self-configuring)", () => {
			const config = {
				backends: [{ id: "copilot", provider: "github-copilot" }],
				default: "copilot",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("accepts a github-copilot namespace with blanket controls + model_overrides", () => {
			const config = {
				backends: [
					{
						id: "copilot",
						provider: "github-copilot",
						thinking: { type: "adaptive" },
						effort: "medium",
						cache_ttl: "1h",
						model_overrides: {
							"claude-opus-5.5": { logical_model: "opus-5-5", cache_ttl: "5m" },
						},
					},
				],
				default: "copilot",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects a github-copilot namespace (no model) that sets an authoritative catalog field", () => {
			// context_window / capabilities / pricing come from the Copilot catalog on a
			// namespace entry; setting them has no single model to apply to.
			for (const authoritative of [
				{ context_window: 200000 },
				{ price_per_m_input: 3 },
				{ capabilities: { vision: true } },
			]) {
				const config = {
					backends: [{ id: "copilot", provider: "github-copilot", ...authoritative }],
					default: "copilot",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			}
		});

		it("still accepts a single-model github-copilot entry that sets context_window", () => {
			// A `model`-bearing github-copilot entry is a concrete backend and keeps the
			// normal override fields (the namespace rejection only fires with no model).
			const config = {
				backends: [
					{
						id: "copilot-opus",
						provider: "github-copilot",
						model: "claude-opus-5.5",
						context_window: 200000,
					},
				],
				default: "copilot-opus",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("rejects an unknown key inside model_overrides (strict)", () => {
			const config = {
				backends: [
					{
						id: "copilot",
						provider: "github-copilot",
						model_overrides: {
							"claude-opus-5.5": { not_a_field: true },
						},
					},
				],
				default: "copilot",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("still rejects a NON-umans row that omits model/context_window (AC.2)", () => {
			const config = {
				backends: [{ id: "x", provider: "cerebras", api_key: "k", base_url: "https://x/v1" }],
				default: "x",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("accepts a NON-umans row that omits context_window (optional, catalog resolves it)", () => {
			// Requirement 2: context_window is optional for all providers now; the
			// catalog resolves the window from provider discovery / models.dev, and
			// the R-MC4 readiness gate keeps a backend with no window anywhere unready
			// at runtime. `model` is still required for non-umans.
			const config = {
				backends: [
					{
						id: "grok",
						provider: "github-copilot",
						model: "grok-4.7",
						token_store_path: "/tmp/copilot.json",
					},
				],
				default: "grok",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		it("still rejects a NON-self-configuring row that omits model (model stays required)", () => {
			// anthropic is a direct vendor API, not a self-configuring namespace, so a
			// model is still mandatory. (bedrock / bedrock-mantle WITHOUT a model are now
			// valid namespace entries — covered below.)
			const config = {
				backends: [{ id: "x", provider: "anthropic", api_key: "k", context_window: 200000 }],
				default: "x",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(false);
		});

		it("accepts a bedrock namespace entry (no model) for a (profile, region)", () => {
			const config = {
				backends: [
					{ id: "bedrock-use1", provider: "bedrock", region: "us-east-1", profile: "admin" },
				],
				default: "bedrock-use1",
			};
			expect(modelBackendsSchema.safeParse(config).success).toBe(true);
		});

		it("accepts a bedrock-mantle namespace entry (no model, no provider_mode)", () => {
			const config = {
				backends: [
					{ id: "mantle-use1", provider: "bedrock-mantle", region: "us-east-1", profile: "admin" },
				],
				default: "mantle-use1",
			};
			expect(modelBackendsSchema.safeParse(config).success).toBe(true);
		});

		it("accepts a bedrock namespace with cross_region and model_overrides", () => {
			const config = {
				backends: [
					{
						id: "bedrock-use1",
						provider: "bedrock",
						region: "us-east-1",
						profile: "admin",
						cross_region: "global",
						model_overrides: {
							"anthropic.claude-haiku-5-5": {
								logical_model: "haiku",
								price_per_m_cache_write_1h: 1.0,
							},
						},
					},
				],
				default: "bedrock-use1",
			};
			expect(modelBackendsSchema.safeParse(config).success).toBe(true);
		});

		it("accepts a `price` turn callback inside model_overrides (JS-config only)", () => {
			// Requirement 5: a tiered per-model `price(turn)` callback is a legitimate
			// operator fact with no published source (e.g. the haiku tiered price). It
			// is the per-model analogue of the top-level per-backend `price` and must be
			// expressible on a namespace entry's override object.
			const config = {
				backends: [
					{
						id: "bedrock",
						provider: "bedrock",
						region: "us-east-1",
						profile: "admin",
						model_overrides: {
							"anthropic.claude-haiku-5-5": {
								price: (turn: { inputTokens: number }) => turn.inputTokens / 1_000_000,
							},
						},
					},
				],
				default: "bedrock",
			};
			expect(modelBackendsSchema.safeParse(config).success).toBe(true);
		});

		it("rejects a bedrock namespace entry (no model) that sets an authoritative catalog field", () => {
			for (const authoritative of [
				{ context_window: 200000 },
				{ price_per_m_input: 3 },
				{ capabilities: { vision: true } },
			]) {
				const config = {
					backends: [
						{ id: "bedrock-use1", provider: "bedrock", region: "us-east-1", ...authoritative },
					],
					default: "bedrock-use1",
				};
				expect(modelBackendsSchema.safeParse(config).success).toBe(false);
			}
		});

		it("rejects negative context_window", () => {
			const config = {
				backends: [
					{
						id: "bad-backend",
						provider: "anthropic",
						model: "claude-3",
						context_window: -1,
					},
				],
				default: "bad-backend",
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
					},
					{
						id: "my-backend",
						provider: "anthropic",
						model: "claude-3-sonnet",
						api_key: "key-2",
						context_window: 200000,
					},
				],
				default: "my-backend",
			};
			const result = modelBackendsSchema.safeParse(config);
			expect(result.success).toBe(true);
		});

		describe("thinking field", () => {
			// Regression: `thinking` was not declared on the
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

			it("rejects unknown display values", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							thinking: { type: "adaptive", display: "verbose" },
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
			});

			it("accepts `thinking: { type: 'tool' }`", () => {
				const config = {
					backends: [
						{
							id: "tool-mode",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							thinking: { type: "tool" },
						},
					],
					default: "tool-mode",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].thinking).toEqual({ type: "tool" });
			});

			it("rejects tool mode with native-thinking fields", () => {
				const config = {
					backends: [
						{
							id: "tool-mode",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							thinking: { type: "tool", budget_tokens: 12000 },
						},
					],
					default: "tool-mode",
				};
				expect(modelBackendsSchema.safeParse(config).success).toBe(false);
			});

			it("rejects tool mode for Mantle Fable because the provider has no disable control", () => {
				const config = {
					backends: [
						{
							id: "fable",
							provider: "bedrock-mantle",
							provider_mode: "anthropic",
							model: "anthropic.claude-fable-5",
							region: "us-east-1",
							context_window: 200000,
							thinking: { type: "tool" },
						},
					],
					default: "fable",
				};
				expect(modelBackendsSchema.safeParse(config).success).toBe(false);
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

			it("accepts a free-form effort value (provider-validated, not schema-validated)", () => {
				// effort is now free-form: the canonical Anthropic set is no
				// longer enforced by the schema because other providers (umans)
				// advertise their own reasoning.levels. A provider-specific level
				// must pass schema validation; the driver validates it.
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							thinking: { type: "adaptive" },
							effort: "ultra",
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].effort).toBe("ultra");
			});

			it("rejects an empty-string effort", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
							effort: "",
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
							effort: "medium",
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
			});
		});

		describe("max_output_tokens field", () => {
			// Per-backend cap on the response-side `maxOutputTokens` parameter.
			// Some Bedrock models reject an explicit maxTokens above their
			// ceiling with "max_tokens exceeds model limit of 10000" — notably
			// Nova Pro (10k cap). This field lets operators pin a lower cap per
			// backend without touching code. The agent-loop takes
			// `min(backend.max_output_tokens, configuredMax)`, and when neither
			// is set, omits max_tokens entirely.
			it("accepts a positive integer max_output_tokens", () => {
				const config = {
					backends: [
						{
							id: "nova-pro",
							provider: "bedrock",
							model: "us.amazon.nova-pro-v1:0",
							region: "us-west-2",
							context_window: 300000,
							max_output_tokens: 8192,
						},
					],
					default: "nova-pro",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].max_output_tokens).toBe(8192);
			});

			it("allows backends to omit max_output_tokens (optional)", () => {
				const config = {
					backends: [
						{
							id: "opus",
							provider: "bedrock",
							model: "global.anthropic.claude-opus-4-7",
							region: "us-west-2",
							context_window: 200000,
						},
					],
					default: "opus",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(true);
				if (!result.success) return;
				expect(result.data.backends[0].max_output_tokens).toBeUndefined();
			});

			it("rejects zero and negative max_output_tokens", () => {
				for (const bad of [0, -1, -100]) {
					const config = {
						backends: [
							{
								id: "nova-pro",
								provider: "bedrock",
								model: "us.amazon.nova-pro-v1:0",
								region: "us-west-2",
								context_window: 300000,
								max_output_tokens: bad,
							},
						],
						default: "nova-pro",
					};
					const result = modelBackendsSchema.safeParse(config);
					expect(result.success).toBe(false);
				}
			});

			it("rejects non-integer max_output_tokens", () => {
				const config = {
					backends: [
						{
							id: "nova-pro",
							provider: "bedrock",
							model: "us.amazon.nova-pro-v1:0",
							region: "us-west-2",
							context_window: 300000,
							max_output_tokens: 8192.5,
						},
					],
					default: "nova-pro",
				};
				const result = modelBackendsSchema.safeParse(config);
				expect(result.success).toBe(false);
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

		it("applies reconnect defaults when the ws block is present", () => {
			const result = syncSchema.parse({ ws: {} });
			expect(result.ws?.reconnect_max_interval).toBe(10);
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
			expect(mcpSchema.safeParse(config).success).toBe(true);
		});

		// MCP OAuth RFC docs/design/specs/2026-09-21-mcp-oauth.md, R-MO1/R-MO3/R-MO4/R-MO5.
		describe("http `auth` OAuth block (MCP OAuth slice 1)", () => {
			it("parses a full oauth auth block on an http entry", () => {
				const config = {
					servers: [
						{
							name: "web",
							url: "https://mcp.example.com",
							transport: "http",
							auth: {
								type: "oauth",
								scopes: ["read", "write"],
								client_id: "client-123",
								client_secret: "shhh",
							},
						},
					],
				};
				expect(mcpSchema.safeParse(config).success).toBe(true);
			});

			it("parses an oauth auth block with only the required `type`", () => {
				const config = {
					servers: [
						{
							name: "web",
							url: "https://mcp.example.com",
							transport: "http",
							auth: { type: "oauth" },
						},
					],
				};
				expect(mcpSchema.safeParse(config).success).toBe(true);
			});

			it("still parses an http entry with no auth block (existing configs)", () => {
				const config = {
					servers: [{ name: "web", url: "https://mcp.example.com", transport: "http" }],
				};
				expect(mcpSchema.safeParse(config).success).toBe(true);
			});

			it("rejects an unknown subfield inside the auth block (strict mode)", () => {
				const config = {
					servers: [
						{
							name: "web",
							url: "https://mcp.example.com",
							transport: "http",
							auth: { type: "oauth", audience: "nope" },
						},
					],
				};
				expect(mcpSchema.safeParse(config).success).toBe(false);
			});

			it("rejects an auth `type` other than oauth", () => {
				const config = {
					servers: [
						{
							name: "web",
							url: "https://mcp.example.com",
							transport: "http",
							auth: { type: "apikey" },
						},
					],
				};
				expect(mcpSchema.safeParse(config).success).toBe(false);
			});

			it("rejects an auth block on a stdio entry (OAuth is http-only, R-MO1)", () => {
				const config = {
					servers: [
						{
							name: "filesystem",
							command: "node",
							transport: "stdio",
							auth: { type: "oauth" },
						},
					],
				};
				// The strict stdio member does not extend `auth`, so it is an unknown key there.
				expect(mcpSchema.safeParse(config).success).toBe(false);
			});
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
});

// AC3.1 tests — new relay kinds exist
describe("platform-connectors.AC3.1 — new relay kinds exist", () => {
	it("AC3.1: RELAY_REQUEST_KINDS contains intake", () => {
		expect(RELAY_REQUEST_KINDS).toContain("intake");
	});
});

/**
 * Guardrail: every top-level config schema must REJECT unknown keys
 * (Zod strict mode) rather than silently stripping them.
 *
 * Background — a `thinking` key on model_backends.json was
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
					provider: "openai-compatible",
					model: "llama2",
					base_url: "http://localhost:11434",
					context_window: 4096,
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
					provider: "openai-compatible",
					model: "llama2",
					base_url: "http://localhost:11434",
					context_window: 4096,
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
