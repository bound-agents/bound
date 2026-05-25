import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assembleContext, buildVolatileContext } from "../context-assembly";
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
	makeTask,
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
		const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			nowMs,
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
			nowMs,
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
			nowMs,
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
			nowMs,
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
		ctx.userId = userId; // Ensure sibling threads are created with same user for digest inclusion

		// Create scenario with multiple entries to trigger budget pressure while remaining reviewable
		// Working Knowledge should preserve full fidelity (R-VC14 §3.3)
		makePinned(ctx, 5);
		const summaryKeys = makeSummary(ctx, 5);
		for (let i = 0; i < 30; i++) {
			makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
		}

		// Create additional subsystem entries so Live State demonstrates BUDGET_PRESSURE_SUBSYSTEM_CAP (3) per subsystem
		// R-VC14 + R-MV13 mandate cap of most-recent-3 per subsystem in Live State
		const siblingThread0 = makeSiblingThread(ctx, "sibling-0", 2, "Summary of sibling thread 0");
		const siblingThread1 = makeSiblingThread(ctx, "sibling-1", 3, "Summary of sibling thread 1");
		const siblingThread2 = makeSiblingThread(ctx, "sibling-2", 1, "Summary of sibling thread 2");
		makeSiblingThread(ctx, "sibling-3", 4, null);
		makeSiblingThread(ctx, "sibling-4", 2, "Summary of sibling thread 4");

		// Use current time for advisories so they fall within the 24-hour window checked by loadAppliedAdvisoriesForLiveState
		makeAppliedAdvisory(ctx, "Advisory A", 2, true);
		makeAppliedAdvisory(ctx, "Advisory B", 1, true);
		makeAppliedAdvisory(ctx, "Advisory C", 3, true);
		makeAppliedAdvisory(ctx, "Advisory D", 0.5, true);
		makeAppliedAdvisory(ctx, "Advisory E", 4, true);

		makeTask(ctx, "debug", "Task Alpha", 1);
		makeTask(ctx, "analyze", "Task Beta", 0.5);
		makeTask(ctx, "monitor", "Task Gamma", 2);
		makeTask(ctx, "deploy", "Task Delta", 0.1);
		makeTask(ctx, "verify", "Task Epsilon", 3);

		// File modifications must be from OTHER threads to show in Live State (R-E20)
		makeFileMod(ctx, "src/main.ts", siblingThread0);
		makeFileMod(ctx, "docs/README.md", siblingThread1);
		makeFileMod(ctx, "config/settings.json", siblingThread2);
		makeFileMod(ctx, "test/fixtures.ts", siblingThread0);
		makeFileMod(ctx, "build/output.js", siblingThread1);

		// Call assembleContext with tight contextWindow (1500) to fire applyReducedEnrichment.
		// With memory state (5 pinned, 5 summary, 30 detail) plus multiple Live State entries,
		// the volatile enrichment will exceed headroom, triggering budget-pressure rebuild
		// with applyReducedEnrichment path (Live State subsystems capped to 3 each).
		// After the suffix-prefix split, volatile content is split across the
		// stable system prompt (Working Knowledge bodies + Discoverable Archive
		// titles + skill index) and the developer tail (Working Knowledge update
		// markers + Live State + advisory/skill notifications + suffix). Extract
		// the volatile portion from systemPrompt by slicing from the first
		// volatile section header, then concatenate with the developer tail.
		const result = assembleContext({
			db,
			threadId,
			userId,
			siteId,
			contextWindow: 1500, // Tight constraint to force budget-pressure path
			messages: [],
			tools: [],
		});

		// Stable volatile portion: everything from the first volatile section
		// header onward (the section headers are stable identifiers).
		const stableMarker = "## Working Knowledge — operational and durable";
		const stableMarkerIdx = result.systemPrompt.indexOf(stableMarker);
		const stableVolatile = stableMarkerIdx >= 0 ? result.systemPrompt.slice(stableMarkerIdx) : "";

		// Varying tail: the developer message at the assembled tail.
		let devContent = "";
		for (const msg of result.messages) {
			if (msg.role === "developer") {
				devContent = typeof msg.content === "string" ? msg.content : "";
				break;
			}
		}

		const combined = `${stableVolatile}\n\n--- VARYING TAIL ---\n${devContent}`;

		await assertSnapshot(
			combined,
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
			nowMs,
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
			nowMs,
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
				id: deterministicUUID(BOUND_NAMESPACE, multilineKey),
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
			nowMs,
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
			nowMs,
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
				id: deterministicUUID(BOUND_NAMESPACE, "_summary:non-compliant"),
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
			nowMs,
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
		// Pass userId to builder context so sibling threads are created with the same user
		ctx.userId = userId;

		// Create memory baseline
		makePinned(ctx, 10);
		const summaryKeys = makeSummary(ctx, 5);
		makeDetail(ctx, 10, summaryKeys[0]);

		// Add sibling threads for cross-thread digest (they need summaries to be visible)
		// They're created with the same userId as the agent so they show in the digest
		const siblingThread1 = makeSiblingThread(ctx, "Related Thread 1", 2, "Thread summary 1");
		const siblingThread2 = makeSiblingThread(ctx, "Related Thread 2", 2, "Thread summary 2");

		// Add file modifications (stored as _internal.file_thread.* entries pointing to thread IDs)
		makeFileMod(ctx, "/src/main.ts", siblingThread1);
		makeFileMod(ctx, "/src/utils.ts", siblingThread2);

		// Add advisories (must have status='applied' and resolved_at within 24h
		// of the assembly's `nowMs`). Anchor to ctx.nowMs (the injected fixture
		// time) so the 24h window check inside buildVolatileContext — which
		// receives the SAME nowMs — finds them deterministically across days.
		makeAppliedAdvisory(ctx, "Advisory 1", 1, false);
		makeAppliedAdvisory(ctx, "Advisory 2", 2, false);

		// Add tasks (must have status='running' and last_run_at within recent window).
		// Tasks are included in the digest if they were recently active (within ~24h based on buildVolatileEnrichment logic).
		makeTask(ctx, "webhook", "Task 1", 0.5);
		makeTask(ctx, "cron", "Task 2", 1);
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			nowMs,
		});

		await assertSnapshot(
			result.content,
			join(__dirname, "fixtures/volatile-context/live-state-four-subsystems.snap.txt"),
		);

		db.close();
	});
});
