import type { Database } from "bun:sqlite";
import {
	type ClusterModelRoles,
	type HostModelEntry,
	type NormalizeKeyFn,
	RESERVED_MODEL_ROLES,
	ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
	ROUTING_MODEL_ROLES_KEY,
	hintMatchesAnyLogicalModel,
} from "@bound/shared";
import { findClusterConfigValueByKey } from "../cluster-config";
import { listAllHostModels } from "../hosts";
import { listDrainedRouteIds } from "../model-routing";

/**
 * Dangling- and stale-reference analysis for the route/model removal lifecycle
 * (2026-11-21-model-routing.md §6.3, R-RT22–R-RT24; 2026-11-21-model-catalog.md
 * §7.3, R-MC13).
 *
 * The three synced preference tables (`model_routing_rules`, `route_drains`,
 * `model_aliases`), the cluster-role map, and the default fallback list carry NO
 * foreign keys (invariant #20): an entry may point at a `RouteId` or logical
 * model that no host currently advertises. Rather than cascade-delete such an
 * entry when its target disappears — which would destroy operator intent on a
 * temporary provider outage or a reverted config edit — the entry is retained as
 * a dormant no-op and surfaced here so Settings › Models can mark it stale for
 * manual pruning, and so cluster-role / aux-agent / scheduled-task references to
 * a decommissioned model can raise (and later auto-resolve) an operator advisory.
 *
 * The live set is the union of every logical model / RouteId advertised by a
 * **non-deleted** `hosts` row (`deleted = 0`). Host-liveness freshness is
 * deliberately ignored: a stale/offline-but-not-evicted host still advertising a
 * model keeps that model live (the model is transiently unavailable, not
 * decommissioned). Only cluster host-liveness row eviction — soft-deleting a
 * dead `hosts` row — removes its advertisement from the live set, flipping a
 * model to decommissioned. This mirrors `isModelRegisteredInCluster` in
 * model-resolution.ts, which uses the same `deleted = 0` host scan as the
 * transient-vs-permanent resolution discriminator.
 *
 * This analyzer is a pure read over the DB: it classifies, it never writes. The
 * advisory lifecycle (raise on dangling, auto-resolve on re-advertise) consumes
 * its output; see reconcileModelReferenceAdvisories in @bound/agent. Scheduled
 * tasks are surfaced because heartbeats are never poison-pill parked
 * (scheduler.ts): a dead heartbeat model_hint re-arms and fails silently
 * forever, so the advisory is the operator's only signal.
 */

/** A `route_order` entry whose RouteId is advertised nowhere (dormant no-op). */
export interface StaleRouteOrderEntry {
	logicalModel: string;
	routeId: string;
}

/** A `model_aliases` entry whose logical_model is advertised nowhere. */
export interface StaleModelAlias {
	providerKey: string;
	logicalModel: string;
}

/**
 * A cluster role or alias pointing at a decommissioned model. `role` is the
 * reserved role name (`default`/`heavy`/`fast`) or an operator-named alias.
 */
export interface DanglingRole {
	role: string;
	logicalModel: string;
}

/** An aux-agent `model_hint` naming a decommissioned logical model literally. */
export interface DanglingAgent {
	agentName: string;
	logicalModel: string;
}

/** A live scheduled task whose `model_hint` names a decommissioned logical model literally. */
export interface DanglingTask {
	taskId: string;
	logicalModel: string;
}

/**
 * The full classification of every synced routing reference against the live
 * advertised set. `stale*` entries are dormant no-ops surfaced for manual
 * cleanup; `dangling*` entries point a role or aux agent at a decommissioned
 * model and drive operator advisories.
 */
export interface ModelReferenceReport {
	staleRouteOrderEntries: StaleRouteOrderEntry[];
	staleRouteDrains: string[];
	staleModelAliases: StaleModelAlias[];
	staleFallbackModels: string[];
	danglingRoles: DanglingRole[];
	danglingAgents: DanglingAgent[];
	danglingTasks: DanglingTask[];
}

/** Parse `hosts.models` JSON into a tolerant list of entries (bad rows skipped). */
function parseHostModels(models: string | null): HostModelEntry[] {
	if (!models) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(models);
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const entries: HostModelEntry[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			entries.push({ id: item });
		} else if (item && typeof item === "object") {
			entries.push(item as HostModelEntry);
		}
	}
	return entries;
}

/** The logical model an entry serves: explicit `logical_model`, else its `id`. */
function entryLogicalModel(entry: HostModelEntry): string {
	return entry.logical_model ?? entry.id;
}

/**
 * The live advertised set across every non-deleted host: the logical models and
 * the RouteIds any host currently advertises. Local backends also advertise via
 * the local host's own `hosts` row (the sync layer publishes it), so a DB-only
 * scan captures both local and remote supply without a router handle.
 */
function liveAdvertisedSets(db: Database): { models: Set<string>; routes: Set<string> } {
	const rows = listAllHostModels(db);
	const models = new Set<string>();
	const routes = new Set<string>();
	for (const row of rows) {
		for (const entry of parseHostModels(row.models)) {
			// A hint may name either the logical model or the advertised backend id
			// (e.g. `opus-4.8` advertised with logical_model `claude-opus-4-8`).
			// Resolution (`isModelRegisteredInCluster`) accepts the id, so liveness
			// must too, or every id-form hint reads as dangling.
			models.add(entryLogicalModel(entry));
			if (typeof entry.id === "string" && entry.id.length > 0) models.add(entry.id);
			if (entry.route_id) routes.add(entry.route_id);
		}
	}
	return { models, routes };
}

/** The logical-model prefix of a `model_hint` (the part before an optional `@RouteId` pin). */
function hintLogicalModel(hint: string): string | null {
	const at = hint.indexOf("@");
	if (at === -1) return hint.length > 0 ? hint : null;
	const before = hint.slice(0, at);
	return before.length > 0 ? before : null;
}

/**
 * Analyze every synced routing reference against the live advertised set.
 * See {@link ModelReferenceReport}. Pure read; tolerant of malformed JSON.
 *
 * `normalizeKey` is the injected structural normalizer (`@bound/llm`'s
 * `normalizeModelKey`): `@bound/core` depends only on `@bound/shared` and cannot
 * import it, so the caller (the reconciler in `@bound/agent`, the Settings route
 * in `@bound/web`) passes it in. Threading it here keeps the dangling checker's
 * liveness verdict IDENTICAL to resolution's (model-resolution.ts /
 * relay-router.ts): a hint that resolves THROUGH a logical model is never
 * reported dangling, and vice versa.
 */
export function analyzeModelReferences(
	db: Database,
	normalizeKey: NormalizeKeyFn,
): ModelReferenceReport {
	const { models: liveModels, routes: liveRoutes } = liveAdvertisedSets(db);

	// Stale route_order entries: a RouteId listed in a live rule but advertised
	// by no host. One logical model's rule can carry several; each is reported.
	const staleRouteOrderEntries: StaleRouteOrderEntry[] = [];
	const ruleRows = db
		.query("SELECT logical_model, route_order FROM model_routing_rules WHERE deleted = 0")
		.all() as Array<{ logical_model: string; route_order: string | null }>;
	for (const rule of ruleRows) {
		if (!rule.route_order) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(rule.route_order);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		for (const routeId of parsed) {
			if (typeof routeId !== "string") continue;
			if (!liveRoutes.has(routeId)) {
				staleRouteOrderEntries.push({ logicalModel: rule.logical_model, routeId });
			}
		}
	}

	// Stale drains: a live drain on a RouteId advertised nowhere.
	const staleRouteDrains: string[] = [];
	for (const routeId of listDrainedRouteIds(db)) {
		if (!liveRoutes.has(routeId)) staleRouteDrains.push(routeId);
	}

	// Stale aliases: a live alias mapping to a logical model advertised nowhere.
	// A null logical_model is a deliberate "keep ungrouped" mapping, not stale.
	const staleModelAliases: StaleModelAlias[] = [];
	const aliasRows = db
		.query("SELECT provider_key, logical_model FROM model_aliases WHERE deleted = 0")
		.all() as Array<{ provider_key: string; logical_model: string | null }>;
	for (const alias of aliasRows) {
		if (alias.logical_model === null) continue;
		if (!liveModels.has(alias.logical_model)) {
			staleModelAliases.push({
				providerKey: alias.provider_key,
				logicalModel: alias.logical_model,
			});
		}
	}

	// Stale default-fallback entries: a listed logical model advertised nowhere.
	const staleFallbackModels: string[] = [];
	const fallbackRow = findClusterConfigValueByKey(db, ROUTING_DEFAULT_FALLBACK_MODELS_KEY);
	if (fallbackRow) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fallbackRow.value);
		} catch {
			parsed = null;
		}
		if (Array.isArray(parsed)) {
			for (const model of parsed) {
				if (typeof model === "string" && !liveModels.has(model)) {
					staleFallbackModels.push(model);
				}
			}
		}
	}

	// Dangling cluster roles/aliases: a role or alias whose assigned logical model
	// is advertised nowhere. Unlike the stale lists above, a dangling role raises
	// an advisory (R-MC13) because a role silently resolving to nothing would strand
	// omitted-model requests without an operator ever seeing why. The three reserved
	// roles (default/heavy/fast) and operator-named aliases are the same mechanism
	// (a cluster-wide name → logical model) and are checked identically: every
	// well-formed entry whose target is a real string is a candidate.
	const danglingRoles: DanglingRole[] = [];
	// The three reserved roles always carry documented resolution semantics (e.g.
	// `default`'s bootstrap fallback) even when the cluster map omits them, so an
	// agent/task hint naming one is never dangling on its own. Aliases are added
	// below only when actually present in the map.
	const roleNames = new Set<string>(RESERVED_MODEL_ROLES);
	const rolesRow = findClusterConfigValueByKey(db, ROUTING_MODEL_ROLES_KEY);
	if (rolesRow) {
		let roles: ClusterModelRoles | null = null;
		try {
			roles = JSON.parse(rolesRow.value) as ClusterModelRoles;
		} catch {
			roles = null;
		}
		if (roles && typeof roles === "object") {
			for (const role of Object.keys(roles)) {
				const model = roles[role];
				if (typeof model !== "string" || model.length === 0) continue;
				// The name is a live role/alias regardless of whether its target
				// resolves, so an agent/task targeting it is never dangling on its own.
				roleNames.add(role);
				if (!hintMatchesAnyLogicalModel(model, liveModels, normalizeKey)) {
					danglingRoles.push({ role, logicalModel: model });
				}
			}
		}
	}

	// Dangling aux agents: a live (non-retired) agent whose model_hint names a
	// decommissioned logical model literally. An agent targeting a cluster role or
	// alias follows the mapping's current assignment, so it is never dangling by
	// itself — the dangling role/alias, if any, is reported above.
	const danglingAgents: DanglingAgent[] = [];
	const agentRows = db
		.query(
			"SELECT name, model_hint FROM agents WHERE deleted = 0 AND retired_at IS NULL AND model_hint IS NOT NULL",
		)
		.all() as Array<{ name: string; model_hint: string | null }>;
	for (const agent of agentRows) {
		if (!agent.model_hint) continue;
		const logical = hintLogicalModel(agent.model_hint);
		if (logical === null) continue;
		// Role/alias targets follow the mapping; never dangling on their own.
		if (roleNames.has(logical)) continue;
		if (!hintMatchesAnyLogicalModel(logical, liveModels, normalizeKey)) {
			danglingAgents.push({ agentName: agent.name, logicalModel: logical });
		}
	}

	// Dangling scheduled tasks: a live (non-finished, non-deleted) task whose
	// model_hint names a decommissioned logical model literally. Heartbeats are
	// never poison-pill parked (they must always re-arm), so their advisory is the
	// only operator signal that a model_hint has gone dead. A task targeting a
	// cluster role or alias follows the mapping's current assignment, so it is never
	// dangling by itself. Finished tasks (completed/failed/cancelled) never re-run,
	// so a dead hint on them is inert and not surfaced.
	const danglingTasks: DanglingTask[] = [];
	const taskRows = db
		.query(
			"SELECT id, model_hint FROM tasks WHERE deleted = 0 AND model_hint IS NOT NULL AND status IN ('pending', 'claimed', 'running')",
		)
		.all() as Array<{ id: string; model_hint: string | null }>;
	for (const task of taskRows) {
		if (!task.model_hint) continue;
		const logical = hintLogicalModel(task.model_hint);
		if (logical === null) continue;
		// Role/alias targets follow the mapping; never dangling on their own.
		if (roleNames.has(logical)) continue;
		if (!hintMatchesAnyLogicalModel(logical, liveModels, normalizeKey)) {
			danglingTasks.push({ taskId: task.id, logicalModel: logical });
		}
	}

	return {
		staleRouteOrderEntries,
		staleRouteDrains,
		staleModelAliases,
		staleFallbackModels,
		danglingRoles,
		danglingAgents,
		danglingTasks,
	};
}
