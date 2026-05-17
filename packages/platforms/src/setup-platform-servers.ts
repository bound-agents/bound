import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { createDiscordServer } from "./connectors/discord-server.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

// biome-ignore lint/suspicious/noExplicitAny: discord.js Client type from dynamic import
type DiscordClient = any;

/**
 * Factory that constructs a fully-configured Discord.js Client instance.
 * Default implementation dynamically imports discord.js and builds the
 * Client with the intents/partials this codebase expects. Tests inject a
 * fake to bypass the discord.js dependency and assert call ordering.
 */
export type DiscordClientFactory = () => Promise<DiscordClient>;

const defaultDiscordClientFactory: DiscordClientFactory = async () => {
	// Dynamically import discord.js so it isn't a hard dependency for paths
	// that never wire Discord (CLI without a discord connector configured).
	// biome-ignore lint/suspicious/noExplicitAny: dynamic module import
	const discordJs = (await import("discord.js")) as any;

	return new discordJs.Client({
		intents: [
			discordJs.GatewayIntentBits.DirectMessages,
			discordJs.GatewayIntentBits.MessageContent,
			discordJs.GatewayIntentBits.Guilds,
		],
		partials: [discordJs.Partials.Channel, discordJs.Partials.Message, discordJs.Partials.Reaction],
	});
};

/**
 * Wire discord.js gateway lifecycle events to the structured logger.
 * Registered before login() so the initial `ready` event is captured.
 */
function wireGatewayLifecycleLogging(client: DiscordClient, logger: Logger): void {
	client.on("ready", () => {
		logger.info("[discord] Gateway ready", {
			username: client.user?.tag ?? "unknown",
			userId: client.user?.id ?? "unknown",
		});
	});

	client.on("error", (err: Error) => {
		logger.error("[discord] Gateway error", { error: String(err) });
	});

	client.on("warn", (info: string) => {
		logger.warn("[discord] Gateway warning", { message: info });
	});

	client.on("shardDisconnect", (event: { code: number }, shardId: number) => {
		logger.warn("[discord] Shard disconnected", { shardId, code: event.code });
	});

	client.on("shardReconnecting", (shardId: number) => {
		logger.info("[discord] Shard reconnecting", { shardId });
	});

	client.on("shardResume", (shardId: number, replayedEvents: number) => {
		logger.info("[discord] Shard resumed", { shardId, replayedEvents });
	});

	client.on("invalidated", () => {
		logger.error("[discord] Session invalidated — manual restart may be required");
	});
}

/**
 * Sets up Discord MCP servers for a given platform connector config.
 * Handles Discord.js client creation and server registration.
 * Encapsulates the Discord.js dependency so it's only imported when needed.
 *
 * @param config Platform connector configuration
 * @param registry MCP registry to register servers with
 * @param logger Logger instance
 * @param clientFactory Optional Client factory for testing. Production code
 *   should not pass this — the default constructs a real discord.js Client.
 */
export async function setupDiscordServers(
	config: PlatformConnectorConfig,
	registry: PlatformMcpRegistry,
	logger: Logger,
	clientFactory: DiscordClientFactory = defaultDiscordClientFactory,
): Promise<void> {
	if (config.platform !== "discord" && config.platform !== "discord-interaction") {
		return; // Not a Discord connector
	}

	try {
		const discordClient = await clientFactory();

		wireGatewayLifecycleLogging(discordClient, logger);

		// Login MUST happen before tool registration. Previously the order
		// was registerServer → login, which left a half-initialized failure
		// mode: if login() rejected (invalid token, network blip during a
		// leader-election window, etc.), the outer for-loop in
		// packages/cli/src/commands/start/server.ts:848-862 caught with a
		// `warn` and continued — but the prior registerServer() call had
		// already exposed the tool to the cluster relay, pointing at a
		// Client whose rest._token was never set. Every subsequent
		// `discord_list_channels` call surfaced "Expected token to be set
		// for this request, but none was present" via the now-correct
		// error-propagation path (commit 8f55bd7).
		//
		// New order: login fails fast before registration. If it rejects,
		// the outer catch swallows + skips, leaving callers with "tool not
		// found" (correct: discord isn't wired here on this leader) instead
		// of the misleading half-init "token not set" symptom.
		await discordClient.login(config.token);

		const server = createDiscordServer(config, discordClient, logger);
		await registry.registerServer(config.platform, server);

		logger.info(`[platforms-mcp] Discord server registered for '${config.platform}'`);
	} catch (err) {
		logger.error("[platforms-mcp] Failed to setup Discord server", {
			platform: config.platform,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}
