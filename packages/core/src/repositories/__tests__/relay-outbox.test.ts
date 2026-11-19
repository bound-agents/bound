import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import { countUndeliveredRelayOutbox, findUndeliveredRelayOutboxById } from "../relay-outbox";

/**
 * The `relay_outbox` table was retired at release N+1 and is no longer created
 * by applySchema (it refuses startup if populated). These read helpers are the
 * last surviving callers; to exercise their real SQL + telemetry side effect we
 * recreate the minimal legacy shape in-test rather than mutate production schema.
 */
function createLegacyRelayOutbox(db: Database): void {
	db.run(`
		CREATE TABLE relay_outbox (
			id        TEXT PRIMARY KEY,
			payload   TEXT NOT NULL,
			delivered INTEGER NOT NULL DEFAULT 0
		) STRICT
	`);
}

function seedRow(db: Database, row: { id: string; payload?: string; delivered?: number }): void {
	db.run("INSERT INTO relay_outbox (id, payload, delivered) VALUES (?, ?, ?)", [
		row.id,
		row.payload ?? "{}",
		row.delivered ?? 0,
	]);
}

describe("relay-outbox repository (retired legacy table)", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
		createLegacyRelayOutbox(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("countUndeliveredRelayOutbox", () => {
		it("returns 0 when the table is empty", () => {
			expect(countUndeliveredRelayOutbox(db)).toBe(0);
		});

		it("counts only undelivered (delivered=0) rows", () => {
			seedRow(db, { id: "r1", delivered: 0 });
			seedRow(db, { id: "r2", delivered: 0 });
			seedRow(db, { id: "r3", delivered: 1 });
			expect(countUndeliveredRelayOutbox(db)).toBe(2);
		});

		it("returns 0 when every row is delivered", () => {
			seedRow(db, { id: "r1", delivered: 1 });
			expect(countUndeliveredRelayOutbox(db)).toBe(0);
		});
	});

	describe("findUndeliveredRelayOutboxById", () => {
		it("returns the row when it exists and is undelivered", () => {
			seedRow(db, { id: "r1", payload: '{"m":"hi"}', delivered: 0 });
			const row = findUndeliveredRelayOutboxById<{
				id: string;
				payload: string;
				delivered: number;
			}>(db, "r1");
			expect(row).toEqual({ id: "r1", payload: '{"m":"hi"}', delivered: 0 });
		});

		it("returns null for an absent id", () => {
			expect(findUndeliveredRelayOutboxById(db, "nope")).toBeNull();
		});

		it("returns null when the matching row has already been delivered (delivered=0 filter)", () => {
			seedRow(db, { id: "r1", delivered: 1 });
			expect(findUndeliveredRelayOutboxById(db, "r1")).toBeNull();
		});
	});
});
