import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applySchema } from "@bound/core";
import { randomUUID } from "@bound/shared";
import { buildVolatileContext } from "../context-assembly";
import {
	WORKING_KNOWLEDGE_DEMOTED_HEADER,
	WORKING_KNOWLEDGE_FOOTER,
	WORKING_KNOWLEDGE_SUMMARY_CAP,
} from "../summary-extraction";

/**
 * Test-only fixture helper. Bypasses insertRow because these tests exercise rendering,
 * not sync flow. Production code MUST use insertRow per CONTRIBUTING.md §1.
 */
function dbInsert(db: Database, table: string, row: Record<string, unknown>) {
	const cols = Object.keys(row);
	const placeholders = cols.map(() => "?").join(",");
	const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`;
	db.prepare(sql).run(...Object.values(row));
}

function createTempDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

describe("volatile-context-integration", () => {
	let db: Database;
	const userId = "test-user";
	const threadId = "test-thread";
	const siteId = "test-site";

	beforeEach(() => {
		db = createTempDb();
	});

	afterEach(() => {
		db.close();
	});

	test("Three sections render in fixed order R-VC1 with correct headers", () => {
		// Create minimal fixture: one pinned, one summary, one detail
		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "pinned:test",
			value: "Pinned value",
			tier: "pinned",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:topic1",
			value: "Summary value for topic1",
			tier: "summary",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			currentModel: "test-model",
		});

		expect(result.content).toContain("## Working Knowledge — operational and durable");
		expect(result.content).toContain(
			"## Discoverable Archive — title-only; bodies via memory search",
		);
		expect(result.content).toContain("## Live State — pointers to canonical sources");

		// Verify order: Working Knowledge before Discoverable Archive before Live State
		const wkIdx = result.content.indexOf("## Working Knowledge");
		const daIdx = result.content.indexOf("## Discoverable Archive");
		const lsIdx = result.content.indexOf("## Live State");

		expect(wkIdx).toBeGreaterThan(0);
		expect(daIdx).toBeGreaterThan(wkIdx);
		expect(lsIdx).toBeGreaterThan(daIdx);
	});

	test("No trailing meta-instruction 'Do not mention'", () => {
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).not.toContain("Do not mention");
	});

	test("No standalone 'Memory: ' callout", () => {
		// Create a delta entry to trigger memory content
		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "test:entry",
			value: "Test value",
			tier: "detail",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Should NOT contain standalone "Memory: " header
		const lines = result.content.split("\n");
		const hasMemoryHeader = lines.some((line) => line.match(/^Memory:\s+\d+\s+entries/));
		expect(hasMemoryHeader).toBe(false);
	});

	test("No 'Recent Activity Digest:' header", () => {
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).not.toContain("Recent Activity Digest:");
	});

	test("In-place delta marker on summary entry", () => {
		// Insert a summary entry modified after baseline
		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:changed",
			value: "Summary that was changed",
			tier: "summary",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Should contain delta marker in the summary line
		expect(result.content).toContain("[changed since last turn]");
		// Should NOT contain standalone "Memory: " header
		expect(result.content).not.toMatch(/^Memory:\s+/m);
	});

	test("Footer for each section is present", () => {
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Each section should have its footer
		expect(result.content).toContain(
			"Bodies of summary entries are accessed via memory search using terms from the entry key.",
		);
		expect(result.content).toContain(
			"Bodies are accessed via memory search or query against semantic_memory.",
		);
		expect(result.content).toContain(
			"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.",
		);
	});

	test("Three sections persist with many sibling threads", () => {
		// Create 10 sibling threads to exercise multi-thread rendering
		for (let i = 0; i < 10; i++) {
			dbInsert(db, "threads", {
				id: `thread-${i}`,
				user_id: userId,
				interface: "test",
				host_origin: "test-host",
				deleted: 0,
				created_at: new Date(Date.now() - (10 - i) * 1000).toISOString(),
				last_message_at: new Date(Date.now() - (10 - i) * 1000).toISOString(),
				modified_at: new Date().toISOString(),
			});

			// Add a message to each thread so it appears in cross-thread digest
			dbInsert(db, "messages", {
				id: `msg-${i}`,
				thread_id: `thread-${i}`,
				role: "user",
				content: `Message ${i}`,
				host_origin: "test-host",
				deleted: 0,
				created_at: new Date(Date.now() - (10 - i) * 1000).toISOString(),
			});
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Should have the three sections
		expect(result.content).toContain("## Working Knowledge");
		expect(result.content).toContain("## Live State");

		// Live State should reference cross-thread entries
		expect(result.content).toContain("[thread]");
	});

	test("Working Knowledge entries render with full content", () => {
		// Insert pinned and summary entries
		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "pinned:important",
			value: "This is important pinned context that should be preserved",
			tier: "pinned",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:always-show",
			value: "Summary that should always be shown even with budget pressure",
			tier: "summary",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			deleted: 0,
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Both pinned and summary should be present with full content
		expect(result.content).toContain("pinned:important");
		expect(result.content).toContain("_summary:always-show");
	});

	test("Discoverable Archive Tier-2 cluster transition", () => {
		// Create parent summaries and detail entries per topic to trigger Tier-2
		// Tier-2 activates when total detail entries > 200 (by default BOUND_VC15_N=1000,
		// but in integration tests we use default tunables which may vary).
		// To reliably test Tier-2, create 250 detail entries split across topic1 and topic2.
		// To avoid entries being marked as "stale children" in Working Knowledge,
		// set the summaries' modified_at to be LATER than the details' modified_at.
		const detailTime = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
		const summaryTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago (newer)

		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:topic1",
			value: "Topic 1 summary",
			tier: "summary",
			created_at: summaryTime,
			modified_at: summaryTime,
			deleted: 0,
		});

		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:topic2",
			value: "Topic 2 summary",
			tier: "summary",
			created_at: summaryTime,
			modified_at: summaryTime,
			deleted: 0,
		});

		// Create 125 detail entries per topic (250 total) to trigger Tier-2 clustering
		for (let i = 0; i < 125; i++) {
			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `detail:topic1:${i}`,
				value: `Detail for topic1 entry ${i}`,
				tier: "detail",
				created_at: detailTime,
				modified_at: detailTime,
				deleted: 0,
			});

			dbInsert(db, "memory_edges", {
				id: randomUUID(),
				created_at: detailTime,
				modified_at: detailTime,
				source_key: "_summary:topic1",
				target_key: `detail:topic1:${i}`,
				relation: "summarizes",
				deleted: 0,
			});

			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `detail:topic2:${i}`,
				value: `Detail for topic2 entry ${i}`,
				tier: "detail",
				created_at: detailTime,
				modified_at: detailTime,
				deleted: 0,
			});

			dbInsert(db, "memory_edges", {
				id: randomUUID(),
				created_at: detailTime,
				modified_at: detailTime,
				source_key: "_summary:topic2",
				target_key: `detail:topic2:${i}`,
				relation: "summarizes",
				deleted: 0,
			});
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Assert Discoverable Archive section present
		expect(result.content).toContain("## Discoverable Archive");

		// Assert Tier-2 cluster headings for both topics with entry counts
		// Format: "### topic1 (125 entries)" and "### topic2 (125 entries)"
		expect(result.content).toMatch(/### topic1\s*\(\d+\s+entries\)/);
		expect(result.content).toMatch(/### topic2\s*\(\d+\s+entries\)/);
	});

	test("Discoverable Archive Tier-3 with synthesis-backlog", () => {
		// Tier-3 activates when total detail entries > BOUND_VC15_N (default 1000).
		// Create 1040 categorized entries (parents are summaries) and 60 uncategorized.
		// This tests that when uncategorized count > 50, synthesis-backlog is signaled.
		// To avoid entries being marked as stale children, set summaries' modified_at
		// to be LATER than the details' modified_at.

		const detailTime = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
		const summaryTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago (newer)

		// First create 2 summaries to parent the categorized entries
		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:category_a",
			value: "Category A summary",
			tier: "summary",
			created_at: summaryTime,
			modified_at: summaryTime,
			deleted: 0,
		});

		dbInsert(db, "semantic_memory", {
			id: randomUUID(),
			key: "_summary:category_b",
			value: "Category B summary",
			tier: "summary",
			created_at: summaryTime,
			modified_at: summaryTime,
			deleted: 0,
		});

		// Create 1040 categorized detail entries (520 per category)
		for (let i = 0; i < 520; i++) {
			// Category A entries
			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `cat_a:entry_${i}`,
				value: `Category A detail ${i}`,
				tier: "detail",
				created_at: detailTime,
				modified_at: detailTime,
				deleted: 0,
			});

			dbInsert(db, "memory_edges", {
				id: randomUUID(),
				created_at: detailTime,
				modified_at: detailTime,
				source_key: "_summary:category_a",
				target_key: `cat_a:entry_${i}`,
				relation: "summarizes",
				deleted: 0,
			});

			// Category B entries
			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `cat_b:entry_${i}`,
				value: `Category B detail ${i}`,
				tier: "detail",
				created_at: detailTime,
				modified_at: detailTime,
				deleted: 0,
			});

			dbInsert(db, "memory_edges", {
				id: randomUUID(),
				created_at: detailTime,
				modified_at: detailTime,
				source_key: "_summary:category_b",
				target_key: `cat_b:entry_${i}`,
				relation: "summarizes",
				deleted: 0,
			});
		}

		// Create 60 uncategorized detail entries (no parent edges)
		for (let i = 0; i < 60; i++) {
			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `uncategorized:${i}`,
				value: `Uncategorized detail ${i}`,
				tier: "detail",
				created_at: detailTime,
				modified_at: detailTime,
				deleted: 0,
			});
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Assert Discoverable Archive section present
		expect(result.content).toContain("## Discoverable Archive");

		// Tier-3 should be active (1100 total entries > 1000), and uncategorized count (60) > 50,
		// so synthesis-backlog should be signaled in Live State
		expect(result.content).toContain("[synthesis-backlog] 60 uncategorized detail entries");
	});

	test("Cross-thread digest summary excerpt absent", () => {
		// Create two sibling threads with summaries
		dbInsert(db, "threads", {
			id: "sibling-thread-1",
			user_id: userId,
			interface: "test",
			host_origin: "test-host",
			deleted: 0,
			created_at: new Date().toISOString(),
			last_message_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			summary: "This is a thread summary",
		});

		dbInsert(db, "messages", {
			id: "msg-sibling-1",
			thread_id: "sibling-thread-1",
			role: "user",
			content: "Message in sibling thread",
			host_origin: "test-host",
			deleted: 0,
			created_at: new Date().toISOString(),
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Should NOT contain "Summary: " in cross-thread digest
		expect(result.content).not.toContain("Summary: ");
	});

	test("Skills index and skill retirement notes preserved", () => {
		// Create an active skill
		dbInsert(db, "skills", {
			id: "test-skill-id",
			name: "test-skill",
			status: "active",
			description: "Test skill description",
			skill_root: "skills/test-skill",
			deleted: 0,
			modified_at: new Date().toISOString(),
		});

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Should contain skill index when active skills exist
		expect(result.content).toContain("<available_skills>");
		expect(result.content).toContain("test-skill");
	});

	test("Advisory feedback-loop stripped from active conversation (#70)", () => {
		// Create an approved advisory authored by local site within 24h
		const now = new Date();
		const withinLast24h = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1 hour ago

		dbInsert(db, "advisories", {
			id: "test-advisory",
			created_by: siteId,
			title: "Test Advisory",
			detail: "Test detail",
			type: "general",
			status: "approved",
			proposed_at: withinLast24h,
			resolved_at: withinLast24h,
			deleted: 0,
			modified_at: withinLast24h,
		});

		// Active-conversation surface: no taskType. Resolved-advisory acks must
		// NOT appear (they would prime a false "advisories happening now" framing
		// in privileged-attention position).
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).not.toContain("[Advisory notification]");
		expect(result.content).not.toContain("Test Advisory");
	});

	test("Advisory feedback-loop preserved on heartbeat surface (#70)", () => {
		// Create an approved advisory authored by local site within 24h
		const now = new Date();
		const withinLast24h = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1 hour ago

		dbInsert(db, "advisories", {
			id: "test-advisory",
			created_by: siteId,
			title: "Test Advisory",
			detail: "Test detail",
			type: "general",
			status: "approved",
			proposed_at: withinLast24h,
			resolved_at: withinLast24h,
			deleted: 0,
			modified_at: withinLast24h,
		});

		// Heartbeat surface keeps advisory-hygiene tracking. (Note: in production
		// the heartbeat runs the no-history branch of assembleContext, not
		// buildVolatileContext; this asserts the gate's generality.)
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			taskType: "heartbeat",
		});

		// Advisory feedback-loop should inject [Advisory notification] line
		// Format: "[Advisory notification] Advisory 'Test Advisory' was approved by operator."
		expect(result.content).toContain("[Advisory notification]");
		expect(result.content).toContain("Test Advisory");
		expect(result.content).toContain("approved");
	});

	test("R-VC29: summary overflow past cap renders as Older-summaries titles inside the Discoverable Archive (call-site regression)", () => {
		// Regression for the 8f32e127 incomplete wiring: renderDiscoverableArchive
		// gained an optional `demotedSummaries` param and renderWorkingKnowledge
		// stopped rendering the overflow, but the production call site in
		// composeVolatileSections never passed the demoted set — so overflow
		// summaries rendered NOWHERE. The renderer-level parity test stayed green
		// because it hand-fed the param. This test drives the real call site.
		const total = WORKING_KNOWLEDGE_SUMMARY_CAP + 5;
		const base = Date.now();
		for (let i = 0; i < total; i++) {
			// Strictly decreasing modified_at so recency order (and therefore the
			// kept/demoted split) is deterministic: k000..k049 kept, k050.. demoted.
			const ts = new Date(base - i * 60_000).toISOString();
			dbInsert(db, "semantic_memory", {
				id: randomUUID(),
				key: `_summary:k${String(i).padStart(3, "0")}`,
				value: `summary body number ${i}`,
				tier: "summary",
				created_at: ts,
				modified_at: ts,
				deleted: 0,
			});
		}

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// The demoted sub-block must render on the STABLE channel (it is part of
		// the Discoverable Archive, which is stable-side per R-VC25/R-VC29).
		expect(result.stableContent).toContain(WORKING_KNOWLEDGE_DEMOTED_HEADER);

		// Demoted entries (beyond the cap) appear as title-only lines after the
		// sub-header; kept entries render with their gloss in Working Knowledge.
		const demotedIdx = result.stableContent.indexOf(WORKING_KNOWLEDGE_DEMOTED_HEADER);
		const demotedBlock = result.stableContent.slice(demotedIdx);
		const overflowKey = `_summary:k${String(WORKING_KNOWLEDGE_SUMMARY_CAP).padStart(3, "0")}`;
		expect(demotedBlock).toContain(`- ${overflowKey}`);
		// Title-only: the overflow entry's body must not render anywhere.
		expect(result.stableContent).not.toContain(
			`summary body number ${WORKING_KNOWLEDGE_SUMMARY_CAP}`,
		);
		// Kept entry still renders full-gloss in Working Knowledge.
		expect(result.stableContent).toContain("summary body number 0");

		// Structural placement: the sub-block lives INSIDE the Discoverable
		// Archive section — after the DA header, before the DA footer, and after
		// the Working Knowledge footer (i.e., NOT in Working Knowledge).
		const daHeaderIdx = result.stableContent.indexOf("## Discoverable Archive");
		const wkFooterIdx = result.stableContent.indexOf(WORKING_KNOWLEDGE_FOOTER);
		expect(daHeaderIdx).toBeGreaterThan(-1);
		expect(wkFooterIdx).toBeGreaterThan(-1);
		expect(demotedIdx).toBeGreaterThan(daHeaderIdx);
		expect(demotedIdx).toBeGreaterThan(wkFooterIdx);
	});
});
