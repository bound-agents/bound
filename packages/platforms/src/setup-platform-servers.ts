import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { createDiscordServer } from "./connectors/discord-server.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";
import type { PlatformCommandSpec } from "./platform-commands.js";

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
			// GuildMessages is required for the gateway to fire messageCreate in
			// guild text channels. Guilds alone only delivers guild/channel
			// metadata, not message events — without this intent guild-channel
			// support is silently dead even though the code paths accept them.
			discordJs.GatewayIntentBits.GuildMessages,
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
		logger.error("[discord] Session invalidated — automatic re-login recovery engaged");
	});
}

/**
 * Tunables for gateway session recovery. Tests inject millisecond-scale
 * values; production uses the defaults below.
 */
export interface GatewayRecoveryOptions {
	/** Delay before the first re-login attempt; doubles per subsequent attempt. */
	initialDelayMs?: number;
	/** Re-login attempts per recovery round before giving up loudly. */
	maxAttempts?: number;
	/** How often the watchdog samples client readiness. */
	watchdogIntervalMs?: number;
	/** How long the client may sit not-ready before the watchdog fires recovery. */
	notReadyThresholdMs?: number;
}

const DEFAULT_RECOVERY: Required<GatewayRecoveryOptions> = {
	initialDelayMs: 5_000,
	maxAttempts: 5,
	watchdogIntervalMs: 60_000,
	notReadyThresholdMs: 5 * 60_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Self-healing for a Discord client whose gateway session dies while this
 * host still holds platform leadership.
 *
 * Why this exists (incident, 2026-07-24 → 2026-08-14): discord.js
 * auto-reconnects through transient `shardDisconnect`s, but an `invalidated`
 * session is TERMINAL — the library stops trying, permanently. The only
 * handler we had was a log line ("manual restart may be required"), and
 * leader election never consults gateway health, so the hub kept renewing
 * `platform_leader:mcp-platforms` for three weeks over a dead client: every
 * slash command surfaced "The application did not respond" and message
 * intake silently stopped, while from the cluster's view the leader looked
 * perfectly healthy.
 *
 * Two triggers feed one guarded recovery routine (destroy → backoff →
 * re-login, bounded attempts):
 *
 * 1. The `invalidated` event — the explicit terminal signal.
 * 2. A watchdog that samples `isReady()` — sessions can also die WITHOUT
 *    any event reaching userland (observed in the incident: no invalidated
 *    log line, just silence). A client not-ready past the threshold gets
 *    the same recovery.
 *
 * Exhausted recovery gives up loudly rather than hot-looping; the watchdog
 * re-arms it on a later cycle, so a long Discord outage retries with pacing
 * forever instead of requiring the manual restart the old log line asked for.
 */
function wireGatewaySessionRecovery(
	client: DiscordClient,
	token: string | undefined,
	logger: Logger,
	options?: GatewayRecoveryOptions,
): void {
	const opts = { ...DEFAULT_RECOVERY, ...options };
	let recovering = false;

	const recover = async (trigger: string): Promise<void> => {
		if (recovering) return;
		recovering = true;
		try {
			for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
				const delayMs = opts.initialDelayMs * 2 ** (attempt - 1);
				logger.warn("[discord] Gateway session recovery attempt", {
					trigger,
					attempt,
					maxAttempts: opts.maxAttempts,
					delayMs,
				});
				try {
					await client.destroy?.();
				} catch (err) {
					// A dead session's destroy() can reject; recovery proceeds anyway.
					logger.warn("[discord] destroy() failed during recovery (continuing)", {
						error: String(err),
					});
				}
				await sleep(delayMs);
				try {
					await client.login(token);
					logger.info("[discord] Gateway session recovered", { trigger, attempt });
					return;
				} catch (err) {
					logger.warn("[discord] Re-login failed during recovery", {
						attempt,
						error: String(err),
					});
				}
			}
			logger.error(
				"[discord] Gateway session recovery exhausted — watchdog will re-arm on a later cycle",
				{ trigger, attempts: opts.maxAttempts },
			);
		} finally {
			recovering = false;
		}
	};

	client.on("invalidated", () => {
		void recover("invalidated");
	});

	// Watchdog for silent deaths. Only wired when the client exposes
	// isReady() — without a health signal there is nothing to sample.
	if (typeof client.isReady === "function") {
		let notReadySince: number | null = null;
		const watchdog = setInterval(() => {
			if (recovering) return;
			if (client.isReady()) {
				notReadySince = null;
				return;
			}
			const now = Date.now();
			if (notReadySince === null) {
				notReadySince = now;
				return;
			}
			if (now - notReadySince >= opts.notReadyThresholdMs) {
				notReadySince = null;
				logger.warn("[discord] Watchdog: client not ready past threshold — firing recovery", {
					notReadyThresholdMs: opts.notReadyThresholdMs,
				});
				void recover("watchdog");
			}
		}, opts.watchdogIntervalMs);
		watchdog.unref?.();
	}
}

/**
 * Sets up Discord MCP servers for a given platform connector config.
 * Handles Discord.js client creation and server registration.
 * Encapsulates the Discord.js dependency so it's only imported when needed.
 *
 * @param config Platform connector configuration
 * @param registry MCP registry to register servers with
 * @param logger Logger instance
 * @param commands Platform command specs to register as Discord application
 *   commands and route deterministically (no inference) — see
 *   platform-commands.ts. Supplied by the wiring layer, which owns the
 *   domain logic the handlers close over.
 * @param clientFactory Optional Client factory for testing. Production code
 *   should not pass this — the default constructs a real discord.js Client.
 * @param recoveryOptions Gateway session recovery tunables (tests inject
 *   millisecond-scale values; production omits this for the defaults).
 */
export async function setupDiscordServers(
	config: PlatformConnectorConfig,
	registry: PlatformMcpRegistry,
	logger: Logger,
	commands?: PlatformCommandSpec[],
	clientFactory: DiscordClientFactory = defaultDiscordClientFactory,
	recoveryOptions?: GatewayRecoveryOptions,
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

		// Wired after the initial login so a config-level auth failure (bad
		// token) still fails fast through the ordering path above instead of
		// being silently retried forever by the recovery loop.
		wireGatewaySessionRecovery(discordClient, config.token, logger, recoveryOptions);

		const server = createDiscordServer(config, discordClient, logger, commands);
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
