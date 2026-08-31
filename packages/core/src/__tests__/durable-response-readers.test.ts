// 4D-D union-await consumer readers. The awaiting requester reads the UNION of
// legacy relay_inbox response rows and pending durable_work response rows
// targeted at self. These core readers surface the durable half, scoped to
// response kinds + pending + target_site_id = self, so the requester consumes
// exactly-once via the token-fenced claim/ack lifecycle. See
// docs/design/specs/2026-08-31-durable-work-consolidation.md (R-DW10, R-DW13).
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { insertDurableWork } from "../durable-work";
import {
	readDurableResponseByRefId,
	readDurableResponsesByStreamId,
} from "../repositories/durable-work";
import { applySchema } from "../schema";

let db: Database;
const SELF = "self-site";
const PEER = "peer-site";

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});

/** Insert a pending durable response row targeted at `target`. */
function insertResponse(opts: {
	id: string;
	kind: string;
	target: string;
	refId?: string | null;
	streamId?: string | null;
	seq?: number;
	source?: string;
}): void {
	insertDurableWork(db, {
		id: opts.id,
		target_site_id: opts.target,
		kind: opts.kind,
		payload: JSON.stringify({ ok: true }),
		// Stream chunk keys are seq-scoped (stream:<streamId>:<seq>); scalar
		// response keys are ref-scoped (response:<refId>). Match production key
		// shape so the (kind, idempotency_key) fence behaves as it will for real.
		idempotency_key:
			opts.streamId != null
				? `stream:${opts.streamId}:${opts.seq ?? 0}`
				: `response:${opts.refId ?? opts.id}`,
		ref_id: opts.refId ?? null,
		stream_id: opts.streamId ?? null,
		source_site: opts.source ?? PEER,
	});
}

describe("readDurableResponseByRefId", () => {
	it("returns the earliest pending response row targeted at self for the ref_id", () => {
		insertResponse({ id: "r1", kind: "result", target: SELF, refId: "req-1" });
		const row = readDurableResponseByRefId(db, "req-1", SELF);
		expect(row).not.toBeNull();
		expect(row?.id).toBe("r1");
		expect(row?.kind).toBe("result");
	});

	it("ignores rows targeted at a different site (only self-targeted responses)", () => {
		insertResponse({ id: "r1", kind: "result", target: PEER, refId: "req-1" });
		expect(readDurableResponseByRefId(db, "req-1", SELF)).toBeNull();
	});

	it("ignores request kinds sharing the ref_id (only response kinds)", () => {
		// A durable request row can share a ref_id with a cancel; it must not be
		// mistaken for a response.
		insertDurableWork(db, {
			id: "cancel-1",
			target_site_id: SELF,
			kind: "cancel",
			payload: "{}",
			idempotency_key: "cancel:req-1",
			ref_id: "req-1",
		});
		expect(readDurableResponseByRefId(db, "req-1", SELF)).toBeNull();
	});

	it("ignores non-pending rows (already claimed/consumed)", () => {
		insertResponse({ id: "r1", kind: "result", target: SELF, refId: "req-1" });
		db.run("UPDATE durable_work SET claim_state = 'consumed' WHERE id = 'r1'");
		expect(readDurableResponseByRefId(db, "req-1", SELF)).toBeNull();
	});
});

describe("readDurableResponsesByStreamId", () => {
	it("returns all pending response rows targeted at self for the stream_id, oldest first", () => {
		insertResponse({ id: "c0", kind: "stream_chunk", target: SELF, streamId: "s-1", seq: 0 });
		insertResponse({ id: "c1", kind: "stream_chunk", target: SELF, streamId: "s-1", seq: 1 });
		insertResponse({ id: "end", kind: "stream_end", target: SELF, streamId: "s-1", seq: 2 });
		const rows = readDurableResponsesByStreamId(db, "s-1", SELF);
		expect(rows.map((r) => r.id).sort()).toEqual(["c0", "c1", "end"]);
	});

	it("scopes to self and to response kinds", () => {
		insertResponse({ id: "c0", kind: "stream_chunk", target: PEER, streamId: "s-1" });
		insertDurableWork(db, {
			id: "req",
			target_site_id: SELF,
			kind: "inference",
			payload: "{}",
			idempotency_key: "inference-stream:s-1",
			stream_id: "s-1",
		});
		expect(readDurableResponsesByStreamId(db, "s-1", SELF)).toHaveLength(0);
	});
});
