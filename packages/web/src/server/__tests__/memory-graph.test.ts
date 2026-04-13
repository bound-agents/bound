import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { createMemoryRoutes } from "../routes/memory";

describe("GET /api/memory/graph", () => {
	let db: Database;
	let app: Hono;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		app = createMemoryRoutes(db);
	});

	describe("AC3.1: Returns nodes with correct fields", () => {
		it("returns 3 nodes with key, value, tier, source, modifiedAt", async () => {
			const now = new Date().toISOString();

			// Insert 3 semantic_memory rows with different tiers
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "knowledge:key1", "value1", "pinned", "agent", now, now);

			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "knowledge:key2", "value2", "summary", "agent", now, now);

			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "knowledge:key3", "value3", "default", "agent", now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<{
					key: string;
					value: string;
					tier: string;
					source: string | null;
					modifiedAt: string;
				}>;
				edges: Array<unknown>;
			};

			expect(body).toHaveProperty("nodes");
			expect(body.nodes).toHaveLength(3);

			// Verify AC3.1: each node has required fields
			for (const node of body.nodes) {
				expect(node).toHaveProperty("key");
				expect(node).toHaveProperty("value");
				expect(node).toHaveProperty("tier");
				expect(node).toHaveProperty("modifiedAt");
			}

			// Verify specific nodes
			const keys = new Set(body.nodes.map((n) => n.key));
			expect(keys.has("knowledge:key1")).toBe(true);
			expect(keys.has("knowledge:key2")).toBe(true);
			expect(keys.has("knowledge:key3")).toBe(true);

			// Verify tiers
			const node1 = body.nodes.find((n) => n.key === "knowledge:key1");
			const node2 = body.nodes.find((n) => n.key === "knowledge:key2");
			const node3 = body.nodes.find((n) => n.key === "knowledge:key3");

			expect(node1?.tier).toBe("pinned");
			expect(node2?.tier).toBe("summary");
			expect(node3?.tier).toBe("default");
		});
	});

	describe("AC3.2: Returns edges with correct fields", () => {
		it("returns 2 edges with sourceKey, targetKey, relation, modifiedAt", async () => {
			const now = new Date().toISOString();

			// Insert 2 memory_edges rows
			db.prepare(
				"INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "key1", "key2", "summarizes", 1.0, now, now);

			db.prepare(
				"INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "key2", "key3", "relates-to", 0.8, now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<unknown>;
				edges: Array<{
					sourceKey: string;
					targetKey: string;
					relation: string;
					modifiedAt: string;
				}>;
			};

			expect(body).toHaveProperty("edges");
			expect(body.edges).toHaveLength(2);

			// Verify AC3.2: each edge has required fields
			for (const edge of body.edges) {
				expect(edge).toHaveProperty("sourceKey");
				expect(edge).toHaveProperty("targetKey");
				expect(edge).toHaveProperty("relation");
				expect(edge).toHaveProperty("modifiedAt");
			}

			// Verify specific edges
			const edge1 = body.edges.find((e) => e.sourceKey === "key1");
			const edge2 = body.edges.find((e) => e.sourceKey === "key2");

			expect(edge1?.targetKey).toBe("key2");
			expect(edge1?.relation).toBe("summarizes");
			expect(edge2?.targetKey).toBe("key3");
			expect(edge2?.relation).toBe("relates-to");
		});
	});

	describe("AC3.3: Soft-deleted memories and edges are excluded", () => {
		it("excludes memories and edges with deleted = 1", async () => {
			const now = new Date().toISOString();

			// Insert 2 active and 1 deleted memory
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "active1", "val1", "default", "agent", now, now);

			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
			).run(randomUUID(), "deleted_mem", "val2", "default", "agent", now, now);

			// Insert 2 active and 1 deleted edge
			db.prepare(
				"INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "key1", "key2", "links", 1.0, now, now);

			db.prepare(
				"INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
			).run(randomUUID(), "key2", "key3", "links", 1.0, now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<{ key: string }>;
				edges: Array<{ sourceKey: string; targetKey: string }>;
			};

			// Verify AC3.3: only active rows included
			expect(body.nodes).toHaveLength(1);
			expect(body.nodes[0].key).toBe("active1");

			expect(body.edges).toHaveLength(1);
			expect(body.edges[0].sourceKey).toBe("key1");
			expect(body.edges[0].targetKey).toBe("key2");
		});
	});

	describe("AC3.4: Source provenance resolves to thread info", () => {
		it("resolves source thread ID to title and color", async () => {
			const threadId = randomUUID();
			const now = new Date().toISOString();

			// Create a thread
			db.prepare(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(threadId, "user1", "web", "localhost:3000", 3, "Test Thread", now, now, now);

			// Create a memory with this thread as source
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "mem1", "value1", "default", threadId, now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<{
					key: string;
					sourceThreadTitle: string | null;
					lineIndex: number | null;
				}>;
				edges: Array<unknown>;
			};

			expect(body.nodes).toHaveLength(1);
			const node = body.nodes[0];

			// Verify AC3.4: thread title and color resolved
			expect(node.sourceThreadTitle).toBe("Test Thread");
			expect(node.lineIndex).toBe(3);
		});

		it("returns null for source that is not a thread", async () => {
			const now = new Date().toISOString();

			// Create a memory with non-thread source
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "mem1", "value1", "default", "agent", now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<{
					key: string;
					sourceThreadTitle: string | null;
					lineIndex: number | null;
				}>;
			};

			expect(body.nodes).toHaveLength(1);
			const node = body.nodes[0];

			// Verify AC3.4: non-thread source has null resolved values
			expect(node.sourceThreadTitle).toBeNull();
			expect(node.lineIndex).toBeNull();
		});

		it("returns null for deleted source thread", async () => {
			const threadId = randomUUID();
			const now = new Date().toISOString();

			// Create a deleted thread
			db.prepare(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
			).run(threadId, "user1", "web", "localhost:3000", 3, "Deleted Thread", now, now, now);

			// Create a memory with this thread as source
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(randomUUID(), "mem1", "value1", "default", threadId, now, now);

			// Fetch via API
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				nodes: Array<{
					key: string;
					sourceThreadTitle: string | null;
					lineIndex: number | null;
				}>;
			};

			expect(body.nodes).toHaveLength(1);
			const node = body.nodes[0];

			// Verify AC3.4: deleted thread source has null resolved values
			expect(node.sourceThreadTitle).toBeNull();
			expect(node.lineIndex).toBeNull();
		});
	});

	describe("Response structure", () => {
		it("returns empty arrays when no data exists", async () => {
			const res = await app.fetch(new Request("http://localhost/graph"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as { nodes: Array<unknown>; edges: Array<unknown> };

			expect(body).toHaveProperty("nodes");
			expect(body).toHaveProperty("edges");
			expect(body.nodes).toEqual([]);
			expect(body.edges).toEqual([]);
		});
	});
});
