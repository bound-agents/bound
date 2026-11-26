import type { Database } from "bun:sqlite";
import type { ModelAliasRow, ModelRoutingRuleRow, RouteDrainRow } from "@bound/shared";
import { getAll, getOne, queryBuilder } from "../query-builder";

/**
 * Read repository for the three synced routing-preference tables
 * (`model_routing_rules`, `route_drains`, `model_aliases`).
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
	return getOne(
		db,
		queryBuilder
			.selectFrom("model_routing_rules")
			.selectAll()
			.where("logical_model", "=", logicalModel)
			.where("deleted", "=", 0)
			.limit(1),
	);
}

/** Existence check INCLUDING tombstones — write path uses this to UPDATE-vs-INSERT. */
export function findModelRoutingRuleIncludingDeleted(
	db: Database,
	logicalModel: string,
): { logical_model: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("model_routing_rules")
			.select("logical_model")
			.where("logical_model", "=", logicalModel),
	);
}

export function listModelRoutingRules(db: Database): ModelRoutingRuleRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("model_routing_rules")
			.selectAll()
			.where("deleted", "=", 0)
			.orderBy("logical_model", "asc"),
	);
}

/** Live drain row for a RouteId, or null if the route is not drained. */
export function findRouteDrain(db: Database, routeId: string): RouteDrainRow | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("route_drains")
			.selectAll()
			.where("route_id", "=", routeId)
			.where("deleted", "=", 0)
			.limit(1),
	);
}

/** Existence check INCLUDING tombstones for the drain write path. */
export function findRouteDrainIncludingDeleted(
	db: Database,
	routeId: string,
): { route_id: string } | null {
	return getOne(
		db,
		queryBuilder.selectFrom("route_drains").select("route_id").where("route_id", "=", routeId),
	);
}

export function listDrainedRouteIds(db: Database): string[] {
	const rows = getAll(
		db,
		queryBuilder.selectFrom("route_drains").select("route_id").where("deleted", "=", 0),
	);
	return rows.map((r) => r.route_id);
}

/** Every live drain with its operator reason and timestamp. */
export function listRouteDrains(
	db: Database,
): Array<{ route_id: string; drained_at: string; reason: string | null }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("route_drains")
			.select(["route_id", "drained_at", "reason"])
			.where("deleted", "=", 0),
	);
}

/** Existence check INCLUDING tombstones for the alias write path. */
export function findModelAliasIncludingDeleted(
	db: Database,
	providerKey: string,
): { provider_key: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("model_aliases")
			.select("provider_key")
			.where("provider_key", "=", providerKey),
	);
}

export function listModelAliases(db: Database): ModelAliasRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("model_aliases")
			.selectAll()
			.where("deleted", "=", 0)
			.orderBy("provider_key", "asc"),
	);
}
