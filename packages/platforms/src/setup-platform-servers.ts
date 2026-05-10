import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { createDiscordServer } from "./connectors/discord-server.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

// biome-ignore lint/suspicious/noExplicitAny: discord.js Client type from dynamic import
type DiscordClient = any;

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
 */
export async function setupDiscordServers(
	config: PlatformConnectorConfig,
	registry: PlatformMcpRegistry,
	logger: Logger,
): Promise<void> {
	if (config.platform !== "discord" && config.platform !== "discord-interaction") {
		return; // Not a Discord connector
	}

	try {
		// Dynamically import discord.js to avoid hard dependency in CLI
		// biome-ignore lint/suspicious/noExplicitAny: dynamic module import
		const discordJs = (await import("discord.js")) as any;

		const discordClient = new discordJs.Client({
			intents: [
				discordJs.GatewayIntentBits.DirectMessages,
				discordJs.GatewayIntentBits.MessageContent,
				discordJs.GatewayIntentBits.Guilds,
			],
			partials: [
				discordJs.Partials.Channel,
				discordJs.Partials.Message,
				discordJs.Partials.Reaction,
			],
		});

		wireGatewayLifecycleLogging(discordClient, logger);

		const server = createDiscordServer(config, discordClient, logger);
		await registry.registerServer(config.platform, server);
		await discordClient.login(config.token);

		logger.info(`[platforms-mcp] Discord server registered for '${config.platform}'`);
	} catch (err) {
		logger.error("[platforms-mcp] Failed to setup Discord server", {
			platform: config.platform,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}
