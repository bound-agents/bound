import type { PlatformConnectorConfig, PlatformsConfig, TypedEventEmitter } from "@bound/shared";
import type { AppContext } from "@bound/core";
import { PlatformLeaderElection } from "./leader-election.js";
import type { PlatformConnector } from "./connector.js";
import { DiscordConnector } from "./connectors/discord.js";
import { WebhookStubConnector } from "./connectors/webhook-stub.js";

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

	constructor(
		private readonly ctx: AppContext,
		private readonly platformsConfig: PlatformsConfig,
		private readonly hostBaseUrl?: string,
	) {}

	start(): void {
		for (const connectorConfig of this.platformsConfig.connectors) {
			const connector = this.createConnector(connectorConfig);
			const election = new PlatformLeaderElection(
				connector,
				connectorConfig,
				this.ctx.db,
				this.ctx.siteId,
				this.hostBaseUrl,
			);
			this.elections.set(connectorConfig.platform, election);
			election.start().catch((err) => {
				this.ctx.logger.error(
					"Leader election failed to start",
					{ platform: connectorConfig.platform, error: String(err) },
				);
			});
		}

		// Route platform:deliver to the correct connector (leader only)
		this.ctx.eventBus.on("platform:deliver", (payload) => {
			const election = this.elections.get(payload.platform);
			if (!election?.isLeader()) return;
			election.connector
				.deliver(payload.thread_id, payload.message_id, payload.content, payload.attachments)
				.catch((err) => {
					this.ctx.logger.error(
						"Deliver failed",
						{ platform: payload.platform, error: String(err) },
					);
				});
		});

		// Route platform:webhook to the correct connector (leader only)
		this.ctx.eventBus.on("platform:webhook", (payload) => {
			const election = this.elections.get(payload.platform);
			if (!election?.isLeader()) return;
			election.connector.handleWebhookPayload?.(payload.rawBody, payload.headers).catch((err) => {
				this.ctx.logger.error(
					"Webhook handling failed",
					{ platform: payload.platform, error: String(err) },
				);
			});
		});
	}

	stop(): void {
		for (const election of this.elections.values()) {
			election.stop();
		}
		this.elections.clear();
	}

	private createConnector(config: PlatformConnectorConfig): PlatformConnector {
		switch (config.platform) {
			case "discord":
				return new DiscordConnector(
					config,
					this.ctx.db,
					this.ctx.siteId,
					this.ctx.eventBus,
					this.ctx.logger,
				);
			case "webhook-stub":
				return new WebhookStubConnector();
			default:
				throw new Error(`Unknown platform: ${config.platform}`);
		}
	}
}
