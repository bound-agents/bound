import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { upsertEdge } from "../graph-queries.js";
import { loadGraphEntries } from "../summary-extraction.js";

let db: Database;
let dbPath: string;
const siteId = randomBytes(8).toString("hex");

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-load-graph-entries-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("loadGraphEntries — graph-tag normalization to [graph]", () => {
	it("seed entry tag is normalized to [graph]", () => {
		// Create a seed memory that will match keywords
		const seedMem = {
			id: randomBytes(8).toString("hex"),
			key: "scheduler_design",
			value: "The scheduler informs task scheduling for cron patterns",
			source: null,
			created_at: "2026-02-01T00:00:00.000Z",
			modified_at: "2026-02-15T12:00:00.000Z",
			deleted: 0,
			tier: "default",
		};

		// Create a descendant memory to be found via graph traversal
		const linkedMem = {
			id: randomBytes(8).toString("hex"),
			key: "cron_patterns",
			value: "Cron format supports minute hour day-of-month month day-of-week",
			source: null,
			created_at: "2026-02-01T00:00:00.000Z",
			modified_at: "2026-02-20T12:00:00.000Z",
			deleted: 0,
			tier: "default",
		};

		insertRow(db, "semantic_memory", seedMem, siteId);
		insertRow(db, "semantic_memory", linkedMem, siteId);

		// Create edge from seed to linked memory
		upsertEdge(db, seedMem.key, linkedMem.key, "informs", 0.8, siteId);

		// Load graph entries with the seed keyword
		const result = loadGraphEntries(db, new Set(), ["scheduler"], 10);

		// Find the seed entry (the one that matched the keyword "scheduler")
		const seedEntry = result.entries.find((e) => e.key === "scheduler_design");

		expect(seedEntry).toBeDefined();
		if (seedEntry) {
			// The seed entry tag should be exactly "[graph]", not "[seed]"
			expect(seedEntry.tag).toBe("[graph]");
		}
	});

	it("graph descendant tag is normalized to [graph]", () => {
		// Create a seed memory that will match keywords
		const seedMem = {
			id: randomBytes(8).toString("hex"),
			key: "memory_architecture",
			value: "Memory stores semantic relationships for graph traversal",
			source: null,
			created_at: "2026-02-01T00:00:00.000Z",
			modified_at: "2026-02-15T12:00:00.000Z",
			deleted: 0,
			tier: "default",
		};

		// Create a descendant memory to be found via graph traversal
		const descendantMem = {
			id: randomBytes(8).toString("hex"),
			key: "semantic_edges",
			value: "Edges connect memory entries with weighted relationships",
			source: null,
			created_at: "2026-02-01T00:00:00.000Z",
			modified_at: "2026-02-20T12:00:00.000Z",
			deleted: 0,
			tier: "default",
		};

		insertRow(db, "semantic_memory", seedMem, siteId);
		insertRow(db, "semantic_memory", descendantMem, siteId);

		// Create edge from seed to descendant
		upsertEdge(db, seedMem.key, descendantMem.key, "supports", 0.9, siteId);

		// Load graph entries with the seed keyword
		const result = loadGraphEntries(db, new Set(), ["memory"], 10);

		// Find the descendant entry (found via graph traversal, not keyword match)
		const descendantEntry = result.entries.find((e) => e.key === "semantic_edges");

		expect(descendantEntry).toBeDefined();
		if (descendantEntry) {
			// The descendant entry tag should be exactly "[graph]", not "[depth N, relation]"
			expect(descendantEntry.tag).toBe("[graph]");
		}
	});
});
