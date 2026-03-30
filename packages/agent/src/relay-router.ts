import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { CapabilityRequirements } from "@bound/llm";
import type { HostModelEntry, RelayOutboxEntry } from "@bound/shared";

export interface EligibleHost {
	site_id: string;
	host_name: string;
	sync_url: string | null;
	online_at: string | null;
	/** Capability metadata from the host's HostModelEntry. Present for verified hosts only. */
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
	/** Tier preference (lower = preferred). Present for verified hosts only. */
	tier?: number;
	/**
	 * Whether this host entry was parsed from legacy string format (no metadata).
	 * Unverified hosts are used as fallback when no verified match exists.
	 */
	unverified?: boolean;
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
	requirements?: CapabilityRequirements,
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

	const verified: EligibleHost[] = [];
	const unverified: EligibleHost[] = [];

	for (const row of rows) {
		if (!row.models) continue;
		// Stale hosts are excluded (online_at older than STALE_THRESHOLD_MS)
		if (row.online_at) {
			const age = Date.now() - new Date(row.online_at).getTime();
			if (age > STALE_THRESHOLD_MS) continue;
		} else {
			continue; // No online_at means never seen — skip
		}

		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch {
			continue; // Malformed JSON — skip host
		}

		if (!Array.isArray(rawModels)) continue;

		// Parse each entry as either a legacy string or a HostModelEntry object
		for (const entry of rawModels) {
			if (typeof entry === "string") {
				// Legacy format: plain model ID string, no capability metadata
				if (entry === modelId) {
					unverified.push({
						site_id: row.site_id,
						host_name: row.host_name,
						sync_url: row.sync_url,
						online_at: row.online_at,
						unverified: true,
					});
				}
			} else if (
				entry &&
				typeof entry === "object" &&
				typeof (entry as HostModelEntry).id === "string"
			) {
				// New object format: HostModelEntry with id, tier, capabilities
				const hostEntry = entry as HostModelEntry;
				if (hostEntry.id !== modelId) continue;

				const host: EligibleHost = {
					site_id: row.site_id,
					host_name: row.host_name,
					sync_url: row.sync_url,
					online_at: row.online_at,
					capabilities: hostEntry.capabilities,
					tier: hostEntry.tier,
					unverified: false,
				};

				// Apply capability filter (only for verified hosts)
				if (requirements) {
					const caps = hostEntry.capabilities;
					if (!caps) {
						// No capability metadata → treat as unverified fallback
						unverified.push({ ...host, unverified: true });
						continue;
					}
					if (requirements.vision && !caps.vision) continue; // Exclude
					if (requirements.tool_use && !caps.tool_use) continue;
					if (requirements.system_prompt && !caps.system_prompt) continue;
					if (requirements.prompt_caching && !caps.prompt_caching) continue;
				}

				verified.push(host);
			}
		}
	}

	// When requirements are set: return only verified matches; unverified hosts are
	// fallback when no verified match exists (AC7.3/AC7.4).
	// When no requirements: return all (verified + unverified) sorted by preference.
	let eligible: EligibleHost[];
	if (requirements && verified.length > 0) {
		eligible = verified;
	} else if (requirements && verified.length === 0) {
		// No verified match — fall back to unverified hosts
		eligible = unverified;
	} else {
		// No requirements — combine all, verified first
		eligible = [...verified, ...unverified];
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Model "${modelId}" not available on any remote host` };
	}

	// Sort: by tier (ascending, lower is better), then by online_at (descending)
	eligible.sort((a, b) => {
		// Verified before unverified
		if (!a.unverified && b.unverified) return -1;
		if (a.unverified && !b.unverified) return 1;
		// By tier (lower tier = preferred)
		const tierA = a.tier ?? 99;
		const tierB = b.tier ?? 99;
		if (tierA !== tierB) return tierA - tierB;
		// By online_at (most recent first)
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
