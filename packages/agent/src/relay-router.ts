import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RelayOutboxEntry } from "@bound/shared";

export interface EligibleHost {
	site_id: string;
	host_name: string;
	sync_url: string | null;
	online_at: string | null;
}

export interface RelayRoutingResult {
	ok: true;
	hosts: EligibleHost[];
}

export interface RelayRoutingError {
	ok: false;
	error: string;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function findEligibleHosts(
	db: Database,
	toolCommandName: string,
	localSiteId: string,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, mcp_tools, online_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		mcp_tools: string | null;
		online_at: string | null;
	}>;

	const eligible: EligibleHost[] = [];
	for (const row of rows) {
		if (!row.mcp_tools) continue;
		const tools: string[] = JSON.parse(row.mcp_tools);
		if (!tools.includes(toolCommandName)) continue;
		eligible.push({
			site_id: row.site_id,
			host_name: row.host_name,
			sync_url: row.sync_url,
			online_at: row.online_at,
		});
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Tool "${toolCommandName}" not available on any remote host` };
	}

	// Sort by online_at descending (most recent first), nulls last
	eligible.sort((a, b) => {
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	return { ok: true, hosts: eligible };
}

export function isHostStale(host: EligibleHost): boolean {
	if (!host.online_at) return true;
	return Date.now() - new Date(host.online_at).getTime() > STALE_THRESHOLD_MS;
}

export function findEligibleHostsByModel(
	db: Database,
	modelId: string,
	localSiteId: string,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
	}>;

	const eligible: EligibleHost[] = [];
	for (const row of rows) {
		if (!row.models) continue;
		// Stale hosts are excluded (online_at older than STALE_THRESHOLD_MS)
		if (row.online_at) {
			const age = Date.now() - new Date(row.online_at).getTime();
			if (age > STALE_THRESHOLD_MS) continue;
		} else {
			continue; // No online_at means never seen — skip
		}
		let models: string[];
		try {
			models = JSON.parse(row.models);
		} catch {
			continue; // Malformed JSON — skip host
		}
		if (!models.includes(modelId)) continue;
		eligible.push({
			site_id: row.site_id,
			host_name: row.host_name,
			sync_url: row.sync_url,
			online_at: row.online_at,
		});
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Model "${modelId}" not available on any remote host` };
	}

	// Sort by online_at descending (most recent first)
	eligible.sort((a, b) => {
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	return { ok: true, hosts: eligible };
}

export function buildIdempotencyKey(
	kind: string,
	toolName: string,
	args: Record<string, unknown>,
): string {
	const roundedTimestamp = Math.floor(Date.now() / 60_000) * 60_000;
	const data = JSON.stringify({ kind, toolName, args, ts: roundedTimestamp });
	return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

export function createRelayOutboxEntry(
	targetSiteId: string,
	kind: string,
	payload: string,
	timeoutMs: number,
	refId?: string,
	idempotencyKey?: string,
	streamId?: string,
): Omit<RelayOutboxEntry, "delivered"> {
	const now = new Date();
	return {
		id: crypto.randomUUID(),
		source_site_id: null,
		target_site_id: targetSiteId,
		kind,
		ref_id: refId ?? null,
		idempotency_key: idempotencyKey ?? null,
		stream_id: streamId ?? null,
		payload,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
	};
}
