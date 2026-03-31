import type { AppContext } from "@bound/core";
import type { PlatformConnectorConfig, PlatformsConfig } from "@bound/shared";
import type { PlatformConnector } from "./connector.js";
import { DiscordClientManager } from "./connectors/discord-client-manager.js";
import { DiscordInteractionConnector } from "./connectors/discord-interaction.js";
import { DiscordConnector } from "./connectors/discord.js";
import { WebhookStubConnector } from "./connectors/webhook-stub.js";
import { PlatformLeaderElection } from "./leader-election.js";

/**
 * Instantiates all configured platform connectors, starts their leader elections,
 * and routes "platform:deliver" and "platform:webhook" eventBus events to the
 * correct connector.
 *
 * Usage:
 *   const registry = new PlatformConnectorRegistry(ctx, platformsConfig);
 *   registry.start();
 *   // ... on shutdown:
 *   registry.stop();
 */
export class PlatformConnectorRegistry {
	private elections = new Map<string, PlatformLeaderElection>();
	private connectorsByPlatform = new Map<
		string,
		{ connector: PlatformConnector; electionKey: string }
	>();

	constructor(
		private readonly ctx: AppContext,
		private readonly platformsConfig: PlatformsConfig,
		private readonly hostBaseUrl?: string,
	) {}

	start(): void {
		for (const connectorConfig of this.platformsConfig.connectors) {
			if (connectorConfig.platform === "discord") {
				this.startDiscord(connectorConfig);
			} else {
				this.startSingleConnector(connectorConfig);
			}
		}

		// Route platform:deliver to the correct connector (leader only)
		this.ctx.eventBus.on("platform:deliver", (payload) => {
			const entry = this.connectorsByPlatform.get(payload.platform);
			if (!entry) return;
			const election = this.elections.get(entry.electionKey);
			if (!election?.isLeader()) return;
			entry.connector
				.deliver(payload.thread_id, payload.message_id, payload.content, payload.attachments)
				.catch((err) => {
					this.ctx.logger.error("Deliver failed", {
						platform: payload.platform,
						error: String(err),
					});
				});
		});

		// Route platform:webhook to the correct connector (leader only).
		// Note: For Discord, webhooks only route to the DM connector ("discord" key
		// in connectorsByPlatform). Interactions arrive via the gateway's interactionCreate
		// event, not webhooks, so "discord-interaction" never receives webhook events.
		this.ctx.eventBus.on("platform:webhook", (payload) => {
			const entry = this.connectorsByPlatform.get(payload.platform);
			if (!entry) return;
			const election = this.elections.get(entry.electionKey);
			if (!election?.isLeader()) return;
			entry.connector.handleWebhookPayload?.(payload.rawBody, payload.headers).catch((err) => {
				this.ctx.logger.error("Webhook handling failed", {
					platform: payload.platform,
					error: String(err),
				});
			});
		});
	}

	stop(): void {
		for (const election of this.elections.values()) {
			election.stop();
		}
		this.elections.clear();
		this.connectorsByPlatform.clear();
	}

	/**
	 * Look up a connector by platform name.
	 * Returns the connector instance regardless of whether it is currently the leader.
	 *
	 * @param platform - Platform identifier, e.g. "discord" or "discord-interaction"
	 * @returns The connector instance, or `undefined` if not registered.
	 */
	getConnector(platform: string): PlatformConnector | undefined {
		return this.connectorsByPlatform.get(platform)?.connector;
	}

	private createConnector(config: PlatformConnectorConfig): PlatformConnector {
		switch (config.platform) {
			case "webhook-stub":
				return new WebhookStubConnector();
			default:
				throw new Error(`Unknown platform: ${config.platform}`);
		}
	}

	private startDiscord(connectorConfig: PlatformConnectorConfig): void {
		const token = connectorConfig.token;
		if (!token) {
			throw new Error("Discord connector requires a token in platforms.json");
		}

		const clientManager = new DiscordClientManager(this.ctx.logger);

		const dmConnector = new DiscordConnector(
			connectorConfig,
			this.ctx.db,
			this.ctx.siteId,
			this.ctx.eventBus,
			this.ctx.logger,
			clientManager,
		);

		const interactionConnector = new DiscordInteractionConnector(
			connectorConfig,
			this.ctx.db,
			this.ctx.siteId,
			this.ctx.eventBus,
			this.ctx.logger,
			clientManager,
		);

		// Compound connector for the election — drives lifecycle for both
		const compoundConnector: PlatformConnector = {
			platform: "discord",
			delivery: "broadcast" as const,
			async connect(hostBaseUrl?: string): Promise<void> {
				await clientManager.connect(token);
				await dmConnector.connect(hostBaseUrl);
				await interactionConnector.connect(hostBaseUrl);
			},
			async disconnect(): Promise<void> {
				await interactionConnector.disconnect();
				await dmConnector.disconnect();
				await clientManager.disconnect();
			},
			async deliver(): Promise<void> {
				// Delivery routing handled by registry, not compound connector
			},
		};

		const election = new PlatformLeaderElection(
			compoundConnector,
			connectorConfig,
			this.ctx.db,
			this.ctx.siteId,
			this.hostBaseUrl,
		);

		this.elections.set("discord", election);
		this.connectorsByPlatform.set("discord", { connector: dmConnector, electionKey: "discord" });
		this.connectorsByPlatform.set("discord-interaction", {
			connector: interactionConnector,
			electionKey: "discord",
		});

		election.start().catch((err) => {
			this.ctx.logger.error("Leader election failed to start", {
				platform: "discord",
				error: String(err),
			});
		});
	}

	private startSingleConnector(connectorConfig: PlatformConnectorConfig): void {
		const connector = this.createConnector(connectorConfig);

		const election = new PlatformLeaderElection(
			connector,
			connectorConfig,
			this.ctx.db,
			this.ctx.siteId,
			this.hostBaseUrl,
		);

		this.elections.set(connectorConfig.platform, election);
		this.connectorsByPlatform.set(connectorConfig.platform, {
			connector,
			electionKey: connectorConfig.platform,
		});

		election.start().catch((err) => {
			this.ctx.logger.error("Leader election failed to start", {
				platform: connectorConfig.platform,
				error: String(err),
			});
		});
	}
}
