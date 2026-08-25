import type { Database } from "bun:sqlite";
import { createChangeLogEntry } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";

// NOTE: Host heartbeat (hosts.modified_at) is handled by startHostHeartbeat() in @bound/core.
// This class only manages platform leader election via cluster_config.

/**
 * Manages which host is the active connector leader for one platform.
 *
 * On start():
 *   - If no leader exists in cluster_config, this host claims leadership (LWW race).
 *   - If this host is already leader, it reclaims (idempotent).
 *   - If another host is leader, enter standby and poll for staleness.
 *
 * Failover: standby promotes if leader's modified_at is older than failover_threshold_ms.
 * (Host heartbeat is handled separately by startHostHeartbeat in @bound/core.)
 */
export class PlatformLeaderElection {
	private isLeaderFlag = false;
	private stalenessTimer: ReturnType<typeof setInterval> | null = null;
	private ownershipTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		public readonly connector: {
			platform: string;
			connect?: (url?: string) => Promise<void>;
			disconnect?: () => Promise<void>;
		},
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly hostBaseUrl?: string,
		private readonly logger?: Pick<Logger, "warn">,
	) {}

	async start(): Promise<void> {
		const leaderKey = `platform_leader:${this.connector.platform}`;
		const existing = this.db
			.query<{ value: string }, [string]>(
				"SELECT value FROM cluster_config WHERE key = ? AND deleted = 0 LIMIT 1",
			)
			.get(leaderKey);

		if (!existing || existing.value === this.siteId) {
			await this.claimLeadership(leaderKey);
		} else {
			this.startStalenessCheck(leaderKey);
		}
	}

	stop(): void {
		if (this.stalenessTimer) {
			clearInterval(this.stalenessTimer);
			this.stalenessTimer = null;
		}
		if (this.ownershipTimer) {
			clearInterval(this.ownershipTimer);
			this.ownershipTimer = null;
		}
		if (this.isLeaderFlag) {
			this.connector.disconnect?.().catch((error) => {
				this.logDisconnectFailure("shutdown", error);
			});
		}
		this.isLeaderFlag = false;
	}

	isLeader(): boolean {
		return this.isLeaderFlag;
	}

	private async claimLeadership(leaderKey: string): Promise<void> {
		const now = new Date().toISOString();

		// Write self as leader using INSERT OR REPLACE + manual change_log entry.
		// cluster_config uses `key` as its PK (not `id`), so insertRow/updateRow cannot be used.
		// Follow the pattern from packages/cli/src/commands/set-hub.ts.
		this.db.transaction(() => {
			// ON CONFLICT resets deleted = 0 so re-claiming a previously soft-deleted
			// leader key un-tombstones it (otherwise the live-filtered read can't see it).
			this.db.run(
				"INSERT INTO cluster_config (key, value, modified_at, deleted) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at, deleted = 0", // outbox-routed: explicit createChangeLogEntry follows the INSERT...CONFLICT in this transaction (cluster_config leader election)
				[leaderKey, this.siteId, now],
			);
			createChangeLogEntry(this.db, "cluster_config", leaderKey, this.siteId, {
				key: leaderKey,
				value: this.siteId,
				modified_at: now,
				deleted: 0,
			});
		})();

		this.isLeaderFlag = true;
		await this.connector.connect?.(this.hostBaseUrl);
		this.startOwnershipWatch(leaderKey);
	}

	/**
	 * While leader, periodically verify this host still owns the seat.
	 *
	 * Without this, leadership loss is invisible to the deposed leader: a host
	 * that sleeps past failover_threshold_ms gets replaced via the standby
	 * staleness path, then wakes still believing it is leader — two hosts run
	 * the platform concurrently (dual pollers racing LWW cursors, duplicate
	 * intake). On loss, disconnect the connector and re-enter standby so this
	 * host can promote again later through the normal staleness path.
	 */
	private startOwnershipWatch(leaderKey: string): void {
		const checkInterval = Math.floor(this.config.failover_threshold_ms / 3);

		this.ownershipTimer = setInterval(async () => {
			const row = this.db
				.query<{ value: string }, [string]>(
					"SELECT value FROM cluster_config WHERE key = ? AND deleted = 0 LIMIT 1",
				)
				.get(leaderKey);

			// Row missing or still naming us: keep serving. (A vanished row is
			// not evidence of a rival — the next standby anywhere would simply
			// claim; stepping down here would leave the platform leaderless.)
			if (!row || row.value === this.siteId) return;

			// Another site holds the seat — LWW replaced us while we weren't
			// looking (typically: this host slept past the failover threshold).
			if (this.ownershipTimer !== null) {
				clearInterval(this.ownershipTimer);
			}
			this.ownershipTimer = null;
			this.isLeaderFlag = false;
			try {
				await this.connector.disconnect?.();
			} catch (error) {
				this.logDisconnectFailure("ownership_replaced", error);
			}
			this.startStalenessCheck(leaderKey);
		}, checkInterval);
	}

	private logDisconnectFailure(reason: "shutdown" | "ownership_replaced", error: unknown): void {
		this.logger?.warn("Platform leader connector disconnect failed", {
			platform: this.connector.platform,
			site_id: this.siteId,
			reason,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	private startStalenessCheck(leaderKey: string): void {
		this.isLeaderFlag = false;
		const checkInterval = Math.floor(this.config.failover_threshold_ms / 3);

		this.stalenessTimer = setInterval(async () => {
			// Read current leader's modified_at from hosts table
			const row = this.db
				.query<{ modified_at: string }, [string]>(
					"SELECT h.modified_at FROM cluster_config cc JOIN hosts h ON h.site_id = cc.value WHERE cc.key = ? AND cc.deleted = 0 AND h.deleted = 0 LIMIT 1",
				)
				.get(leaderKey);

			if (!row) {
				// Leader host record gone — take over
				if (this.stalenessTimer !== null) {
					clearInterval(this.stalenessTimer);
				}
				this.stalenessTimer = null;
				await this.claimLeadership(leaderKey);
				return;
			}

			const leaderAgeMs = Date.now() - new Date(row.modified_at).getTime();
			if (leaderAgeMs > this.config.failover_threshold_ms) {
				if (this.stalenessTimer !== null) {
					clearInterval(this.stalenessTimer);
				}
				this.stalenessTimer = null;
				await this.claimLeadership(leaderKey);
			}
		}, checkInterval);
	}
}
