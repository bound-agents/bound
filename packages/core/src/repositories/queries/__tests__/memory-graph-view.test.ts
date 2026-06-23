import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SemanticMemory, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { listMemoryGraphNodes } from "../memory-graph-view";

const SITE_ID = "test-site";
const TS = "2026-01-01T00:00:00.000Z";

let db: Database;

function seedThread(overrides: Partial<Thread> & Pick<Thread, "id">): void {
	const row: Thread = {
		id: overrides.id,
		user_id: overrides.user_id ?? "user-1",
		interface: overrides.interface ?? "web",
		host_origin: overrides.host_origin ?? SITE_ID,
		color: overrides.color ?? 0,
		title: overrides.title ?? null,
		summary: overrides.summary ?? null,
		summary_through: overrides.summary_through ?? null,
		summary_model_id: overrides.summary_model_id ?? null,
		extracted_through: overrides.extracted_through ?? null,
		created_at: overrides.created_at ?? TS,
		last_message_at: overrides.last_message_at ?? TS,
		modified_at: overrides.modified_at ?? TS,
		deleted: overrides.deleted ?? 0,
		model_hint: overrides.model_hint ?? null,
	};
	insertRow(db, "threads", row, SITE_ID);
}

function seedMemory(overrides: Partial<SemanticMemory> & Pick<SemanticMemory, "id" | "key">): void {
	const row: SemanticMemory = {
		id: overrides.id,
		key: overrides.key,
		value: overrides.value ?? "v",
		source: overrides.source ?? null,
		created_at: overrides.created_at ?? TS,
		modified_at: overrides.modified_at ?? TS,
		last_accessed_at: overrides.last_accessed_at ?? null,
		tier: overrides.tier ?? "default",
		deleted: overrides.deleted ?? 0,
	};
	insertRow(db, "semantic_memory", row, SITE_ID);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("listMemoryGraphNodes", () => {
	it("returns [] when there are no memory rows", () => {
		expect(listMemoryGraphNodes(db)).toEqual([]);
	});

	it("resolves source thread title + color for a memory whose source is a live thread", () => {
		seedThread({ id: "thread-1", title: "My Thread", color: 7 });
		seedMemory({
			id: "mem-1",
			key: "k1",
			value: "hello",
			tier: "pinned",
			source: "thread-1",
			modified_at: "2026-02-02T00:00:00.000Z",
		});

		const rows = listMemoryGraphNodes(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			id: "mem-1",
			key: "k1",
			value: "hello",
			tier: "pinned",
			source: "thread-1",
			modified_at: "2026-02-02T00:00:00.000Z",
			source_thread_title: "My Thread",
			source_color: 7,
		});
	});

	it("projects exactly the MemoryGraphNodeRow columns and nothing else", () => {
		seedThread({ id: "thread-1", title: "T", color: 3 });
		seedMemory({ id: "mem-1", key: "k1", source: "thread-1" });

		const [row] = listMemoryGraphNodes(db);
		expect(Object.keys(row).sort()).toEqual(
			[
				"id",
				"key",
				"value",
				"tier",
				"source",
				"modified_at",
				"source_thread_title",
				"source_color",
			].sort(),
		);
	});

	describe("LEFT JOIN null cases", () => {
		it("returns null thread fields when source is null", () => {
			seedMemory({ id: "mem-1", key: "k1", source: null });

			const [row] = listMemoryGraphNodes(db);
			expect(row.source).toBeNull();
			expect(row.source_thread_title).toBeNull();
			expect(row.source_color).toBeNull();
			// The memory itself is still returned.
			expect(row.id).toBe("mem-1");
		});

		it("returns null thread fields when source points at a non-existent thread", () => {
			seedMemory({ id: "mem-1", key: "k1", source: "missing-thread" });

			const [row] = listMemoryGraphNodes(db);
			// source column itself is preserved (it is the unmatched FK value).
			expect(row.source).toBe("missing-thread");
			expect(row.source_thread_title).toBeNull();
			expect(row.source_color).toBeNull();
		});

		it("returns null thread fields when the source thread is soft-deleted", () => {
			seedThread({ id: "thread-1", title: "Dead Thread", color: 9 });
			seedMemory({ id: "mem-1", key: "k1", source: "thread-1" });
			softDelete(db, "threads", "thread-1", SITE_ID);

			const [row] = listMemoryGraphNodes(db);
			// LEFT JOIN filters the right side on t.deleted = 0, so the memory
			// survives but the thread fields collapse to null.
			expect(row.id).toBe("mem-1");
			expect(row.source).toBe("thread-1");
			expect(row.source_thread_title).toBeNull();
			expect(row.source_color).toBeNull();
		});
	});

	describe("deleted filtering on the left side", () => {
		it("excludes soft-deleted memory rows", () => {
			seedMemory({ id: "mem-live", key: "k-live", source: null });
			seedMemory({ id: "mem-dead", key: "k-dead", source: null });
			softDelete(db, "semantic_memory", "mem-dead", SITE_ID);

			const rows = listMemoryGraphNodes(db);
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe("mem-live");
		});

		it("returns [] when the only memory row is soft-deleted", () => {
			seedMemory({ id: "mem-dead", key: "k-dead", source: null });
			softDelete(db, "semantic_memory", "mem-dead", SITE_ID);

			expect(listMemoryGraphNodes(db)).toEqual([]);
		});
	});

	describe("mixed graph", () => {
		it("resolves matched, unmatched, null-source, and deleted-thread memories together", () => {
			seedThread({ id: "thread-live", title: "Live", color: 1 });
			seedThread({ id: "thread-gone", title: "Gone", color: 2 });
			softDelete(db, "threads", "thread-gone", SITE_ID);

			seedMemory({ id: "mem-matched", key: "km", source: "thread-live" });
			seedMemory({ id: "mem-orphan", key: "ko", source: "no-such-thread" });
			seedMemory({ id: "mem-nullsrc", key: "kn", source: null });
			seedMemory({ id: "mem-deadthread", key: "kd", source: "thread-gone" });

			const rows = listMemoryGraphNodes(db);
			expect(rows).toHaveLength(4);

			const byId = new Map(rows.map((r) => [r.id, r]));

			expect(byId.get("mem-matched")?.source_thread_title).toBe("Live");
			expect(byId.get("mem-matched")?.source_color).toBe(1);

			expect(byId.get("mem-orphan")?.source_thread_title).toBeNull();
			expect(byId.get("mem-orphan")?.source_color).toBeNull();

			expect(byId.get("mem-nullsrc")?.source).toBeNull();
			expect(byId.get("mem-nullsrc")?.source_thread_title).toBeNull();

			expect(byId.get("mem-deadthread")?.source_thread_title).toBeNull();
			expect(byId.get("mem-deadthread")?.source_color).toBeNull();
		});

		it("does not match a memory to a thread when the title is null but the thread is live", () => {
			seedThread({ id: "thread-1", title: null, color: 5 });
			seedMemory({ id: "mem-1", key: "k1", source: "thread-1" });

			const [row] = listMemoryGraphNodes(db);
			// Join still matches (live thread), so color comes through; title is
			// genuinely null on the thread, distinct from a missing join.
			expect(row.source_color).toBe(5);
			expect(row.source_thread_title).toBeNull();
		});
	});

	it("reflects a thread title update through the join", () => {
		seedThread({ id: "thread-1", title: "Before", color: 4 });
		seedMemory({ id: "mem-1", key: "k1", source: "thread-1" });

		expect(listMemoryGraphNodes(db)[0].source_thread_title).toBe("Before");

		updateRow(db, "threads", "thread-1", { title: "After" }, SITE_ID);

		expect(listMemoryGraphNodes(db)[0].source_thread_title).toBe("After");
	});
});
