import type { Database } from "bun:sqlite";
import { createChangeLogEntry } from "@bound/core";
import type { PlatformConnectorConfig } from "@bound/shared";
import type { PlatformConnector } from "./connector.js";

/**
 * Manages which host is the active connector leader for one platform.
 *
 * On start():
 *   - If no leader exists in cluster_config, this host claims leadership (LWW race).
 *   - If this host is already leader, it reclaims (idempotent).
 *   - If another host is leader, enter standby and poll for staleness.
 *
 * Heartbeat: leader bumps hosts.modified_at every failover_threshold_ms / 3.
 * Failover: standby promotes if leader's modified_at is older than failover_threshold_ms.
 */
export class PlatformLeaderElection {
	private isLeaderFlag = false;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private stalenessTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		public readonly connector: PlatformConnector,
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly hostBaseUrl?: string,
	) {}

	async start(): Promise<void> {
		const leaderKey = `platform_leader:${this.connector.platform}`;
		const existing = this.db
			.query<{ value: string }, [string]>("SELECT value FROM cluster_config WHERE key = ? LIMIT 1")
			.get(leaderKey);

		if (!existing || existing.value === this.siteId) {
			await this.claimLeadership(leaderKey);
		} else {
			this.startStalenessCheck(leaderKey);
		}
	}

	stop(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.stalenessTimer) {
			clearInterval(this.stalenessTimer);
			this.stalenessTimer = null;
		}
		if (this.isLeaderFlag) {
			this.connector.disconnect().catch(() => {
				// Disconnect errors are non-fatal during shutdown
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
			this.db.run(
				"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
				[leaderKey, this.siteId, now],
			);
			createChangeLogEntry(this.db, "cluster_config", leaderKey, this.siteId, {
				key: leaderKey,
				value: this.siteId,
				modified_at: now,
			});
		})();

		this.isLeaderFlag = true;
		await this.connector.connect(this.hostBaseUrl);

		// Heartbeat: bump hosts.modified_at every failover_threshold_ms / 3.
		// The hosts table PK is site_id (not id), so updateRow() cannot be used.
		// Use manual SQL + change_log entry following the same pattern as claimLeadership().
		const heartbeatInterval = Math.floor(this.config.failover_threshold_ms / 3);
		this.heartbeatTimer = setInterval(() => {
			try {
				const ts = new Date().toISOString();
				this.db.transaction(() => {
					this.db.run("UPDATE hosts SET modified_at = ? WHERE site_id = ?", [ts, this.siteId]);
					// Read full row for changelog — partial row_data breaks LWW INSERT on peers
					const fullRow = this.db
						.query("SELECT * FROM hosts WHERE site_id = ?")
						.get(this.siteId) as Record<string, unknown>;
					createChangeLogEntry(this.db, "hosts", this.siteId, this.siteId, fullRow);
				})();
			} catch {
				// DB write failure is non-fatal — next heartbeat will retry
			}
		}, heartbeatInterval);
	}

	private startStalenessCheck(leaderKey: string): void {
		this.isLeaderFlag = false;
		const checkInterval = Math.floor(this.config.failover_threshold_ms / 3);

		this.stalenessTimer = setInterval(async () => {
			// Read current leader's modified_at from hosts table
			const row = this.db
				.query<{ modified_at: string }, [string]>(
					"SELECT h.modified_at FROM cluster_config cc JOIN hosts h ON h.site_id = cc.value WHERE cc.key = ? AND h.deleted = 0 LIMIT 1",
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
