/**
 * Coverage for buildConsolidationContext and its private section builders.
 *
 * Exercises every branch of candidate grouping, stale-summary detection, and
 * the memory-pressure stats block against a real schema'd SQLite DB.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import {
	DEFAULT_CONSOLIDATION_INTERVAL_MS,
	buildConsolidationContext,
} from "../consolidation-context";

const SITE = "00000000-0000-0000-0000-00000000c0de";

function addMemory(
	db: Database,
	key: string,
	value: string,
	opts: { tier?: string; modifiedAt?: string } = {},
): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"semantic_memory",
		{
			id: randomUUID(),
			key,
			value,
			source: "test",
			created_at: now,
			modified_at: opts.modifiedAt ?? now,
			last_accessed_at: now,
			deleted: 0,
			tier: opts.tier ?? "default",
			agent_id: null,
		},
		SITE,
	);
}

function addEdge(db: Database, sourceKey: string, targetKey: string): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"memory_edges",
		{
			id: randomUUID(),
			source_key: sourceKey,
			target_key: targetKey,
			relation: "summarizes",
			weight: 1,
			created_at: now,
			modified_at: now,
			deleted: 0,
			context: null,
			agent_id: null,
		},
		SITE,
	);
}

describe("buildConsolidationContext", () => {
	let tmpDir: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `consol-ctx-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
	});

	beforeEach(() => {
		db.run("DELETE FROM semantic_memory");
		db.run("DELETE FROM memory_edges");
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("exports a 4-hour default interval", () => {
		expect(DEFAULT_CONSOLIDATION_INTERVAL_MS).toBe(14_400_000);
	});

	it("uses the default instruction text when no custom policy is stored", () => {
		const out = buildConsolidationContext(db);
		expect(out).toContain("scheduled memory consolidation pass");
		expect(out).toContain("Identify clusters of 3+ related entries");
		expect(out).toContain("No unconsolidated entries found.");
		expect(out).toContain("No stale summaries found.");
	});

	it("loads custom standing instructions from _consolidation_instructions", () => {
		addMemory(db, "_consolidation_instructions", "Custom rule: never merge code notes.");
		const out = buildConsolidationContext(db);
		expect(out).toContain("Custom rule: never merge code notes.");
		expect(out).not.toContain("Identify clusters of 3+ related entries");
	});

	it("surfaces clusters of 3+ entries without a summary, grouping date suffixes together", () => {
		addMemory(db, "curiosity:topic-a:2026-01-01", "first body about topic a");
		addMemory(db, "curiosity:topic-a:2026-02-02", "second body about topic a");
		addMemory(db, "curiosity:topic-a:2025-12-31", "third body about topic a");
		const out = buildConsolidationContext(db);
		expect(out).toContain("### curiosity:topic-a (3 entries)");
		expect(out).toContain("curiosity:topic-a:2026-01-01: first body about topic a");
	});

	it("drops clusters below 3 entries and ones that already have a summary", () => {
		// Only two entries -> below threshold.
		addMemory(db, "research:small:2026-01-01", "a");
		addMemory(db, "research:small:2026-01-02", "b");
		// Three entries but a summary already exists.
		addMemory(db, "curiosity:done:2026-01-01", "x");
		addMemory(db, "curiosity:done:2026-01-02", "y");
		addMemory(db, "curiosity:done:2026-01-03", "z");
		addMemory(db, "_summary:curiosity:done", "existing summary", { tier: "summary" });
		const out = buildConsolidationContext(db);
		expect(out).toContain("All candidate clusters already have summaries.");
		expect(out).not.toContain("### curiosity:done");
		expect(out).not.toContain("### research:small");
	});

	it("keeps keys with no colon and non-date trailing segments ungrouped", () => {
		// No colon at all -> groupKey is the whole key; three distinct keys so no cluster.
		addMemory(db, "curiosity:plain-one", "p1");
		addMemory(db, "curiosity:plain-two", "p2");
		addMemory(db, "curiosity:plain-three", "p3");
		const out = buildConsolidationContext(db);
		// Each groups under its own full key (last segment not a 2025/2026 date),
		// so no 3-entry cluster forms.
		expect(out).toContain("All candidate clusters already have summaries.");
	});

	it("reports stale summaries whose children were modified after the summary", () => {
		const old = "2026-01-01T00:00:00.000Z";
		const newer = "2026-06-01T00:00:00.000Z";
		addMemory(db, "_summary:topic", "summary body", { tier: "summary", modifiedAt: old });
		addMemory(db, "curiosity:topic:child", "child body", { modifiedAt: newer });
		addEdge(db, "_summary:topic", "curiosity:topic:child");
		const out = buildConsolidationContext(db);
		expect(out).toContain("_summary:topic: 1 children modified since last summary");
	});

	it("does not report summaries whose children predate them", () => {
		const newer = "2026-06-01T00:00:00.000Z";
		const old = "2026-01-01T00:00:00.000Z";
		addMemory(db, "_summary:fresh", "summary body", { tier: "summary", modifiedAt: newer });
		addMemory(db, "curiosity:fresh:child", "child body", { modifiedAt: old });
		addEdge(db, "_summary:fresh", "curiosity:fresh:child");
		const out = buildConsolidationContext(db);
		expect(out).toContain("No stale summaries found.");
	});

	it("renders the memory-pressure stats block with per-tier counts and total", () => {
		addMemory(db, "curiosity:p:2026-01-01", "a", { tier: "default" });
		addMemory(db, "_summary:p", "s", { tier: "summary" });
		addMemory(db, "_pinned:p", "pin", { tier: "pinned" });
		const out = buildConsolidationContext(db);
		// Three rows across three tiers.
		expect(out).toMatch(/3 total \(/);
		expect(out).toContain("default=1");
		expect(out).toContain("summary=1");
		expect(out).toContain("pinned=1");
	});
});
