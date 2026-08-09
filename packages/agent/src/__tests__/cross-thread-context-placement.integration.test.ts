import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import { assembleContext, frozenClock } from "../context-assembly";
import { StableSubsectionCache } from "../stable-prefix/cache";

const SITE_ID = "cross-thread-placement-test";
const USER_ID = "cross-thread-placement-user";
const NOW = "2026-08-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function seedThread(
	db: Database,
	args: {
		id: string;
		title: string;
		interface?: string;
		summary: string | null;
		summaryThrough: string | null;
		lastMessageAt: string;
	},
): void {
	insertRow(
		db,
		"threads",
		{
			id: args.id,
			user_id: USER_ID,
			interface: args.interface ?? "web",
			host_origin: SITE_ID,
			color: 0,
			title: args.title,
			summary: args.summary,
			summary_through: args.summaryThrough,
			created_at: NOW,
			last_message_at: args.lastMessageAt,
			modified_at: NOW,
			deleted: 0,
		},
		SITE_ID,
	);
}

function seedMessage(db: Database, id: string, threadId: string): void {
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: threadId,
			role: "user",
			content: "seed message",
			host_origin: SITE_ID,
			created_at: NOW,
			deleted: 0,
		},
		SITE_ID,
	);
}

function seedBoundlessAttachment(db: Database, threadId: string): void {
	const hostSiteId = "boundless-host-site";
	insertRow(
		db,
		"hosts",
		{
			site_id: hostSiteId,
			host_name: "boundless-host",
			// Keep this session live regardless of the wall clock when the test runs.
			online_at: "2099-01-01T00:00:00.000Z",
			modified_at: "2099-01-01T00:00:00.000Z",
			deleted: 0,
		},
		SITE_ID,
	);
	insertRow(
		db,
		"client_sessions",
		{
			id: `session-${threadId}`,
			connection_id: `connection-${threadId}`,
			thread_id: threadId,
			site_id: hostSiteId,
			created_at: NOW,
			modified_at: NOW,
			deleted: 0,
		},
		SITE_ID,
	);
}

function developerTail(result: ReturnType<typeof assembleContext>): string {
	return result.messages
		.filter((message) => message.role === "developer")
		.map((message) => (typeof message.content === "string" ? message.content : ""))
		.join("\n");
}

describe("cross-thread summary context placement", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		insertRow(
			db,
			"users",
			{
				id: USER_ID,
				display_name: "Cross-thread Placement User",
				first_seen_at: NOW,
				modified_at: NOW,
				deleted: 0,
			},
			SITE_ID,
		);
	});

	afterEach(() => {
		db.close();
	});

	it("places a new thread's seeded sibling summaries in the stable system channel", () => {
		const currentThreadId = "new-thread";
		const siblingSummary = "Scenario A sibling summary body";
		seedThread(db, {
			id: currentThreadId,
			title: "New Thread",
			summary: null,
			summaryThrough: null,
			lastMessageAt: "2026-08-09T11:59:00.000Z",
		});
		seedThread(db, {
			id: "sibling-thread-a",
			title: "Sibling A",
			interface: "boundless",
			summary: siblingSummary,
			summaryThrough: "2026-08-09T11:58:00.000Z",
			lastMessageAt: "2026-08-09T11:58:00.000Z",
		});
		seedMessage(db, "sibling-message-a", "sibling-thread-a");
		seedBoundlessAttachment(db, "sibling-thread-a");

		const result = assembleContext({
			db,
			threadId: currentThreadId,
			userId: USER_ID,
			clock: frozenClock(NOW_MS),
			// The production loop supplies this cache; Scenario A must not lose
			// its stable seed behind the thread-agnostic cache seam.
			stableSubsectionCache: new StableSubsectionCache(),
		});

		expect(result.systemPrompt).toContain(
			"## Cross-thread context — recent activity from other threads",
		);
		expect(result.systemPrompt).toContain("### Sibling A");
		expect(result.systemPrompt).toContain(siblingSummary);
		expect(developerTail(result)).not.toContain(siblingSummary);
		// The sibling summary is stable, but its live boundless attachment remains
		// live-state metadata in the varying developer tail.
		expect(developerTail(result)).toContain('<session host="boundless-host" live="true"/>');
	});

	it("places idle-thread sibling-summary deltas in the varying developer tail", () => {
		const currentThreadId = "idle-thread";
		const siblingSummary = "Scenario B sibling summary body";
		seedThread(db, {
			id: currentThreadId,
			title: "Idle Thread",
			summary: "Existing compacted summary",
			summaryThrough: "2026-08-09T09:00:00.000Z",
			lastMessageAt: "2026-08-09T10:00:00.000Z",
		});
		seedThread(db, {
			id: "sibling-thread-b",
			title: "Sibling B",
			summary: siblingSummary,
			summaryThrough: "2026-08-09T11:00:00.000Z",
			lastMessageAt: "2026-08-09T11:00:00.000Z",
		});
		seedMessage(db, "sibling-message-b", "sibling-thread-b");

		const result = assembleContext({
			db,
			threadId: currentThreadId,
			userId: USER_ID,
			clock: frozenClock(NOW_MS),
		});

		expect(result.systemPrompt).not.toContain(siblingSummary);
		expect(developerTail(result)).toContain(
			"## Cross-thread context — recent activity from other threads",
		);
		expect(developerTail(result)).toContain("### Sibling B");
		expect(developerTail(result)).toContain(siblingSummary);
	});
});
