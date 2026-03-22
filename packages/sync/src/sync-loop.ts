import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, Result, SyncConfig, TypedEventEmitter } from "@bound/shared";
import { err, ok } from "@bound/shared";
import {
	type Changeset,
	deserializeChangeset,
	fetchOutboundChangeset,
	serializeChangeset,
} from "./changeset.js";
import { incrementSyncErrors, resetSyncErrors, updatePeerCursor } from "./peer-cursor.js";
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
	constructor(
		private db: Database,
		private siteId: string,
		private privateKey: CryptoKey,
		private hubUrl: string,
		private logger: Logger,
		private eventBus: TypedEventEmitter,
	) {}

	async syncCycle(): Promise<Result<SyncResult, SyncError>> {
		const startTime = Date.now();
		let pushed = 0;
		let pulled = 0;

		try {
			// PUSH: send outbound events to hub
			const outbound = fetchOutboundChangeset(this.db, this.siteId, this.siteId);
			if (outbound.events.length > 0) {
				const pushResult = await this.push(outbound);
				if (!pushResult.ok) {
					return pushResult;
				}
				pushed = outbound.events.length;
				updatePeerCursor(this.db, this.siteId, { last_sent: outbound.source_seq_end });
			}

			// PULL: fetch inbound events from hub
			const syncState = this.db
				.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
				.get(this.siteId) as { last_received: number } | undefined;
			const sinceSeq = syncState?.last_received ?? 0;

			const pullResult = await this.pull(sinceSeq);
			if (!pullResult.ok) {
				return pullResult;
			}

			const inbound = pullResult.value;
			pulled = inbound.events.length;
			const newLastReceived = inbound.events.length > 0 ? inbound.source_seq_end : sinceSeq;

			// ACK: confirm receipt
			const ackResult = await this.ack(newLastReceived);
			if (!ackResult.ok) {
				return ackResult;
			}

			// Update cursor and reset errors
			updatePeerCursor(this.db, this.siteId, { last_received: newLastReceived });
			resetSyncErrors(this.db, this.siteId);

			const duration = Date.now() - startTime;

			this.eventBus.emit("sync:completed", {
				pushed,
				pulled,
				duration_ms: duration,
			});

			return ok({ pushed, pulled, duration_ms: duration });
		} catch (error) {
			incrementSyncErrors(this.db, this.siteId);
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

	const startLoop = () => {
		if (stopped) return;

		timerId = setInterval(async () => {
			if (stopped) return;
			await client.syncCycle();
		}, intervalSeconds * 1000);
	};

	startLoop();

	return {
		stop: () => {
			stopped = true;
			if (timerId) clearInterval(timerId);
		},
	};
}

export function resolveHubUrl(
	db: Database,
	syncConfig: SyncConfig,
	_keyring: KeyringConfig,
): string {
	// Check cluster_config.cluster_hub first
	const clusterHub = db.query('SELECT value FROM cluster_config WHERE key = "cluster_hub"').get() as
		| { value: string }
		| undefined;

	if (clusterHub) {
		return clusterHub.value;
	}

	// Fall back to sync.json
	return syncConfig.hub;
}
