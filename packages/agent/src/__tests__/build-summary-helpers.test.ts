import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import {
	type StageEntry,
	buildParentSummaryMap,
	buildStaleChildrenMap,
} from "../summary-extraction";

const TEST_SITE_ID = "test-site-00000000-0000-0000-0000-000000000000";

describe("buildParentSummaryMap", () => {
	let db: Database;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "build-summary-helpers-"));
		db = new Database(join(tmpDir, "test.db"));
		applySchema(db);
	});

	afterEach(() => {
		db.close();
		cleanupTmpDir(tmpDir);
	});

	test("Empty input keys returns empty map", () => {
		const result = buildParentSummaryMap(db, []);
		expect(result.size).toBe(0);
	});

	test("One detail key with one summarizes edge returns map with that entry", () => {
		// Insert a parent summary entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a summarizes edge from parent to child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(1);
		expect(result.get("detail:key1")).toBe("_summary:topic1");
	});

	test("One detail key with no edges is absent from map", () => {
		// Insert a detail entry with no incoming summarizes edges
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:orphan",
				value: "Orphan detail",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:orphan"]);
		expect(result.size).toBe(0);
		expect(result.has("detail:orphan")).toBe(false);
	});

	test("Multiple keys, mixed with and without parents", () => {
		// Insert parent summaries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent1-id",
				key: "_summary:topic1",
				value: "Parent 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent2-id",
				key: "_summary:topic2",
				value: "Parent 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert detail entries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child1-id",
				key: "detail:key1",
				value: "Child 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "child2-id",
				key: "detail:key2",
				value: "Child 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "orphan-id",
				key: "detail:orphan",
				value: "Orphan",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edges
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic2",
				target_key: "detail:key2",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1", "detail:key2", "detail:orphan"]);
		expect(result.size).toBe(2);
		expect(result.get("detail:key1")).toBe("_summary:topic1");
		expect(result.get("detail:key2")).toBe("_summary:topic2");
		expect(result.has("detail:orphan")).toBe(false);
	});

	test("Soft-deleted edges are ignored", () => {
		// Insert a parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a deleted edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 1,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(0);
	});

	test("First-seen-wins on duplicate edges (multiple parents for same child)", () => {
		// Insert two parent summaries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent1-id",
				key: "_summary:topic1",
				value: "Parent 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent2-id",
				key: "_summary:topic2",
				value: "Parent 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert two edges from different parents to the same child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic2",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(1);
		// Should pick the first-seen parent (depends on SQL result order)
		const parent = result.get("detail:key1");
		expect(parent === "_summary:topic1" || parent === "_summary:topic2").toBe(true);
	});
});

describe("buildStaleChildrenMap", () => {
	let db: Database;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "build-summary-helpers-"));
		db = new Database(join(tmpDir, "test.db"));
		applySchema(db);
	});

	afterEach(() => {
		db.close();
		cleanupTmpDir(tmpDir);
	});

	test("Empty input summaries returns empty map", () => {
		const result = buildStaleChildrenMap(db, []);
		expect(result.size).toBe(0);
	});

	test("One summary with one stale child (child.modified_at > summary.modified_at)", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child (modified later)
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create summarizes edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(1);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.length).toBe(1);
		expect(staleChildren?.[0].key).toBe("detail:key1");
		expect(staleChildren?.[0].tag).toBe("[stale-detail]");
	});

	test("One summary with one fresh child (child.modified_at <= summary.modified_at)", () => {
		const parentTime = "2026-05-23T11:00:00.000Z";
		const childTime = "2026-05-23T10:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert fresh child (modified earlier)
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create summarizes edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(0);
	});

	test("Mixed stale and fresh children under one parent", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const staleTime = "2026-05-23T11:00:00.000Z";
		const freshTime = "2026-05-23T09:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "stale-child-id",
				key: "detail:stale",
				value: "Stale child",
				source: null,
				created_at: staleTime,
				modified_at: staleTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert fresh child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "fresh-child-id",
				key: "detail:fresh",
				value: "Fresh child",
				source: null,
				created_at: freshTime,
				modified_at: freshTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edges
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:stale",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic1",
				target_key: "detail:fresh",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(1);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.length).toBe(1);
		expect(staleChildren?.[0].key).toBe("detail:stale");
	});

	test("Soft-deleted child entries are ignored", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert soft-deleted child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 1,
			},
			TEST_SITE_ID,
		);

		// Create edge to the deleted child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(0);
	});

	test("Returned StageEntry tag is '[stale-detail]'", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.[0].tag).toBe("[stale-detail]");
	});
});
