import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { createMemoryRoutes } from "../memory";

// createMemoryRoutes serves the memory-graph view: non-deleted semantic_memory
// rows as nodes (joined to their source thread's title/color) and non-deleted
// memory_edges as edges. These tests seed both tables and assert the mapped
// response shape, the soft-delete filtering, the thread-title join, and the
// 500 fallback.

const SITE = "test-site";

function seedMemory(
	db: Database,
	row: { key: string; value: string; tier?: string; source?: string | null; deleted?: number },
): void {
	const now = "2026-07-04T00:00:00.000Z";
	insertRow(
		db,
		"semantic_memory",
		{
			id: `mem-${row.key}`,
			key: row.key,
			value: row.value,
			source: row.source ?? null,
			tier: row.tier ?? "default",
			created_at: now,
			modified_at: now,
			last_accessed_at: null,
			agent_id: null,
			deleted: row.deleted ?? 0,
		},
		SITE,
	);
}

function seedThread(db: Database, id: string, title: string, color: number): void {
	const now = "2026-07-04T00:00:00.000Z";
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: "system",
			interface: "web",
			host_origin: SITE,
			color,
			title,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			model_hint: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
}

function seedEdge(
	db: Database,
	row: { source: string; target: string; relation: string; deleted?: number },
): void {
	const now = "2026-07-04T00:00:00.000Z";
	insertRow(
		db,
		"memory_edges",
		{
			id: `edge-${row.source}-${row.target}`,
			source_key: row.source,
			target_key: row.target,
			relation: row.relation,
			weight: 1.0,
			context: null,
			agent_id: null,
			created_at: now,
			modified_at: now,
			deleted: row.deleted ?? 0,
		},
		SITE,
	);
}

describe("memory routes — GET /graph", () => {
	let db: Database;
	let app: ReturnType<typeof createMemoryRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		app = createMemoryRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns an empty graph when there are no memories", async () => {
		const res = await app.request("/graph");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ nodes: [], edges: [] });
	});

	it("maps non-deleted memories to nodes and edges", async () => {
		seedMemory(db, { key: "alpha", value: "first", tier: "pinned" });
		seedMemory(db, { key: "beta", value: "second", tier: "summary" });
		seedEdge(db, { source: "alpha", target: "beta", relation: "related_to" });

		const res = await app.request("/graph");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: Array<{ key: string; value: string; tier: string }>;
			edges: Array<{ sourceKey: string; targetKey: string; relation: string }>;
		};
		expect(body.nodes.map((n) => n.key).sort()).toEqual(["alpha", "beta"]);
		const alpha = body.nodes.find((n) => n.key === "alpha");
		expect(alpha).toMatchObject({ value: "first", tier: "pinned" });
		expect(body.edges).toEqual([
			expect.objectContaining({
				sourceKey: "alpha",
				targetKey: "beta",
				relation: "related_to",
			}),
		]);
	});

	it("excludes soft-deleted memories and edges", async () => {
		seedMemory(db, { key: "live", value: "keep" });
		seedMemory(db, { key: "gone", value: "drop", deleted: 1 });
		seedEdge(db, { source: "live", target: "gone", relation: "related_to", deleted: 1 });

		const body = (await (await app.request("/graph")).json()) as {
			nodes: Array<{ key: string }>;
			edges: unknown[];
		};
		expect(body.nodes.map((n) => n.key)).toEqual(["live"]);
		expect(body.edges).toEqual([]);
	});

	it("joins a memory's source thread title and color (as lineIndex)", async () => {
		seedThread(db, "thread-x", "Investigation X", 4);
		seedMemory(db, { key: "sourced", value: "v", source: "thread-x" });

		const body = (await (await app.request("/graph")).json()) as {
			nodes: Array<{
				key: string;
				source: string | null;
				sourceThreadTitle: string | null;
				lineIndex: number | null;
			}>;
		};
		const node = body.nodes.find((n) => n.key === "sourced");
		expect(node?.source).toBe("thread-x");
		expect(node?.sourceThreadTitle).toBe("Investigation X");
		expect(node?.lineIndex).toBe(4);
	});

	it("leaves source metadata null when the source thread is deleted", async () => {
		// A thread referenced as a source but soft-deleted: the LEFT JOIN drops it.
		seedThread(db, "thread-dead", "Dead Thread", 2);
		db.query("UPDATE threads SET deleted = 1 WHERE id = ?").run("thread-dead");
		seedMemory(db, { key: "orphan", value: "v", source: "thread-dead" });

		const body = (await (await app.request("/graph")).json()) as {
			nodes: Array<{ key: string; sourceThreadTitle: string | null }>;
		};
		const node = body.nodes.find((n) => n.key === "orphan");
		expect(node?.sourceThreadTitle).toBeNull();
	});

	it("returns 500 when the query throws", async () => {
		db.close();
		const res = await app.request("/graph");
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Failed to get memory graph");
	});
});
