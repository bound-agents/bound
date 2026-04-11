import type { Database } from "bun:sqlite";
import {
	insertInbox,
	insertRow,
	markDelivered,
	readUndelivered,
	recordRelayCycle,
} from "@bound/core";
import type { KeyringConfig, Logger, Result, SyncConfig, TypedEventEmitter } from "@bound/shared";
import { RELAY_RESPONSE_KINDS, err, formatError, ok } from "@bound/shared";
import {
	type Changeset,
	type RelayRequest,
	type RelayResponse,
	chunkChangeset,
	deserializeChangeset,
	fetchOutboundChangeset,
	serializeChangeset,
} from "./changeset.js";
import {
	getPeerCursor,
	incrementSyncErrors,
	resetSyncErrors,
	updatePeerCursor,
} from "./peer-cursor.js";
import { replayEvents } from "./reducers.js";
import { signRequest } from "./signing.js";
import type { SyncTransport } from "./transport.js";

export interface RelayResult {
	sent: number;
	received: number;
	draining: boolean;
}

export interface SyncResult {
	pushed: number;
	pulled: number;
	relay?: RelayResult;
	duration_ms: number;
}

export interface SyncError {
	phase: "push" | "pull" | "ack" | "relay";
	status?: number;
	message: string;
}

export class SyncClient {
	private hubSiteId: string | null = null;
	private relayDraining = false;

	constructor(
		private db: Database,
		private siteId: string,
		private privateKey: CryptoKey,
		private hubUrl: string,
		private logger: Logger,
		private eventBus: TypedEventEmitter,
		private keyring: KeyringConfig,
		private transport?: SyncTransport,
	) {
		// Resolve hub's site_id from keyring
		this.hubSiteId = this.resolveHubSiteId();
	}

	updateHubUrl(newHubUrl: string): void {
		this.hubUrl = newHubUrl;
		this.hubSiteId = this.resolveHubSiteId();
		this.relayDraining = false;
	}

	private resolveHubSiteId(): string | null {
		// Find the site_id in keyring that matches our hubUrl
		for (const [siteId, hostConfig] of Object.entries(
			this.keyring.hosts as Record<string, { public_key: string; url: string }>,
		)) {
			if (hostConfig.url === this.hubUrl) {
				return siteId;
			}
		}
		return null;
	}

	async syncCycle(): Promise<Result<SyncResult, SyncError>> {
		const startTime = Date.now();
		let pushed = 0;
		let pulled = 0;
		let relayResult: RelayResult | undefined;

		// Use hub's site_id for peer cursor tracking
		const peerSiteId = this.hubSiteId ?? this.siteId;

		try {
			// PUSH: send outbound events to hub (chunked for large changesets)
			const outbound = fetchOutboundChangeset(this.db, peerSiteId, this.siteId);
			if (outbound.events.length > 0) {
				const chunks = chunkChangeset(outbound);
				if (chunks.length > 1) {
					this.logger.info(
						`Chunking push: ${outbound.events.length} events into ${chunks.length} chunks`,
					);
				}
				for (const chunk of chunks) {
					const pushResult = await this.push(chunk);
					if (!pushResult.ok) {
						return pushResult;
					}
					pushed += chunk.events.length;
					// Advance cursor after each chunk so partial failure is resumable
					updatePeerCursor(this.db, peerSiteId, { last_sent: chunk.source_hlc_end });
				}
			}

			// PULL: fetch inbound events from hub
			const syncState = this.db
				.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
				.get(peerSiteId) as { last_received: string } | undefined;
			const sinceHlc = syncState?.last_received ?? "0000-00-00T00:00:00.000Z_0000_0000";

			const pullResult = await this.pull(sinceHlc);
			if (!pullResult.ok) {
				return pullResult;
			}

			const inbound = pullResult.value;
			pulled = inbound.events.length;
			const newLastReceived = inbound.events.length > 0 ? inbound.source_hlc_end : sinceHlc;

			// REPLAY: apply inbound events to local database
			if (inbound.events.length > 0) {
				replayEvents(this.db, inbound.events);
			}

			// ACK: confirm receipt
			const ackResult = await this.ack(newLastReceived);
			if (!ackResult.ok) {
				return ackResult;
			}

			// RELAY: exchange relay messages with hub
			const relayPhaseResult = await this.relay();
			if (!relayPhaseResult.ok) {
				this.logger.warn("Relay phase failed", { error: relayPhaseResult.error });
				// Relay failure is non-fatal — sync still succeeds
			} else {
				relayResult = relayPhaseResult.value;
			}

			// Update cursor and reset errors
			updatePeerCursor(this.db, peerSiteId, { last_received: newLastReceived });
			resetSyncErrors(this.db, peerSiteId);

			const duration = Date.now() - startTime;

			this.eventBus.emit("sync:completed", {
				pushed,
				pulled,
				duration_ms: duration,
			});

			return ok({ pushed, pulled, relay: relayResult, duration_ms: duration });
		} catch (error) {
			incrementSyncErrors(this.db, peerSiteId);

			// Check if we've reached the alert threshold per spec R-E16
			const syncState = getPeerCursor(this.db, peerSiteId);
			if (syncState && syncState.sync_errors >= 5) {
				this.logger.warn(
					`Sync failures have reached threshold (${syncState.sync_errors} errors) for peer ${peerSiteId}`,
				);
				// Persist alert to database for visibility
				try {
					const { randomUUID } = await import("node:crypto");
					const { deterministicUUID, BOUND_NAMESPACE } = await import("@bound/shared");
					const systemThreadId = deterministicUUID(BOUND_NAMESPACE, "system-alerts");
					const now = new Date().toISOString();

					// Use insertRow to ensure alerts sync to other hosts
					insertRow(
						this.db,
						"threads",
						{
							id: systemThreadId,
							user_id: "system",
							interface: "web",
							host_origin: this.siteId,
							color: 0,
							title: "System Alerts",
							summary: null,
							created_at: now,
							last_message_at: now,
							modified_at: now,
							deleted: 0,
						},
						this.siteId,
					);

					insertRow(
						this.db,
						"messages",
						{
							id: randomUUID(),
							thread_id: systemThreadId,
							role: "alert",
							content: `Sync to peer ${peerSiteId} has failed ${syncState.sync_errors} consecutive times`,
							model_id: null,
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: this.siteId,
							deleted: 0,
						},
						this.siteId,
					);
				} catch {
					// Non-fatal
				}
			}

			const message = formatError(error);
			this.logger.error(`Sync error: ${message}`);
			return err({
				phase: "push",
				message,
			});
		}
	}

	private async push(
		changeset: ReturnType<typeof fetchOutboundChangeset>,
	): Promise<Result<void, SyncError>> {
		try {
			const body = serializeChangeset(changeset);

			if (this.transport && this.hubSiteId) {
				const tr = await this.transport.send(
					"POST",
					`${this.hubUrl}/sync/push`,
					"/sync/push",
					body,
					this.hubSiteId,
				);
				if (tr.status !== 200) {
					return err({
						phase: "push",
						status: tr.status,
						message: `Push failed: ${tr.status}`,
					});
				}
				return ok(undefined);
			}

			const headers = await signRequest(this.privateKey, this.siteId, "POST", "/sync/push", body);

			const response = await fetch(`${this.hubUrl}/sync/push`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			if (!response.ok) {
				return err({
					phase: "push",
					status: response.status,
					message: `Push failed: ${response.statusText}`,
				});
			}

			return ok(undefined);
		} catch (error) {
			const message = formatError(error);
			return err({
				phase: "push",
				message,
			});
		}
	}

	private async pull(sinceHlc: string): Promise<Result<Changeset, SyncError>> {
		try {
			const body = JSON.stringify({ since_hlc: sinceHlc });

			if (this.transport && this.hubSiteId) {
				const tr = await this.transport.send(
					"POST",
					`${this.hubUrl}/sync/pull`,
					"/sync/pull",
					body,
					this.hubSiteId,
				);
				if (tr.status !== 200) {
					return err({
						phase: "pull",
						status: tr.status,
						message: `Pull failed: ${tr.status}`,
					});
				}
				const changesetResult = deserializeChangeset(tr.body);
				if (!changesetResult.ok) {
					return err({
						phase: "pull",
						message: "Failed to parse changeset response",
					});
				}
				return ok(changesetResult.value);
			}

			const headers = await signRequest(this.privateKey, this.siteId, "POST", "/sync/pull", body);

			const response = await fetch(`${this.hubUrl}/sync/pull`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			if (!response.ok) {
				return err({
					phase: "pull",
					status: response.status,
					message: `Pull failed: ${response.statusText}`,
				});
			}

			const json = await response.text();
			const changesetResult = deserializeChangeset(json);

			if (!changesetResult.ok) {
				return err({
					phase: "pull",
					message: "Failed to parse changeset response",
				});
			}

			return ok(changesetResult.value);
		} catch (error) {
			const message = formatError(error);
			return err({
				phase: "pull",
				message,
			});
		}
	}

	private async ack(lastReceived: string): Promise<Result<void, SyncError>> {
		try {
			const body = JSON.stringify({ last_received: lastReceived });

			if (this.transport && this.hubSiteId) {
				const tr = await this.transport.send(
					"POST",
					`${this.hubUrl}/sync/ack`,
					"/sync/ack",
					body,
					this.hubSiteId,
				);
				if (tr.status !== 200) {
					return err({
						phase: "ack",
						status: tr.status,
						message: `Ack failed: ${tr.status}`,
					});
				}
				return ok(undefined);
			}

			const headers = await signRequest(this.privateKey, this.siteId, "POST", "/sync/ack", body);

			const response = await fetch(`${this.hubUrl}/sync/ack`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			if (!response.ok) {
				return err({
					phase: "ack",
					status: response.status,
					message: `Ack failed: ${response.statusText}`,
				});
			}

			return ok(undefined);
		} catch (error) {
			const message = formatError(error);
			return err({
				phase: "ack",
				message,
			});
		}
	}

	async relay(): Promise<Result<RelayResult, SyncError>> {
		try {
			const outbox = readUndelivered(this.db);

			// Filter outbox entries based on relay_draining flag (AC4.2, AC4.3)
			let entriesToSend = outbox;
			if (this.relayDraining) {
				entriesToSend = outbox.filter(
					(entry) =>
						(RELAY_RESPONSE_KINDS as readonly string[]).includes(entry.kind) ||
						entry.kind === "cancel",
				);
			}

			const relayRequest: RelayRequest = {
				relay_outbox: entriesToSend,
			};

			const body = JSON.stringify(relayRequest);

			let relayResponse: RelayResponse;

			if (this.transport && this.hubSiteId) {
				const tr = await this.transport.send(
					"POST",
					`${this.hubUrl}/sync/relay`,
					"/sync/relay",
					body,
					this.hubSiteId,
				);
				if (tr.status !== 200) {
					return err({
						phase: "relay",
						status: tr.status,
						message: `Relay failed: ${tr.status}`,
					});
				}
				relayResponse = JSON.parse(tr.body) as RelayResponse;
			} else {
				const headers = await signRequest(
					this.privateKey,
					this.siteId,
					"POST",
					"/sync/relay",
					body,
				);

				const response = await fetch(`${this.hubUrl}/sync/relay`, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body,
				});

				if (!response.ok) {
					return err({
						phase: "relay",
						status: response.status,
						message: `Relay failed: ${response.statusText}`,
					});
				}

				relayResponse = (await response.json()) as RelayResponse;
			}

			// Update local drain state from hub response
			this.relayDraining = relayResponse.relay_draining;

			// Mark delivered
			if (relayResponse.relay_delivered.length > 0) {
				markDelivered(this.db, relayResponse.relay_delivered);
			}

			// Record outbound relay cycles
			for (const entry of entriesToSend) {
				try {
					recordRelayCycle(this.db, {
						direction: "outbound",
						peer_site_id: entry.target_site_id,
						kind: entry.kind,
						delivery_method: "sync",
						latency_ms: null,
						expired: false,
						success: true,
					});
				} catch {
					// Non-fatal if metrics recording fails
				}
			}

			// Insert inbox entries (INSERT OR IGNORE for dedup)
			let received = 0;
			for (const entry of relayResponse.relay_inbox) {
				const inserted = insertInbox(this.db, entry);
				if (inserted) received++;
				// Record inbound relay cycle
				try {
					recordRelayCycle(this.db, {
						direction: "inbound",
						peer_site_id: entry.source_site_id,
						kind: entry.kind,
						delivery_method: "sync",
						latency_ms: null,
						expired: false,
						success: true,
					});
				} catch {
					// Non-fatal if metrics recording fails
				}
			}

			return ok({
				sent: entriesToSend.length,
				received,
				draining: relayResponse.relay_draining,
			});
		} catch (error) {
			const message = formatError(error);
			return err({
				phase: "relay",
				message,
			});
		}
	}
}

export function startSyncLoop(
	client: SyncClient,
	intervalSeconds: number,
	eventBus?: TypedEventEmitter,
): { stop: () => void } {
	let timerId: Timer | null = null;
	let stopped = false;
	let consecutiveFailures = 0;
	const maxIntervalMs = 5 * 60 * 1000; // 5 minutes per spec §8.6

	const scheduleNext = async () => {
		if (stopped) return;

		const result = await client.syncCycle();

		if (!result.ok) {
			consecutiveFailures++;
		} else {
			consecutiveFailures = 0;
		}

		// Calculate backoff: min(initialInterval * 2^failures, 300000ms)
		const baseIntervalMs = intervalSeconds * 1000;
		const backoffMultiplier = 2 ** consecutiveFailures;
		const nextIntervalMs = Math.min(baseIntervalMs * backoffMultiplier, maxIntervalMs);

		// Use setTimeout recursion instead of setInterval to support dynamic intervals
		timerId = setTimeout(scheduleNext, nextIntervalMs);
	};

	// Listen for immediate sync trigger event
	if (eventBus) {
		eventBus.on("sync:trigger", async () => {
			if (stopped) return;
			if (timerId) {
				clearTimeout(timerId as unknown as number);
				timerId = null;
			}
			await scheduleNext();
		});
	}

	scheduleNext();

	return {
		stop: () => {
			stopped = true;
			if (timerId) clearTimeout(timerId as unknown as number);
		},
	};
}

export function resolveHubUrl(
	db: Database,
	syncConfig: SyncConfig,
	keyring: KeyringConfig,
): string {
	// Check cluster_config.cluster_hub first
	const clusterHub = db.query('SELECT value FROM cluster_config WHERE key = "cluster_hub"').get() as
		| { value: string }
		| undefined;

	if (clusterHub) {
		return clusterHub.value;
	}

	// Fall back to sync.json
	if (syncConfig.hub) {
		return syncConfig.hub;
	}

	// Last resort: try to find first host URL in keyring
	for (const hostConfig of Object.values(
		keyring.hosts as Record<string, { public_key: string; url: string }>,
	)) {
		if (hostConfig.url) {
			return hostConfig.url;
		}
	}

	throw new Error("Unable to resolve hub URL from config, sync.json, or keyring");
}
