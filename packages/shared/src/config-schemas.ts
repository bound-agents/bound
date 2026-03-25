import { z } from "zod";

// Allowlist Config
const userEntrySchema = z.object({
	display_name: z.string().min(1),
	discord_id: z.string().optional(),
});

export const allowlistSchema = z
	.object({
		default_web_user: z.string().min(1),
		users: z.record(z.string(), userEntrySchema).refine((users) => Object.keys(users).length > 0, {
			message: "At least one user must be defined",
		}),
	})
	.refine((data) => data.default_web_user in data.users, {
		message: "default_web_user must reference a user defined in users",
	});

export type AllowlistConfig = z.infer<typeof allowlistSchema>;

// Model Backends Config
const modelBackendSchema = z.object({
	id: z.string().min(1),
	provider: z.enum(["ollama", "bedrock", "anthropic", "openai-compatible"]),
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
});

export const modelBackendsSchema = z
	.object({
		backends: z.array(modelBackendSchema).min(1, "At least one backend must be configured"),
		default: z.string().min(1),
		daily_budget_usd: z.number().min(0).optional(),
	})
	.refine((data) => data.backends.some((b) => b.id === data.default), {
		message: "default must reference a backend ID defined in backends",
	})
	.refine(
		(data) => {
			return data.backends.every((b) => {
				if (b.provider === "ollama" || b.provider === "openai-compatible") {
					return b.base_url !== undefined;
				}
				return true;
			});
		},
		{ message: "ollama and openai-compatible providers require base_url" },
	);

export type ModelBackendsConfig = z.infer<typeof modelBackendsSchema>;

// Optional Configs
export const networkSchema = z.object({
	allowedUrlPrefixes: z.array(z.string()),
	allowedMethods: z.array(z.string()),
	transform: z
		.array(
			z.object({
				url: z.string(),
				headers: z.record(z.string(), z.string()),
			}),
		)
		.optional(),
});

export type NetworkConfig = z.infer<typeof networkSchema>;

export const discordSchema = z.object({
	bot_token: z.string().min(1),
	host: z.string().min(1),
});

export type DiscordConfig = z.infer<typeof discordSchema>;

export const relaySchema = z.object({
	enabled: z.boolean().default(true),
	max_payload_bytes: z.number().int().positive().default(2 * 1024 * 1024),
	request_timeout_ms: z.number().int().positive().default(30_000),
	prune_interval_seconds: z.number().int().positive().default(60),
	prune_retention_seconds: z.number().int().positive().default(300),
	eager_push: z.boolean().default(true),
	drain_timeout_seconds: z.number().int().positive().default(120),
});

export type RelayConfig = z.infer<typeof relaySchema>;

export const syncSchema = z.object({
	hub: z.string().min(1),
	sync_interval_seconds: z.number().int().positive().default(30),
	relay: relaySchema.optional(),
});

export type SyncConfig = z.infer<typeof syncSchema>;

export const keyringSchema = z.object({
	hosts: z.record(
		z.string(),
		z.object({
			public_key: z.string().min(1),
			url: z.string().url(),
		}),
	),
});

export type KeyringConfig = z.infer<typeof keyringSchema>;

export const mcpSchema = z.object({
	servers: z.array(
		z.object({
			name: z.string().min(1),
			command: z.string().optional(),
			args: z.array(z.string()).optional(),
			url: z.string().optional(),
			transport: z.enum(["stdio", "http"]),
			headers: z.record(z.string(), z.string()).optional(),
			allow_tools: z.array(z.string()).optional(),
			confirm: z.array(z.string()).optional(),
		}),
	),
});

export type McpConfig = z.infer<typeof mcpSchema>;

export const overlaySchema = z.object({
	mounts: z.record(z.string(), z.string()),
});

export type OverlayConfig = z.infer<typeof overlaySchema>;

export const cronSchedulesSchema = z.record(
	z.string(),
	z.object({
		schedule: z.string().min(1),
		thread: z.string().optional(),
		payload: z.string().optional(),
		template: z.array(z.string()).optional(),
		requires: z.array(z.string()).optional(),
		model_hint: z.string().optional(),
	}),
);

export type CronSchedulesConfig = z.infer<typeof cronSchedulesSchema>;

// Config type union
export type ConfigType =
	| AllowlistConfig
	| ModelBackendsConfig
	| NetworkConfig
	| DiscordConfig
	| SyncConfig
	| KeyringConfig
	| McpConfig
	| OverlayConfig
	| CronSchedulesConfig;

// Schema map for programmatic validation
export const configSchemaMap = {
	"allowlist.json": allowlistSchema,
	"model_backends.json": modelBackendsSchema,
	"network.json": networkSchema,
	"discord.json": discordSchema,
	"sync.json": syncSchema,
	"keyring.json": keyringSchema,
	"mcp.json": mcpSchema,
	"overlay.json": overlaySchema,
	"cron_schedules.json": cronSchedulesSchema,
} as const;
