import type { Database } from "bun:sqlite";
import type { ModelAliasRow, ModelRoutingRuleRow, RouteDrainRow } from "@bound/shared";

/**
 * Read repository for the three synced routing-preference tables
 * (`model_routing_rules`, `route_drains`, `model_aliases`). See ./index.ts for
 * conventions. Writes go through insertRow/updateRow/softDelete (invariant #1).
 *
 * These tables carry cluster-wide routing PREFERENCE — route priority per
 * logical model, operator drains per RouteId, and alias overrides per provider
 * model — distinct from the per-host route SUPPLY advertised in `hosts.models`
 * (2026-11-21-model-routing.md §4.2). No foreign keys (invariant #20): a row
 * may reference a RouteId or logical model that is not currently advertised, in
 * which case it is a dormant no-op (§6.3).
 */

/** Live `model_routing_rules` row for a logical model, or null if unset/tombstoned. */
export function findModelRoutingRule(
	db: Database,
	logicalModel: string,
): ModelRoutingRuleRow | null {
	return db
		.query("SELECT * FROM model_routing_rules WHERE logical_model = ? AND deleted = 0 LIMIT 1")
		.get(logicalModel) as ModelRoutingRuleRow | null;
}

/** Existence check INCLUDING tombstones — write path uses this to UPDATE-vs-INSERT. */
export function findModelRoutingRuleIncludingDeleted(
	db: Database,
	logicalModel: string,
): { logical_model: string } | null {
	return db
		.query("SELECT logical_model FROM model_routing_rules WHERE logical_model = ?")
		.get(logicalModel) as { logical_model: string } | null;
}

/** All live `model_routing_rules`, ascending by logical_model. */
export function listModelRoutingRules(db: Database): ModelRoutingRuleRow[] {
	return db
		.query("SELECT * FROM model_routing_rules WHERE deleted = 0 ORDER BY logical_model ASC")
		.all() as ModelRoutingRuleRow[];
}

/** Live drain row for a RouteId, or null if the route is not drained. */
export function findRouteDrain(db: Database, routeId: string): RouteDrainRow | null {
	return db
		.query("SELECT * FROM route_drains WHERE route_id = ? AND deleted = 0 LIMIT 1")
		.get(routeId) as RouteDrainRow | null;
}

/** Existence check INCLUDING tombstones for the drain write path. */
export function findRouteDrainIncludingDeleted(
	db: Database,
	routeId: string,
): { route_id: string } | null {
	return db.query("SELECT route_id FROM route_drains WHERE route_id = ?").get(routeId) as {
		route_id: string;
	} | null;
}

/** RouteIds of every currently-drained route (deleted = 0). */
export function listDrainedRouteIds(db: Database): string[] {
	const rows = db.query("SELECT route_id FROM route_drains WHERE deleted = 0").all() as Array<{
		route_id: string;
	}>;
	return rows.map((r) => r.route_id);
}

/** Live alias override for a provider_key (`${provider}:${provider_model_id}`), or null. */
export function findModelAlias(db: Database, providerKey: string): ModelAliasRow | null {
	return db
		.query("SELECT * FROM model_aliases WHERE provider_key = ? AND deleted = 0 LIMIT 1")
		.get(providerKey) as ModelAliasRow | null;
}

/** Existence check INCLUDING tombstones for the alias write path. */
export function findModelAliasIncludingDeleted(
	db: Database,
	providerKey: string,
): { provider_key: string } | null {
	return db
		.query("SELECT provider_key FROM model_aliases WHERE provider_key = ?")
		.get(providerKey) as {
		provider_key: string;
	} | null;
}

/** All live alias overrides, ascending by provider_key. */
export function listModelAliases(db: Database): ModelAliasRow[] {
	return db
		.query("SELECT * FROM model_aliases WHERE deleted = 0 ORDER BY provider_key ASC")
		.all() as ModelAliasRow[];
}
