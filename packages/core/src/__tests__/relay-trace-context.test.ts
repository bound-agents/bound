import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";
import { insertInbox, readUndelivered, readUnprocessed, writeOutbox } from "../relay";
import { applySchema } from "../schema";

describe("relay trace_context column", () => {
	let db: Database;
	let testDbPath: string;

	beforeEach(() => {
		testDbPath = join(tmpdir(), `relay-trace-${randomBytes(4).toString("hex")}.db`);
		db = new Database(testDbPath);
		applySchema(db);
	});

	afterEach(() => {
		db.close();
		try {
			import("node:fs").then((fs) => fs.promises.unlink(testDbPath));
		} catch {
			// ignore
		}
	});

	it("relay_outbox table includes trace_context column as nullable TEXT", () => {
		// Verify column exists
		const columns = db.query("PRAGMA table_info(relay_outbox)").all() as Array<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			dflt_value: unknown;
			pk: number;
		}>;

		const traceContextCol = columns.find((c) => c.name === "trace_context");
		expect(traceContextCol).toBeDefined();
		expect(traceContextCol?.type).toBe("TEXT");
		expect(traceContextCol?.notnull).toBe(0); // nullable
	});

	it("relay_inbox table includes trace_context column as nullable TEXT", () => {
		// Verify column exists
		const columns = db.query("PRAGMA table_info(relay_inbox)").all() as Array<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			dflt_value: unknown;
			pk: number;
		}>;

		const traceContextCol = columns.find((c) => c.name === "trace_context");
		expect(traceContextCol).toBeDefined();
		expect(traceContextCol?.type).toBe("TEXT");
		expect(traceContextCol?.notnull).toBe(0); // nullable
	});

	it("writeOutbox preserves trace_context when provided", () => {
		const traceContext = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "congo=t61rcWpm1t1",
		});

		const entry: Omit<RelayOutboxEntry, "delivered"> = {
			id: "test-outbox-1",
			source_site_id: "site-a",
			target_site_id: "site-b",
			kind: "inference",
			ref_id: "thread-1",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ model: "test" }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60000).toISOString(),
			trace_context: traceContext,
		};

		writeOutbox(db, entry);

		const rows = readUndelivered(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.trace_context).toBe(traceContext);
	});

	it("writeOutbox handles null trace_context", () => {
		const entry: Omit<RelayOutboxEntry, "delivered"> = {
			id: "test-outbox-2",
			source_site_id: "site-a",
			target_site_id: "site-b",
			kind: "inference",
			ref_id: "thread-1",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ model: "test" }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60000).toISOString(),
			trace_context: null,
		};

		writeOutbox(db, entry);

		const rows = readUndelivered(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.trace_context).toBeNull();
	});

	it("insertInbox preserves trace_context when provided", () => {
		const traceContext = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});

		const entry: RelayInboxEntry = {
			id: "test-inbox-1",
			source_site_id: "site-b",
			kind: "result",
			ref_id: "thread-1",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ result: "ok" }),
			expires_at: new Date(Date.now() + 60000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
			trace_context: traceContext,
		};

		insertInbox(db, entry);

		const rows = readUnprocessed(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.trace_context).toBe(traceContext);
	});

	it("insertInbox handles null trace_context", () => {
		const entry: RelayInboxEntry = {
			id: "test-inbox-2",
			source_site_id: "site-b",
			kind: "result",
			ref_id: "thread-1",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ result: "ok" }),
			expires_at: new Date(Date.now() + 60000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
			trace_context: null,
		};

		insertInbox(db, entry);

		const rows = readUnprocessed(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.trace_context).toBeNull();
	});
});
