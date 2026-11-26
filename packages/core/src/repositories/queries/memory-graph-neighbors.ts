import type { Database } from "bun:sqlite";
import { sql } from "kysely";
import { getAll, queryBuilder } from "../../query-builder";

/**
 * One row of a recursive graph traversal: a reachable entry resolved against
 * its live `semantic_memory` row, tagged with the edge it was reached through.
 */
export interface GraphTraversalRow {
	key: string;
	depth: number;
	via_relation: string | null;
	via_weight: number | null;
	via_context: string | null;
	value: string;
	modified_at: string;
	source: string | null;
	tier: string;
}

/**
 * Walk the memory graph from `startKey` using a recursive CTE, up to
 * `effectiveDepth` hops (the caller clamps depth). Cycle prevention uses a
 * `/key/`-delimited path string. Optionally filter to a single `relation`
 * (`relationParam = null` follows all relations). Joins to live `semantic_memory`
 * and orders `r.depth ASC, m.modified_at DESC`.
 */
export function traverseMemoryGraph(
	db: Database,
	startKey: string,
	effectiveDepth: number,
	relationParam: string | null,
	agentId: string | null = null,
): GraphTraversalRow[] {
	const nsOp = agentId === null ? "is" : "=";
	return getAll(
		db,
		queryBuilder
			.withRecursive("reachable(key, depth, path, via_relation, via_weight, via_context)", (qb) =>
				qb
					.selectNoFrom([
						sql<string>`${startKey}`.as("key"),
						sql<number>`0`.as("depth"),
						sql<string>`'/' || ${startKey} || '/'`.as("path"),
						sql<string | null>`NULL`.as("via_relation"),
						sql<number | null>`NULL`.as("via_weight"),
						sql<string | null>`NULL`.as("via_context"),
					])
					.unionAll((eb) =>
						eb
							.selectFrom("memory_edges as e")
							.innerJoin("reachable as r", "e.source_key", "r.key")
							.select([
								"e.target_key as key",
								sql<number>`r.depth + 1`.as("depth"),
								sql<string>`r.path || e.target_key || '/'`.as("path"),
								"e.relation as via_relation",
								"e.weight as via_weight",
								"e.context as via_context",
							])
							.where("r.depth", "<", effectiveDepth)
							.where("e.deleted", "=", 0)
							.where("e.agent_id", nsOp, agentId)
							.where(sql<number>`INSTR(r.path, '/' || e.target_key || '/')`, "=", 0)
							.where((w) =>
								w.or([w(sql.val(relationParam), "is", null), w("e.relation", "=", relationParam)]),
							),
					),
			)
			.selectFrom("reachable as r")
			.innerJoin("semantic_memory as m", (join) =>
				join.onRef("m.key", "=", "r.key").on("m.deleted", "=", 0).on("m.agent_id", nsOp, agentId),
			)
			.select([
				"r.key",
				"r.depth",
				"r.via_relation",
				"r.via_weight",
				"r.via_context",
				"m.value",
				"m.modified_at",
				"m.source",
				"m.tier",
			])
			.where("r.depth", ">", 0)
			.orderBy("r.depth", "asc")
			.orderBy("m.modified_at", "desc")
			.$narrowType<{ tier: string }>(),
	);
}

/** One neighbor edge resolved against its live `semantic_memory` row. */
export interface GraphNeighborRow {
	key: string;
	relation: string;
	weight: number;
	context: string | null;
	value: string;
	modified_at: string;
}

/**
 * Outgoing one-hop neighbors of `key`: edges where `key` is the source,
 * resolved against the live target `semantic_memory` row. Ordered
 * `e.weight DESC, m.modified_at DESC`.
 */
export function listOutgoingNeighbors(
	db: Database,
	key: string,
	agentId: string | null = null,
): GraphNeighborRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges as e")
			.innerJoin("semantic_memory as m", (join) =>
				join.onRef("m.key", "=", "e.target_key").on("m.deleted", "=", 0),
			)
			.select([
				"e.target_key as key",
				"e.relation",
				"e.weight",
				"e.context",
				"m.value",
				"m.modified_at",
			])
			.where("e.source_key", "=", key)
			.where("e.deleted", "=", 0)
			.where("e.agent_id", agentId === null ? "is" : "=", agentId)
			.where("m.agent_id", agentId === null ? "is" : "=", agentId)
			.orderBy("e.weight", "desc")
			.orderBy("m.modified_at", "desc")
			.$narrowType<{ weight: number }>(),
	);
}

/**
 * Incoming one-hop neighbors of `key`: edges where `key` is the target,
 * resolved against the live source `semantic_memory` row. Ordered
 * `e.weight DESC, m.modified_at DESC`.
 */
export function listIncomingNeighbors(
	db: Database,
	key: string,
	agentId: string | null = null,
): GraphNeighborRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges as e")
			.innerJoin("semantic_memory as m", (join) =>
				join.onRef("m.key", "=", "e.source_key").on("m.deleted", "=", 0),
			)
			.select([
				"e.source_key as key",
				"e.relation",
				"e.weight",
				"e.context",
				"m.value",
				"m.modified_at",
			])
			.where("e.target_key", "=", key)
			.where("e.deleted", "=", 0)
			.where("e.agent_id", agentId === null ? "is" : "=", agentId)
			.where("m.agent_id", agentId === null ? "is" : "=", agentId)
			.orderBy("e.weight", "desc")
			.orderBy("m.modified_at", "desc")
			.$narrowType<{ weight: number }>(),
	);
}
