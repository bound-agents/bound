import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, Thread } from "@bound/shared";
import { createCoreTestDb } from "../../../__tests__/test-database";
import { insertRow } from "../../../index";
import { listInterruptedToolUseThreadIds } from "../interrupted-tool-use";

const SITE_ID = "site-local";
const OTHER_SITE = "site-remote";

function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	const base: Thread = {
		id: overrides.id,
		user_id: "u1",
		interface: "web",
		host_origin: SITE_ID,
		color: null,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: "2026-01-01T00:00:00.000Z",
		last_message_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		model_hint: null,
		agent_id: null,
		parent_thread_id: null,
		...overrides,
	};
	insertRow(db, "threads", base, SITE_ID);
}

function seedMessage(
	db: Database,
	overrides: Partial<Message> & { id: string; thread_id: string; role: Message["role"] },
): void {
	const base: Message = {
		id: overrides.id,
		thread_id: overrides.thread_id,
		role: overrides.role,
		content: overrides.content ?? "",
		model_id: null,
		tool_name: null,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		modified_at: overrides.modified_at ?? null,
		host_origin: overrides.host_origin ?? SITE_ID,
		deleted: overrides.deleted ?? 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
	insertRow(db, "messages", base, SITE_ID);
}

/** Enqueue a dispatch_queue row (non-synced local table) directly. */
function seedDispatch(
	db: Database,
	row: { message_id: string; thread_id: string; status: string; event_type: string },
): void {
	db.run(
		`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, created_at, modified_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			row.message_id,
			row.thread_id,
			row.status,
			row.event_type,
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		],
	);
}

describe("listInterruptedToolUseThreadIds", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	it("returns [] when there are no threads", () => {
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});

	it("flags a thread whose last local tool activity has no following assistant reply", () => {
		seedThread(db, { id: "t1" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t1",
			role: "user",
			created_at: "2026-01-01T00:00:01.000Z",
		});
		seedMessage(db, {
			id: "m2",
			thread_id: "t1",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([{ thread_id: "t1" }]);
	});

	it("does NOT flag a thread where an assistant reply followed the tool activity", () => {
		seedThread(db, { id: "t2" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t2",
			role: "tool_result",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		seedMessage(db, {
			id: "m2",
			thread_id: "t2",
			role: "assistant",
			created_at: "2026-01-01T00:00:03.000Z",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});

	it("ignores tool activity whose host_origin is a different site (bind param)", () => {
		seedThread(db, { id: "t3" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t3",
			role: "tool_call",
			host_origin: OTHER_SITE,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		// last_local_tool_at is NULL for SITE_ID -> not interrupted
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
		// but IS flagged from the remote site's perspective
		expect(listInterruptedToolUseThreadIds(db, OTHER_SITE)).toEqual([{ thread_id: "t3" }]);
	});

	it("does NOT flag a thread interrupted after the tool activity", () => {
		seedThread(db, { id: "t4" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t4",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		seedMessage(db, {
			id: "m2",
			thread_id: "t4",
			role: "developer",
			content: "turn was interrupted by the user",
			created_at: "2026-01-01T00:00:03.000Z",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});

	it("excludes agent (sub-agent) threads", () => {
		seedThread(db, { id: "t5", agent_id: "agent-1" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t5",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});

	it("excludes a thread with a pending client_tool_call dispatch row", () => {
		seedThread(db, { id: "t6" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t6",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		seedDispatch(db, {
			message_id: "d1",
			thread_id: "t6",
			status: "pending",
			event_type: "client_tool_call",
		});
		// a live client tool call means the tool use is in-flight, not interrupted
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});

	it("still flags a thread whose client_tool_call dispatch row is already completed", () => {
		seedThread(db, { id: "t7" });
		seedMessage(db, {
			id: "m1",
			thread_id: "t7",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		seedDispatch(db, {
			message_id: "d1",
			thread_id: "t7",
			status: "completed",
			event_type: "client_tool_call",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([{ thread_id: "t7" }]);
	});

	it("excludes a soft-deleted thread", () => {
		seedThread(db, { id: "t8", deleted: 1 });
		seedMessage(db, {
			id: "m1",
			thread_id: "t8",
			role: "tool_call",
			host_origin: SITE_ID,
			created_at: "2026-01-01T00:00:02.000Z",
		});
		expect(listInterruptedToolUseThreadIds(db, SITE_ID)).toEqual([]);
	});
});
