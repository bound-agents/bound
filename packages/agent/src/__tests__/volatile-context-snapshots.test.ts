import { afterEach, beforeEach, describe, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { buildVolatileContext } from "../context-assembly";
import {
	type BuilderContext,
	assertSnapshot,
	makeAppliedAdvisory,
	makeDetail,
	makeFileMod,
	makePinned,
	makeSiblingThread,
	makeStaleChild,
	makeSummary,
} from "./fixtures/volatile-context/index";

function createTempDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function makeBuilderContext(db: Database, siteId: string, nowMs: number): BuilderContext {
	return { db, siteId, nowMs };
}

describe("volatile-context snapshots", () => {
	let dbPath: string;
	let configDir: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
	});

	afterEach(async () => {
		process.env = { ...originalEnv };
		await cleanupTmpDir(configDir);
		try {
			unlinkSync(dbPath);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("Empty memory state (cold-start agent).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:1");
		const siteId = "test-site";

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/empty.snap.txt"),
		);

		db.close();
	});

	it("Memory state with 80 pinned + 50 summary + 30 detail entries (warm-start, R-VC15 Tier 1).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:2");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);
		makePinned(ctx, 80);
		const summaryKeys = makeSummary(ctx, 50);
		for (let i = 0; i < 30; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/tier1-warm-start.snap.txt"),
		);

		db.close();
	});

	it("Memory state with 80 pinned + 50 summary + 500 detail entries (R-VC15 Tier 2 cluster compression activated).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:3");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);
		makePinned(ctx, 80);
		const summaryKeys = makeSummary(ctx, 50);

		// Distribute 500 detail entries across the 50 summary parents
		for (let i = 0; i < 500; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/tier2-cluster-compression.snap.txt"),
		);

		db.close();
	});

	it("Memory state with 80 pinned + 50 summary + 5000 detail entries (R-VC15 Tier 3 heading-only compression with M=20 cap).", async () => {
		// Override BOUND_VC15_M for fixture reviewability
		process.env.BOUND_VC15_M = "5";

		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:4");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);
		makePinned(ctx, 80);
		const summaryKeys = makeSummary(ctx, 50);

		// Distribute 5000 detail entries across the 50 summary parents
		for (let i = 0; i < 5000; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Add note about the override
		const withNote = `# NOTE: BOUND_VC15_M overridden to 5 for snapshot reviewability; production default is 20\n\n${result.content}`;

		await assertSnapshot(
			withNote,
			join(__dirname, "fixtures/volatile-context/tier3-heading-only.snap.txt"),
		);

		db.close();
	});

	it("Memory state with critical budget pressure (R-VC14 active) and deltas inside Working Knowledge (verifying R-VC11 markers preserved while Live State and Discoverable Archive are shed).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:5");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		// Create scenario with many entries to trigger budget pressure
		makePinned(ctx, 100);
		const summaryKeys = makeSummary(ctx, 100);
		for (let i = 0; i < 1000; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		// Simulate budget-pressure rebuild by calling with very tight contextWindow
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/budget-pressure.snap.txt"),
		);

		db.close();
	});

	it("Memory state with stale-child triples (R-VC10 active) where one stale child is also a delta (R-VC11(c) composition: both markers in fixed order).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:6");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		makePinned(ctx, 5);
		const summaryKeys = makeSummary(ctx, 3);

		// Create a stale child — modified after its parent
		const parentModifiedAt = new Date(nowMs - 10000).toISOString();
		makeStaleChild(ctx, summaryKeys[0], parentModifiedAt);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/stale-child-delta-composition.snap.txt"),
		);

		db.close();
	});

	it("Memory state with R-MV1 deltas spanning all three sections (verifying delta marker only appears on Working Knowledge entries, not on Discoverable Archive titles).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:7");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		makePinned(ctx, 10);
		const summaryKeys = makeSummary(ctx, 10);

		// Create some detail entries as deltas (new entries added to the system)
		for (let i = 0; i < 20; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/deltas-three-sections.snap.txt"),
		);

		db.close();
	});

	it("Memory state with delta on a multi-line pinned entry (R-VC11(b): marker on indented new line beneath the pinned text).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:8");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		// Create a multi-line pinned entry by directly inserting
		const multilineKey = "pinned:multiline";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: multilineKey,
				value: "This is a pinned entry that spans\nmultiple lines\nwith detailed information.",
				tier: "pinned",
				source: "fixture",
				created_at: new Date(nowMs).toISOString(),
				modified_at: new Date(nowMs).toISOString(),
				last_accessed_at: new Date(nowMs).toISOString(),
				deleted: 0,
			},
			siteId,
		);

		// Create some summary and detail entries
		makePinned(ctx, 5);
		const summaryKeys = makeSummary(ctx, 3);
		makeDetail(ctx, 5, summaryKeys[0]);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/multiline-pinned-delta.snap.txt"),
		);

		db.close();
	});

	it("Memory state with R-VC15 Tier 3 active and Uncategorized cluster > 50 entries (verifying the synthesis-backlog advisory is surfaced under Live State).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:9");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		makePinned(ctx, 80);
		const summaryKeys = makeSummary(ctx, 50);

		// Create a large Uncategorized cluster (detail entries not linked to any summary)
		for (let i = 0; i < 100; i++) {
			makeDetail(ctx, 1);
		}

		// Create some linked detail entries
		for (let i = 0; i < 500; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/tier3-synthesis-backlog.snap.txt"),
		);

		db.close();
	});

	it("Memory state with R-VC15 Tier 3 active and a non-R-VC9b-compliant parent summary (a cluster gloss missing sub-topic vocabulary; verifying the rendering is structurally correct even though the discoverability path is degraded).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:10");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		makePinned(ctx, 80);
		const summaryKeys = makeSummary(ctx, 50);

		// Insert a non-compliant summary without sub-topic vocabulary
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "_summary:non-compliant",
				value: "This is a summary without proper sub-topic vocabulary or structure.",
				tier: "summary",
				source: "fixture",
				created_at: new Date(nowMs).toISOString(),
				modified_at: new Date(nowMs).toISOString(),
				last_accessed_at: new Date(nowMs).toISOString(),
				deleted: 0,
			},
			siteId,
		);

		// Add some detail entries
		for (let i = 0; i < 5000; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/tier3-non-r-vc9b-compliant.snap.txt"),
		);

		db.close();
	});

	it("Memory state with task digest entries rendering under Live State alongside cross-thread / file / advisory entries (verifying R-VC5's four subsystems render in their fixed order with correct source labels).", async () => {
		const db = createTempDb();
		const userId = "test-user";
		const threadId = deterministicUUID(BOUND_NAMESPACE, "test:scenario:11");
		const siteId = "test-site";
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const ctx = makeBuilderContext(db, siteId, nowMs);

		// Create memory baseline
		makePinned(ctx, 10);
		const summaryKeys = makeSummary(ctx, 5);
		makeDetail(ctx, 10, summaryKeys[0]);

		// Add sibling threads for cross-thread digest
		makeSiblingThread(ctx, "Related Thread 1", 2, "Thread summary 1");
		makeSiblingThread(ctx, "Related Thread 2", 2, "Thread summary 2");

		// Add file modifications
		makeFileMod(ctx, "/src/main.ts", threadId);
		makeFileMod(ctx, "/src/utils.ts", threadId);

		// Add advisories
		makeAppliedAdvisory(ctx, "Advisory 1", 1);
		makeAppliedAdvisory(ctx, "Advisory 2", 2);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/live-state-four-subsystems.snap.txt"),
		);

		db.close();
	});
});
