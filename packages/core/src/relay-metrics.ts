import type { Database } from "bun:sqlite";
import { dangerouslyExecuteRawWrite, updateRow } from "./change-log.js";

export interface RelayCycleEntry {
	direction: "outbound" | "inbound";
	peer_site_id: string;
	kind: string;
	delivery_method: "sync" | "eager_push";
	latency_ms: number | null;
	expired: boolean;
	success: boolean;
}

export function recordRelayCycle(db: Database, entry: RelayCycleEntry): void {
	db.run(
		`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, expired, success, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			entry.direction,
			entry.peer_site_id,
			entry.kind,
			entry.delivery_method,
			entry.latency_ms,
			entry.expired ? 1 : 0,
			entry.success ? 1 : 0,
			new Date().toISOString(),
		],
	);
}

export function recordTurnRelayMetrics(
	db: Database,
	turnId: string,
	relayTarget: string,
	relayLatencyMs: number,
	siteId?: string,
): void {
	if (siteId) {
		updateRow(
			db,
			"turns",
			turnId,
			{ relay_target: relayTarget, relay_latency_ms: relayLatencyMs },
			siteId,
		);
	} else {
		dangerouslyExecuteRawWrite(db, {
			sql: "UPDATE turns SET relay_target = ?, relay_latency_ms = ? WHERE id = ?",
			params: [relayTarget, relayLatencyMs, turnId],
			reason:
				"local-only instrumentation columns (turns.relay_target/relay_latency_ms); no siteId provided, per-host metrics not synced",
		});
	}
}

export function pruneRelayCycles(db: Database, retentionDays = 30): number {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
	const result = db.run("DELETE FROM relay_cycles WHERE created_at < ?", [cutoff]);
	return result.changes;
}
