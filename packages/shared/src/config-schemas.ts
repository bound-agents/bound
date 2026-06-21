import { z } from "zod";

// Config schemas use Zod strict mode throughout so unknown keys fail parse
// with the exact offending key name instead of being silently stripped.
// Treat every config file as a closed schema. Nested objects get `.strict()`
// too; `.refine(...)` chains compose cleanly after strict validation.

// Allowlist Config
export const userEntrySchema = z
	.object({
		display_name: z.string().min(1),
		platforms: z.record(z.string(), z.string()).optional(),
		discord_id: z
			.string()
			.optional()
			.refine((v) => v === undefined, {
				message: "discord_id is no longer supported — use platforms.discord instead",
			}),
	})
	.strict()
	.transform(({ discord_id: _legacy, ...rest }) => rest);

export const allowlistSchema = z
	.object({
		default_web_user: z.string().min(1),
		users: z.record(z.string(), userEntrySchema).refine((users) => Object.keys(users).length > 0, {
			message: "At least one user must be defined",
		}),
	})
	.strict()
	.refine((data) => data.default_web_user in data.users, {
		message: "default_web_user must reference a user defined in users",
	});

export type AllowlistConfig = z.infer<typeof allowlistSchema>;

// Model Backends Config
const backendCapabilitiesOverrideSchema = z
	.object({
		streaming: z.boolean(),
		tool_use: z.boolean(),
		system_prompt: z.boolean(),
		prompt_caching: z.boolean(),
		vision: z.boolean(),
		max_context: z.number().int().positive(),
	})
	.partial()
	.strict();

// Extended-thinking / reasoning config.
//
// Two shapes are supported, matching the two generations of the
// Anthropic API:
//
//  1. Legacy (Opus 4.6 and older) — `{type: "enabled", budget_tokens: N}`
//     tells the model exactly how many tokens to spend on thinking.
//     `budget_tokens` was removed on Opus 4.7 (400 if sent).
//
//  2. Adaptive (Opus 4.6+, required on 4.7) — `{type: "adaptive"}` lets the
//     model decide how much to think. Depth is controlled by the
//     top-level `effort` field on the backend, not here. The optional
//     `display` field opts into visible reasoning text on Opus 4.7,
//     where the default is `"omitted"` (thinking blocks stream with
//     empty text).
//
// The boolean-true shorthand preserves backward compatibility with the
// earliest schema shape. Consumed by ModelRouter.getThinkingConfig().
const thinkingConfigSchema = z.union([
	z.literal(true),
	z
		.object({
			type: z.enum(["enabled", "adaptive"]).optional(),
			budget_tokens: z.number().int().positive().optional(),
			display: z.enum(["omitted", "summarized"]).optional(),
		})
		.strict(),
]);

// `effort` is a top-level output_config knob on the Claude API. It
// replaces `budget_tokens` as the depth control on Opus 4.7 and is
// recommended alongside adaptive thinking on Opus 4.6. Valid levels:
// low | medium | high | xhigh | max. `xhigh` is new on 4.7 and the
// recommended default for coding/agentic work; `max` is Opus-tier only.
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

// Cache-Warming Config — opt-in periodic "warm poke" that keeps the LLM prompt
// cache hot on active threads so the next real message lands on a cache-read
// rather than a cache-write (issue #10). Disabled by default. Lives as an
// optional per-backend `cache_warming` block on each entry in
// model_backends.json, co-located with that backend's `cache_ttl` and cache
// pricing — the signals its economics depend on. The whole feature is
// per-backend (rather than a global `enabled` switch plus a per-backend cap)
// so the decision to warm at all sits at the same altitude as the parameter
// that decides whether warming is economical.
//
// Economics: a poke costs ~one cache-read of the prefix; a caught cold arrival
// saves ~one cache-write. Break-even varies dramatically by provider — it
// scales with the cache-write/cache-read price ratio — so the per-backend
// `max_pokes` is the load-bearing economic control. It
// bounds the loss on threads that go quiet after their last real message.
//
// The just-in-time poke window is NOT configured: it is derived per-thread from
// that thread's backend `cache_ttl` (a poke fires only when the cache would
// otherwise lapse before the next scan). A single global cadence knob cannot be
// correct for a cluster whose backends have different TTLs (e.g. 5m vs 1h).
export const DEFAULT_WARM_POKE_ACTIVE_WINDOW_MS = 24 * 60 * 60_000; // 24h
export const DEFAULT_WARM_POKE_MAX_PER_PERIOD = 3;
// Driver scan period. Must be < the smallest supported cache TTL (5m) so the
// derived just-in-time window (ttl − scan) stays positive. This is a mechanical
// knob (how often to look), not an economic one, so it is a constant.
export const WARM_POKE_SCAN_INTERVAL_MS = 2 * 60_000; // 2m

export const cacheWarmingConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		// Cap on warm pokes per thread since its last real activity. The
		// load-bearing economic control: break-even varies dramatically by
		// provider (it scales with the cache-write/cache-read price ratio), so a
		// 5m backend with cheap cache-reads tolerates many more pokes per caught
		// arrival than a 1h backend with expensive writes. Absent →
		// DEFAULT_WARM_POKE_MAX_PER_PERIOD. 0 → never warm threads on this
		// backend (a clean opt-out even with `enabled: true`).
		max_pokes: z.number().int().min(0).default(DEFAULT_WARM_POKE_MAX_PER_PERIOD),
	})
	.strict();

export type CacheWarmingConfig = z.infer<typeof cacheWarmingConfigSchema>;

const modelBackendSchema = z
	.object({
		id: z.string().min(1),
		provider: z.enum([
			"bedrock",
			"bedrock-mantle",
			"anthropic",
			"openai-compatible",
			"cerebras",
			"zai",
			"opencode-go",
		]),
		model: z.string().min(1),
		base_url: z.string().url().optional(),
		api_key: z.string().optional(),
		region: z.string().optional(),
		profile: z.string().optional(),
		context_window: z.number().int().positive(),
		tier: z.number().int().min(1).max(5),
		price_per_m_input: z.number().min(0).default(0),
		price_per_m_output: z.number().min(0).default(0),
		price_per_m_cache_write: z.number().min(0).optional(),
		price_per_m_cache_read: z.number().min(0).optional(),
		capabilities: backendCapabilitiesOverrideSchema.optional(),
		thinking: thinkingConfigSchema.optional(),
		effort: effortSchema.optional(),
		// Per-backend cap on `maxOutputTokens` forwarded to the provider.
		// Some Bedrock models reject DEFAULT_MAX_OUTPUT_TOKENS (16_384) with
		// "max_tokens exceeds model limit of N" — e.g. Nova Pro caps at 10_000.
		// The agent-loop takes `min(max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS)`
		// at call time so lowering it is always safe.
		max_output_tokens: z.number().int().positive().optional(),
		// Prompt cache TTL hint forwarded to the provider's cache breakpoint.
		// Bedrock supports "5m" (default) and "1h" (extended, only for Claude
		// Opus 4.5+, Sonnet 4.5+, Haiku 4.5+). Anthropic native API supports
		// both via `cache_control: { ttl }`. Setting "1h" on a model that
		// doesn't support extended TTL is silently ignored by the provider
		// and falls back to the default 5m behavior.
		cache_ttl: z.enum(["5m", "1h"]).optional(),
		// Per-backend opt-in cache-warming (issue #10). When present with
		// `enabled: true`, the warm-poke driver keeps this backend's threads'
		// prompt cache hot so the next real message lands on a cache-read. The
		// whole feature lives per-backend because both the decision to warm and
		// the poke-count economics depend on this backend's cache pricing + TTL.
		// Absent → this backend is never warmed. See `cacheWarmingConfigSchema`.
		cache_warming: cacheWarmingConfigSchema.optional(),
		// Per-backend connect / time-to-first-byte deadline (ms). When set, the
		// logger-backed fetch owns an AbortController that aborts the request if
		// response headers do not arrive within this window, surfacing a
		// self-identifying error instead of the opaque transport `TimeoutError`
		// ("The operation timed out."). Headers-scoped: cleared the instant
		// `fetch()` resolves, so a slow-but-progressing stream is governed by the
		// agent-loop silence timeout, not this deadline. A local concern applied
		// on whichever host runs the fetch — NOT forwarded over the relay, so a
		// spoke uses its own deadline rather than honoring a hub-set one. Absent /
		// `<= 0` → no deadline (pure passthrough). See `createLoggingFetch`.
		connect_timeout_ms: z.number().int().positive().optional(),
		// Arbitrary custom HTTP headers added to every request this backend
		// sends to its upstream endpoint. A flat key-value map, layered on top
		// of the provider's own headers (the `api_key`-derived `Authorization`
		// is applied first, so a header set here cannot silently clobber auth
		// unless it names `Authorization` itself). Currently consumed by the
		// OpenAI-compatible-shim providers (`openai-compatible`, `cerebras`,
		// `zai`) — their shared driver threads these through to the AI SDK's
		// `headers` option. A host-local concern applied on
		// whichever host runs the fetch, NOT forwarded over the relay, so a
		// spoke uses its own headers rather than honoring a hub-set set (mirrors
		// `connect_timeout_ms`). Absent → no extra headers.
		additional_headers: z.record(z.string(), z.string()).optional(),
	})
	.strict();

export const modelBackendsSchema = z
	.object({
		// An empty array is valid for hub-only nodes that relay inference to spokes.
		backends: z.array(modelBackendSchema).min(0),
		// Empty string is the sentinel value meaning "no local default" (hub-only mode).
		default: z.string().default(""),
		daily_budget_usd: z.number().min(0).optional(),
		// Opt-in cache-warming driver (issue #10). Co-located here because its
		// economics derive from per-backend `cache_ttl` + cache pricing above.
		cache_warming: cacheWarmingConfigSchema.optional(),
	})
	.strict()
	.refine(
		(data) => {
			// Hub-only mode: empty backends must have empty default ("").
			if (data.backends.length === 0) return data.default === "";
			// Normal mode: default must reference a valid backend ID.
			return data.backends.some((b) => b.id === data.default);
		},
		{
			message:
				"default must reference a backend ID defined in backends (or be empty when backends is empty)",
		},
	)
	.refine(
		(data) => {
			return data.backends.every((b) => {
				if (b.provider === "openai-compatible") {
					return b.base_url !== undefined;
				}
				return true;
			});
		},
		{ message: "openai-compatible providers require base_url" },
	)
	.refine(
		(data) => {
			return data.backends.every((b) => {
				if (
					b.provider === "cerebras" ||
					b.provider === "anthropic" ||
					b.provider === "zai" ||
					b.provider === "opencode-go"
				) {
					return b.api_key !== undefined;
				}
				return true;
			});
		},
		{ message: "cerebras, anthropic, zai, and opencode-go providers require api_key" },
	);

export type ModelBackendsConfig = z.infer<typeof modelBackendsSchema>;

// Optional Configs
export const networkSchema = z
	.object({
		allowedUrlPrefixes: z.array(z.string()),
		allowedMethods: z.array(z.string()),
		transform: z
			.array(
				z
					.object({
						url: z.string(),
						headers: z.record(z.string(), z.string()),
					})
					.strict(),
			)
			.optional(),
	})
	.strict();

export type NetworkConfig = z.infer<typeof networkSchema>;

const connectorConfigSchema = z
	.object({
		platform: z.string().min(1),
		token: z.string().optional(),
		signing_secret: z.string().optional(),
		allowed_users: z.array(z.string()).default([]),
		leadership: z.enum(["auto", "leader", "standby", "all"]).default("auto"),
		failover_threshold_ms: z.number().int().positive().default(30_000),
	})
	.strict();

export const platformsSchema = z
	.object({
		connectors: z.array(connectorConfigSchema),
	})
	.strict();

export type PlatformConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type PlatformsConfig = z.infer<typeof platformsSchema>;

export const relaySchema = z
	.object({
		enabled: z.boolean().default(true),
		max_payload_bytes: z
			.number()
			.int()
			.positive()
			.default(2 * 1024 * 1024),
		request_timeout_ms: z.number().int().positive().default(30_000),
		prune_interval_seconds: z.number().int().positive().default(60),
		prune_retention_seconds: z.number().int().positive().default(300),
		drain_timeout_seconds: z.number().int().positive().default(120),
		/** Per-host timeout for inference relay streaming (ms). Must account for
		 *  sync delivery latency + LLM inference time. Default 300s. */
		inference_timeout_ms: z.number().int().positive().default(300_000),
	})
	.strict();

export type RelayConfig = z.infer<typeof relaySchema>;

export const wsSchema = z
	.object({
		backfill_interval: z.number().int().min(0).default(300),
		backpressure_limit: z.number().int().positive().default(2097152),
		idle_timeout: z.number().int().positive().default(120),
		reconnect_max_interval: z.number().int().positive().default(60),
	})
	.strict();

export type WsConfig = z.infer<typeof wsSchema>;

export const syncSchema = z
	.object({
		hub: z.string().min(1).optional(),
		relay: relaySchema.optional(),
		ws: wsSchema.optional(),
	})
	.strict();

export type SyncConfig = z.infer<typeof syncSchema>;

export const keyringSchema = z
	.object({
		hosts: z.record(
			z.string(),
			z
				.object({
					public_key: z.string().min(1),
					url: z.string().url(),
				})
				.strict(),
		),
	})
	.strict();

export type KeyringConfig = z.infer<typeof keyringSchema>;

const mcpServerBaseSchema = z.object({
	name: z.string().min(1),
	allow_tools: z.array(z.string()).optional(),
	confirm: z.array(z.string()).optional(),
});

// Variants of the discriminated union call `.strict()` individually so
// unknown keys on one transport don't slip through via the other.
const mcpServerStdioSchema = mcpServerBaseSchema
	.extend({
		transport: z.literal("stdio"),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
	})
	.strict();

const mcpServerHttpSchema = mcpServerBaseSchema
	.extend({
		transport: z.literal("http"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	})
	.strict();

const mcpServerSchema = z.discriminatedUnion("transport", [
	mcpServerStdioSchema,
	mcpServerHttpSchema,
]);

export const mcpSchema = z
	.object({
		servers: z.array(mcpServerSchema),
	})
	.strict();

export type McpConfig = z.infer<typeof mcpSchema>;

export const overlaySchema = z
	.object({
		mounts: z.record(z.string(), z.string()),
	})
	.strict();

export type OverlayConfig = z.infer<typeof overlaySchema>;

// Memory Config — caps on pinned-memory creation as a context-management
// control. Enabled by default: when memory.json is absent the loader skips it,
// so the enforcement code falls back to these same defaults (see
// DEFAULT_PINNED_COUNT_CAP / DEFAULT_PINNED_SIZE_CAP).
export const DEFAULT_PINNED_COUNT_CAP = 10;
export const DEFAULT_PINNED_SIZE_CAP = 2000;

export const memoryConfigSchema = z
	.object({
		pinned_count_cap: z
			.number()
			.int()
			.min(1, "pinned_count_cap must be at least 1")
			.default(DEFAULT_PINNED_COUNT_CAP),
		pinned_size_cap: z
			.number()
			.int()
			.min(1, "pinned_size_cap must be at least 1")
			.default(DEFAULT_PINNED_SIZE_CAP),
	})
	.strict();

export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

// Config type union
export type ConfigType =
	| AllowlistConfig
	| ModelBackendsConfig
	| NetworkConfig
	| PlatformsConfig
	| SyncConfig
	| KeyringConfig
	| McpConfig
	| OverlayConfig
	| MemoryConfig
	| CacheWarmingConfig;

// Schema map for programmatic validation
export const configSchemaMap = {
	"allowlist.json": allowlistSchema,
	"model_backends.json": modelBackendsSchema,
	"network.json": networkSchema,
	"platforms.json": platformsSchema,
	"sync.json": syncSchema,
	"keyring.json": keyringSchema,
	"mcp.json": mcpSchema,
	"overlay.json": overlaySchema,
} as const;
