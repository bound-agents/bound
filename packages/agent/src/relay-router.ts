import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	DURABLE_RELAY_ENABLED,
	findHostWorkSpoolCapabilityById,
	insertDurableWork,
	writeOutbox,
} from "@bound/core";
import type { CapabilityRequirements } from "@bound/llm";
import type { TypedEventEmitter } from "@bound/shared";
import type { HostModelEntry, RelayKind, RelayOutboxEntry } from "@bound/shared";
import { DURABLE_WORK_REGISTRY } from "./durable-work-registry";
import { type TopologyRole, resolveHubSiteId, resolveTopologyRole } from "./topology";

/**
 * Registry-declared TTL floor per kind. The durable-work registry is the
 * authority for each kind's terminal TTL (R-DW12): RPC request kinds declare
 * the RPC-class 300s window so the expiry sweep dead-letters a stale request
 * before it dispatches. Callers pass a raw request `timeoutMs` — a platform or
 * client-tool request rides a SHORT timeout (~15s). A terminal TTL shorter than
 * the 30s transfer-stale window is self-defeating: the row expires before it is
 * ever transfer-stale, so no transfer retry can fire and no live-work recovery
 * is reachable (the #253 incident). Clamping the caller's `timeoutMs` UP to at
 * least the registry ttlMs restores the declared TTL as the floor while leaving
 * a longer caller window (e.g. a 20-min inference) untouched — it is a floor,
 * not a ceiling. A kind with a null registry TTL (dispatch_message, task_fire)
 * or no registration keeps the caller's value verbatim.
 */
const REGISTRY_TTL_MS_BY_KIND: ReadonlyMap<string, number> = new Map(
	DURABLE_WORK_REGISTRY.flatMap((r) => (r.ttlMs != null ? [[r.kind, r.ttlMs] as const] : [])),
);

/**
 * The terminal `expires_at` for a durable request/response row, clamped so the
 * row's live window is never shorter than its kind's registry-declared TTL. See
 * {@link REGISTRY_TTL_MS_BY_KIND}.
 */
function durableExpiresAt(kind: string, now: Date, timeoutMs: number): string {
	const floorMs = REGISTRY_TTL_MS_BY_KIND.get(kind) ?? 0;
	return new Date(now.getTime() + Math.max(timeoutMs, floorMs)).toISOString();
}

export { resolveTopologyRole };
export type { TopologyRole };

export interface EligibleHost {
	site_id: string;
	host_name: string;
	sync_url: string | null;
	online_at: string | null;
	modified_at: string | null;
	/** Capability metadata from the host's HostModelEntry. Present for verified hosts only. */
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
	/** Per-response output-token ceiling from the matching HostModelEntry. */
	maxOutputTokens?: number;
	/** Tier preference (lower = preferred). Present for verified hosts only. */
	tier?: number;
	/** Bound-side reasoning transport advertised by the serving host. */
	thinkingMode?: "tool";
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

/** Check staleness using modified_at (kept fresh by heartbeat), falling back to online_at. */
function hostAge(row: { modified_at: string | null; online_at: string | null }): number | null {
	const ts = row.modified_at ?? row.online_at;
	if (!ts) return null;
	return Date.now() - new Date(ts).getTime();
}

export function findEligibleHosts(
	db: Database,
	toolCommandName: string,
	localSiteId: string,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, mcp_tools, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		mcp_tools: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;

	const eligible: EligibleHost[] = [];
	for (const row of rows) {
		if (!row.mcp_tools) continue;
		let tools: string[];
		try {
			tools = JSON.parse(row.mcp_tools);
		} catch (_error) {
			// Skip hosts with corrupted mcp_tools — no logger available in this context
			continue;
		}
		if (!Array.isArray(tools) || !tools.includes(toolCommandName)) continue;
		eligible.push({
			site_id: row.site_id,
			host_name: row.host_name,
			sync_url: row.sync_url,
			online_at: row.online_at,
			modified_at: row.modified_at,
		});
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Tool "${toolCommandName}" not available on any remote host` };
	}

	// Sort by modified_at descending (most recent first), falling back to online_at, nulls last
	eligible.sort((a, b) => {
		const aTs = a.modified_at ?? a.online_at;
		const bTs = b.modified_at ?? b.online_at;
		if (!aTs && !bTs) return 0;
		if (!aTs) return 1;
		if (!bTs) return -1;
		return new Date(bTs).getTime() - new Date(aTs).getTime();
	});

	return { ok: true, hosts: eligible };
}

export function isHostStale(host: EligibleHost): boolean {
	const ts = host.modified_at ?? host.online_at;
	if (!ts) return true;
	return Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS;
}

export function findEligibleHostsByModel(
	db: Database,
	modelId: string,
	localSiteId: string,
	requirements?: CapabilityRequirements,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;

	const verified: EligibleHost[] = [];
	const unverified: EligibleHost[] = [];

	for (const row of rows) {
		if (!row.models) continue;
		// Stale hosts are excluded (modified_at or online_at older than STALE_THRESHOLD_MS)
		const age = hostAge(row);
		if (age === null || age > STALE_THRESHOLD_MS) continue;

		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch (_error) {
			// Malformed JSON — skip host (no logger available in this context)
			continue;
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
						modified_at: row.modified_at,
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
					modified_at: row.modified_at,
					capabilities: hostEntry.capabilities,
					maxOutputTokens: hostEntry.max_output_tokens,
					tier: hostEntry.tier,
					thinkingMode: hostEntry.thinking_mode,
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

	// Sort: by tier (ascending, lower is better), then by freshness (descending)
	eligible.sort((a, b) => {
		// Verified before unverified
		if (!a.unverified && b.unverified) return -1;
		if (a.unverified && !b.unverified) return 1;
		// By tier (lower tier = preferred)
		const tierA = a.tier ?? 99;
		const tierB = b.tier ?? 99;
		if (tierA !== tierB) return tierA - tierB;
		// By freshness (most recent first), modified_at preferred over online_at
		const aTs = a.modified_at ?? a.online_at;
		const bTs = b.modified_at ?? b.online_at;
		if (!aTs && !bTs) return 0;
		if (!aTs) return 1;
		if (!bTs) return -1;
		return new Date(bTs).getTime() - new Date(aTs).getTime();
	});

	return { ok: true, hosts: eligible };
}

/**
 * Finds any eligible remote host with any available model.
 * Used for hub-only mode where the local default model ID is empty and the hub
 * relies entirely on remote spoke inference.
 * Returns the first model/host pair sorted by tier (ascending) then online_at (descending).
 */
export function findAnyRemoteModel(
	db: Database,
	localSiteId: string,
): (RelayRoutingResult & { modelId: string }) | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;

	const candidates: Array<EligibleHost & { modelId: string }> = [];

	for (const row of rows) {
		if (!row.models) continue;
		const age = hostAge(row);
		if (age === null || age > STALE_THRESHOLD_MS) continue;

		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch (_error) {
			// Malformed JSON — skip host (no logger available in this context)
			continue;
		}
		if (!Array.isArray(rawModels)) continue;

		for (const entry of rawModels) {
			const modelId =
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object" && typeof (entry as HostModelEntry).id === "string"
						? (entry as HostModelEntry).id
						: null;
			if (!modelId) continue;

			const hostEntry = entry && typeof entry === "object" ? (entry as HostModelEntry) : undefined;
			const tier = hostEntry?.tier ?? 99;
			const capabilities = hostEntry?.capabilities;

			candidates.push({
				site_id: row.site_id,
				host_name: row.host_name,
				sync_url: row.sync_url,
				online_at: row.online_at,
				modified_at: row.modified_at,
				tier,
				capabilities,
				maxOutputTokens: hostEntry?.max_output_tokens,
				thinkingMode: hostEntry?.thinking_mode,
				modelId,
			});
		}
	}

	if (candidates.length === 0) {
		return { ok: false, error: "No remote inference backends available in cluster" };
	}

	// Sort: lower tier first, then most recently active
	candidates.sort((a, b) => {
		const tierA = a.tier ?? 99;
		const tierB = b.tier ?? 99;
		if (tierA !== tierB) return tierA - tierB;
		const aTs = a.modified_at ?? a.online_at;
		const bTs = b.modified_at ?? b.online_at;
		if (!aTs && !bTs) return 0;
		if (!aTs) return 1;
		if (!bTs) return -1;
		return new Date(bTs).getTime() - new Date(aTs).getTime();
	});

	const best = candidates[0];
	return {
		ok: true,
		hosts: [
			{
				site_id: best.site_id,
				host_name: best.host_name,
				sync_url: best.sync_url,
				online_at: best.online_at,
				modified_at: best.modified_at,
				tier: best.tier,
				capabilities: best.capabilities,
				maxOutputTokens: best.maxOutputTokens,
				thinkingMode: best.thinkingMode,
			},
		],
		modelId: best.modelId,
	};
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

/**
 * Serialize only a valid W3C trace carrier for a durable relay envelope.
 * Baggage and unrelated propagation fields must not cross a host boundary.
 */
export function serializeRelayTraceCarrier(carrier: Record<string, string> | null): string | null {
	const traceparent = carrier?.traceparent;
	if (
		!traceparent ||
		!/^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(traceparent) ||
		/^\d{2}-0{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(traceparent) ||
		/^\d{2}-[0-9a-f]{32}-0{16}-[0-9a-f]{2}$/i.test(traceparent)
	) {
		return null;
	}
	const sanitized: Record<string, string> = { traceparent };
	if (carrier?.tracestate) sanitized.tracestate = carrier.tracestate.slice(0, 512);
	return JSON.stringify(sanitized);
}

export function createRelayOutboxEntry(
	targetSiteId: string,
	sourceSiteId: string,
	kind: RelayKind,
	payload: string,
	timeoutMs: number,
	refId?: string,
	idempotencyKey?: string,
	streamId?: string,
	traceContext?: string,
): Omit<RelayOutboxEntry, "delivered"> {
	const now = new Date();
	return {
		id: crypto.randomUUID(),
		source_site_id: sourceSiteId,
		target_site_id: targetSiteId,
		kind,
		ref_id: refId ?? null,
		idempotency_key: idempotencyKey ?? null,
		stream_id: streamId ?? null,
		payload,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
		trace_context: traceContext ?? null,
	};
}

/** Inputs for the 4D-C durable-vs-legacy relay routing decision. */
export interface RelayDurableRoutingContext {
	/** Final destination of the request. */
	targetSiteId: string;
	/** This host's own site id. */
	localSiteId: string;
	/** This host's cluster role, used to identify the hub hop for a spoke. */
	topologyRole: TopologyRole | undefined;
}

/**
 * Decide whether an active non-stream REQUEST bound for `targetSiteId` should
 * ride the durable work spool (4D-B transfer) instead of the legacy relay
 * outbox. Durable IFF the `BOUND_DURABLE_RELAY` toggle is on AND every hop the
 * row must traverse advertises `work_spool_capable` (R-DW14):
 *
 *   - the final target, always; plus
 *   - the hub, when this host is a SPOKE and the target is not the hub itself
 *     (a spoke->hub->target row buffers at the hub, so the hub must be able to
 *     hold and forward it).
 *
 * A capable final target reachable only through a non-advertising hub returns
 * LEGACY — routing durable would strand the row pending at this spoke with no
 * next hop willing to carry it. A self-targeted request also returns LEGACY:
 * loopback semantics are unchanged this slice (the durable lane is peer-only).
 *
 * Reads capability locally from the synced `hosts` table via
 * {@link findHostWorkSpoolCapabilityById}; a missing/legacy advertisement is
 * conservatively treated as not-capable.
 */
export function shouldRouteRelayDurable(db: Database, ctx: RelayDurableRoutingContext): boolean {
	if (!DURABLE_RELAY_ENABLED) return false;
	// Self-targeted requests stay on the legacy loopback path unchanged.
	if (ctx.targetSiteId === ctx.localSiteId) return false;

	const advertises = (siteId: string): boolean =>
		!!findHostWorkSpoolCapabilityById(db, siteId)?.work_spool_capable;

	if (!advertises(ctx.targetSiteId)) return false;

	// On a spoke, a row to any peer other than the hub must transit the hub, so
	// the hub hop must also advertise capability — otherwise the row would strand
	// pending here with no willing carrier. When the target IS the hub, there is
	// no intermediate hop to gate.
	if (ctx.topologyRole === "spoke") {
		const hubSiteId = resolveHubSiteId(db, ctx.topologyRole, ctx.localSiteId);
		if (hubSiteId && ctx.targetSiteId !== hubSiteId && !advertises(hubSiteId)) {
			return false;
		}
	}

	return true;
}

/** Parameters for routing one active non-stream relay REQUEST. */
export interface RouteRelayRequestParams {
	targetSiteId: string;
	sourceSiteId: string;
	kind: RelayKind;
	payload: string;
	timeoutMs: number;
	/** Correlation ref for the eventual response (e.g. a cancel's original id). */
	refId?: string;
	/** Verbatim key when the legacy row carries one (#254 contracts). Null-keyed
	 * legacy rows pass undefined; the durable path then uses the minted row id. */
	idempotencyKey?: string;
	streamId?: string;
	traceContext?: string;
	/** Cluster role, for the spoke hub-hop capability gate. */
	topologyRole: TopologyRole | undefined;
	/** Event bus threaded through to writeOutbox's push-on-write (legacy path). */
	eventBus?: TypedEventEmitter;
	/** Payload-size ceiling forwarded to writeOutbox on the legacy path. */
	maxPayloadBytes?: number;
}

/** Outcome of routing a relay request: where it went and the id to await on. */
export interface RouteRelayRequestResult {
	/** "durable" wrote a peer-targeted durable_work row; "legacy" wrote relay_outbox. */
	path: "durable" | "legacy";
	/** The correlation id the requester awaits via readInboxByRefId. On both
	 * paths this is the written row's id: the 4D-A lane writes responses with
	 * ref_id = durable-row-id, and the legacy processor with ref_id = outbox-id. */
	id: string;
	/** True only when this call inserted a new row rather than colliding with
	 * the durable-work or relay-outbox idempotency fence. */
	inserted: boolean;
}

/**
 * Route one active non-stream relay REQUEST to the durable work spool or the
 * legacy relay outbox, per {@link shouldRouteRelayDurable}. Returns the id the
 * requester must await on (`readInboxByRefId(db, id)`); it is the written row's
 * id on both paths, so response correlation is transparent to the caller.
 *
 * On the durable path the row is inserted peer-targeted and PENDING; 4D-B's
 * `durable_work:written` listener transfers it to the target, whose 4D-A lane
 * claims + dispatches + writes the response back through legacy relay with
 * `ref_id` = this row id. The key rides verbatim when supplied (#254
 * contracts), else the minted row id serves as a deterministic, retry-stable
 * key (R-DW5/6). On the legacy path this is `writeOutbox` exactly as before.
 */
export function routeRelayRequest(
	db: Database,
	params: RouteRelayRequestParams,
): RouteRelayRequestResult {
	const durable = shouldRouteRelayDurable(db, {
		targetSiteId: params.targetSiteId,
		localSiteId: params.sourceSiteId,
		topologyRole: params.topologyRole,
	});

	if (durable) {
		const id = crypto.randomUUID();
		const now = new Date();
		const inserted = insertDurableWork(db, {
			id,
			target_site_id: params.targetSiteId,
			kind: params.kind,
			payload: params.payload,
			// Verbatim key when the legacy row carries one; otherwise the row id
			// itself is a deterministic, redelivery-stable key (R-DW5/6).
			idempotency_key: params.idempotencyKey ?? id,
			expires_at: durableExpiresAt(params.kind, now, params.timeoutMs),
			ref_id: params.refId ?? null,
			stream_id: params.streamId ?? null,
			// Stamp the originating site so the target's durable relay lane can
			// address the response back. A dispatch:"sync" request whose source_site
			// is absent is dead-lettered at the hub guard (#253); every RPC request
			// kind routes through here, so this is the one stamp that covers them all.
			source_site: params.sourceSiteId,
		});
		return { path: "durable", id, inserted };
	}

	const entry = createRelayOutboxEntry(
		params.targetSiteId,
		params.sourceSiteId,
		params.kind,
		params.payload,
		params.timeoutMs,
		params.refId,
		params.idempotencyKey,
		params.streamId,
		params.traceContext,
	);
	const inserted = writeOutbox(db, entry, params.maxPayloadBytes, params.eventBus);
	return { path: "legacy", id: entry.id, inserted };
}

/** Parameters for routing one relay RESPONSE (result/error/chunk/etc.) back to a requester. */
export interface RouteRelayResponseParams {
	/** The original requester — the site that awaits this response. */
	targetSiteId: string;
	/** This host (the responder). */
	sourceSiteId: string;
	/** A `dispatch: "response"` kind (result, error, client_result, stream_chunk, stream_end, trace_data). */
	kind: RelayKind;
	payload: string;
	timeoutMs: number;
	/** Correlation ref: the request's row id. Required — the awaiter reads by this. */
	refId: string;
	/**
	 * Deterministic, redelivery-stable dedup key. Scalar responses pass
	 * `response:<refId>`; stream chunks pass `stream:<streamId>:<seq>`. On the
	 * durable path this is the `(kind, idempotency_key)` fence, so a redelivered
	 * SPOOL_TRANSFER of the identical response row is idempotent (INSERT OR
	 * IGNORE). One request yields exactly one response outcome (a handler writes
	 * result XOR error, never both), so `result`/`error` never both land — the
	 * fence exists to absorb a re-shipped copy of the SAME row, not to collide
	 * two distinct outcomes.
	 */
	idempotencyKey: string;
	streamId?: string;
	traceContext?: string;
	/** Cluster role, for the spoke hub-hop capability gate. */
	topologyRole: TopologyRole | undefined;
	eventBus?: TypedEventEmitter;
	maxPayloadBytes?: number;
}

/**
 * Route one relay RESPONSE back to the awaiting requester over the durable work
 * spool or the legacy relay outbox, per {@link shouldRouteRelayDurable} applied
 * to the RESPONSE's destination (the original requester's site). Responses are
 * the other half of the same RPC transport as {@link routeRelayRequest}: the
 * same per-hop capability gate decides durable-vs-legacy per destination, and
 * the same toggle governs both. Returns the written row's id and whether it was
 * newly inserted (false = the durable fence already held a copy — a redelivered
 * response).
 *
 * On the durable path the response is inserted peer-targeted + PENDING; 4D-B's
 * transfer ships it to the requester, whose union-await
 * ({@link readDurableResponseByRefId} / {@link readDurableResponsesByStreamId})
 * claims + delivers + acks it. The 4D-A relay-processor lane deliberately does
 * NOT claim response kinds; the awaiter is the sole response consumer.
 */
export function routeRelayResponse(
	db: Database,
	params: RouteRelayResponseParams,
): RouteRelayRequestResult {
	const durable = shouldRouteRelayDurable(db, {
		targetSiteId: params.targetSiteId,
		localSiteId: params.sourceSiteId,
		topologyRole: params.topologyRole,
	});

	if (durable) {
		const id = crypto.randomUUID();
		const now = new Date();
		const inserted = insertDurableWork(db, {
			id,
			target_site_id: params.targetSiteId,
			kind: params.kind,
			payload: params.payload,
			idempotency_key: params.idempotencyKey,
			expires_at: durableExpiresAt(params.kind, now, params.timeoutMs),
			ref_id: params.refId,
			stream_id: params.streamId ?? null,
			// Stamp the responder's own site as origin (parity with the request path);
			// responses correlate by ref_id and never hit the sync-dispatch guard, but
			// the row still carries an unambiguous origin (#253).
			source_site: params.sourceSiteId,
		});
		return { path: "durable", id, inserted };
	}

	const entry = createRelayOutboxEntry(
		params.targetSiteId,
		params.sourceSiteId,
		params.kind,
		params.payload,
		params.timeoutMs,
		params.refId,
		// Legacy responses carried a null idempotency_key; preserve that on the
		// legacy path (the durable fence key is a durable-path-only concept).
		undefined,
		params.streamId,
		params.traceContext,
	);
	const inserted = writeOutbox(db, entry, params.maxPayloadBytes, params.eventBus);
	return { path: "legacy", id: entry.id, inserted };
}
