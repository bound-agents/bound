import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export interface MemoryGraphNode {
	key: string;
	value: string;
	tier: string;
	source: string | null;
	sourceThreadTitle: string | null;
	lineIndex: number | null;
	modifiedAt: string;
}

export interface MemoryGraphEdge {
	sourceKey: string;
	targetKey: string;
	relation: string;
	modifiedAt: string;
}

export interface MemoryGraphResponse {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
}

export function createMemoryRoutes(db: Database): Hono {
	const app = new Hono();

	app.get("/graph", (c) => {
		try {
			// Query all non-deleted memories
			const memoryRows = db
				.query(
					`
				SELECT sm.id, sm.key, sm.value, sm.tier, sm.source, sm.modified_at,
					   t.title as source_thread_title, t.color as source_color
				FROM semantic_memory sm
				LEFT JOIN threads t ON sm.source = t.id AND t.deleted = 0
				WHERE sm.deleted = 0
			`,
				)
				.all() as Array<{
				id: string;
				key: string;
				value: string;
				tier: string;
				source: string | null;
				modified_at: string;
				source_thread_title: string | null;
				source_color: number | null;
			}>;

			// Query all non-deleted edges
			const edgeRows = db
				.query(
					`
				SELECT source_key, target_key, relation, modified_at
				FROM memory_edges
				WHERE deleted = 0
			`,
				)
				.all() as Array<{
				source_key: string;
				target_key: string;
				relation: string;
				modified_at: string;
			}>;

			// Build nodes response
			const nodes: MemoryGraphNode[] = memoryRows.map((row) => ({
				key: row.key,
				value: row.value,
				tier: row.tier,
				source: row.source,
				sourceThreadTitle: row.source_thread_title,
				lineIndex: row.source_color,
				modifiedAt: row.modified_at,
			}));

			// Build edges response
			const edges: MemoryGraphEdge[] = edgeRows.map((row) => ({
				sourceKey: row.source_key,
				targetKey: row.target_key,
				relation: row.relation,
				modifiedAt: row.modified_at,
			}));

			const response: MemoryGraphResponse = {
				nodes,
				edges,
			};

			return c.json(response);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get memory graph",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
