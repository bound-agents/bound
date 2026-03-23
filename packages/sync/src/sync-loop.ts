import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, Result, SyncConfig, TypedEventEmitter } from "@bound/shared";
import { err, ok } from "@bound/shared";
import {
	type Changeset,
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

export interface SyncResult {
	pushed: number;
	pulled: number;
	duration_ms: number;
}

export interface SyncError {
	phase: "push" | "pull" | "ack";
	status?: number;
	message: string;
}

export class SyncClient {
	private hubSiteId: string | null = null;

	constructor(
		private db: Database,
		private siteId: string,
		private privateKey: CryptoKey,
		private hubUrl: string,
		private logger: Logger,
		private eventBus: TypedEventEmitter,
		private keyring: KeyringConfig,
	) {
		// Resolve hub's site_id from keyring
		this.hubSiteId = this.resolveHubSiteId();
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

		// Use hub's site_id for peer cursor tracking
		const peerSiteId = this.hubSiteId ?? this.siteId;

		try {
			// PUSH: send outbound events to hub
			const outbound = fetchOutboundChangeset(this.db, peerSiteId, this.siteId);
			if (outbound.events.length > 0) {
				const pushResult = await this.push(outbound);
				if (!pushResult.ok) {
					return pushResult;
				}
				pushed = outbound.events.length;
				updatePeerCursor(this.db, peerSiteId, { last_sent: outbound.source_seq_end });
			}

			// PULL: fetch inbound events from hub
			const syncState = this.db
				.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
				.get(peerSiteId) as { last_received: number } | undefined;
			const sinceSeq = syncState?.last_received ?? 0;

			const pullResult = await this.pull(sinceSeq);
			if (!pullResult.ok) {
				return pullResult;
			}

			const inbound = pullResult.value;
			pulled = inbound.events.length;
			const newLastReceived = inbound.events.length > 0 ? inbound.source_seq_end : sinceSeq;

			// REPLAY: apply inbound events to local database
			if (inbound.events.length > 0) {
				replayEvents(this.db, inbound.events);
			}

			// ACK: confirm receipt
			const ackResult = await this.ack(newLastReceived);
			if (!ackResult.ok) {
				return ackResult;
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

			return ok({ pushed, pulled, duration_ms: duration });
		} catch (error) {
			incrementSyncErrors(this.db, peerSiteId);

			// Check if we've reached the alert threshold per spec R-E16
			const syncState = getPeerCursor(this.db, peerSiteId);
			if (syncState && syncState.sync_errors >= 5) {
				// TODO: Persist alert to system thread once system thread concept is implemented
				this.logger.warn(
					`Sync failures have reached threshold (${syncState.sync_errors} errors) for peer ${peerSiteId}`,
				);
			}

			const message = error instanceof Error ? error.message : "Unknown error";
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
			const message = error instanceof Error ? error.message : "Unknown error";
			return err({
				phase: "push",
				message,
			});
		}
	}

	private async pull(sinceSeq: number): Promise<Result<Changeset, SyncError>> {
		try {
			const body = JSON.stringify({ since_seq: sinceSeq });
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
			const message = error instanceof Error ? error.message : "Unknown error";
			return err({
				phase: "pull",
				message,
			});
		}
	}

	private async ack(lastReceived: number): Promise<Result<void, SyncError>> {
		try {
			const body = JSON.stringify({ last_received: lastReceived });
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
			const message = error instanceof Error ? error.message : "Unknown error";
			return err({
				phase: "ack",
				message,
			});
		}
	}
}

export function startSyncLoop(client: SyncClient, intervalSeconds: number): { stop: () => void } {
	let timerId: Timer | null = null;
	let stopped = false;
	let consecutiveFailures = 0;
	const maxIntervalMs = 5 * 60 * 1000; // 5 minutes per spec §8.6

	const startLoop = () => {
		if (stopped) return;

		const runSync = async () => {
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
			timerId = setTimeout(runSync, nextIntervalMs);
		};

		runSync();
	};

	startLoop();

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
