import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createDiscordServer } from "./connectors/discord-server.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

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

		const server: Server = createDiscordServer(config, discordClient, logger);
		await registry.registerServer(config.platform, server);
		await discordClient.login(config.token);

		logger.info(`[platforms-mcp] Discord server registered for '${config.platform}'`);
	} catch (err) {
		logger.error(`[platforms-mcp] Failed to setup Discord server: ${err}`);
		throw err; // Re-throw so caller can handle the error
	}
}
