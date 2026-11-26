import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChangeLogEntry } from "@bound/shared";
import { insertRow, softDelete } from "../../change-log";
import { applyMetricsSchema } from "../../metrics-schema";
import { applySchema } from "../../schema";
import { findModelRoutingRule, findRouteDrain, listDrainedRouteIds } from "../model-routing";

const SITE_A = "site-aaaaaa";
const SITE_B = "site-bbbbbb";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

describe("model-routing repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = freshDb();
	});

	afterEach(() => {
		db.close();
	});

	it("reads a model_routing_rules row by logical_model and skips tombstoned rows", () => {
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify(["site-a:bedrock:opus", "site-b:anthropic:opus"]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const row = findModelRoutingRule(db, "opus");
		expect(row?.logical_model).toBe("opus");
		expect(JSON.parse(row?.route_order ?? "[]")).toEqual([
			"site-a:bedrock:opus",
			"site-b:anthropic:opus",
		]);

		softDelete(db, "model_routing_rules", "opus", SITE_A);
		expect(findModelRoutingRule(db, "opus")).toBeNull();
	});

	it("lists only live drains and excludes a re-enabled (soft-deleted) route", () => {
		insertRow(
			db,
			"route_drains",
			{
				route_id: "site-a:bedrock:opus",
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: "provider incident",
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);
		insertRow(
			db,
			"route_drains",
			{
				route_id: "site-b:anthropic:opus",
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		expect(listDrainedRouteIds(db).sort()).toEqual([
			"site-a:bedrock:opus",
			"site-b:anthropic:opus",
		]);
		expect(findRouteDrain(db, "site-a:bedrock:opus")?.reason).toBe("provider incident");

		// Un-drain one route: a drained route stays excluded until it is un-drained.
		softDelete(db, "route_drains", "site-a:bedrock:opus", SITE_A);
		expect(listDrainedRouteIds(db)).toEqual(["site-b:anthropic:opus"]);
		expect(findRouteDrain(db, "site-a:bedrock:opus")).toBeNull();
	});
});

describe("concurrent cross-host edits converge under row-level LWW (Done-when #1)", () => {
	let hostA: Database;
	let hostB: Database;

	beforeEach(() => {
		hostA = freshDb();
		hostB = freshDb();
	});

	afterEach(() => {
		hostA.close();
		hostB.close();
	});

	function pull(src: Database, table: string): ChangeLogEntry[] {
		return src
			.query(
				"SELECT hlc, table_name, row_id, site_id, timestamp, row_data FROM change_log WHERE table_name = ? ORDER BY hlc",
			)
			.all(table) as ChangeLogEntry[];
	}

	// Minimal LWW replay against a target DB: mirrors applyLWWReducer's
	// insert-or-newer-wins so the core package can prove convergence without a
	// dependency on @bound/sync.
	function replayLWW(target: Database, entries: ChangeLogEntry[], pk: string): void {
		for (const e of entries) {
			const row = JSON.parse(e.row_data) as Record<string, unknown>;
			const existing = target
				.query(`SELECT modified_at FROM ${e.table_name} WHERE ${pk} = ?`)
				.get(row[pk] as string) as { modified_at: string } | null;
			if (!existing) {
				const cols = Object.keys(row);
				target.run(
					`INSERT INTO ${e.table_name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
					cols.map((c) => row[c] as string | number | null),
				);
			} else if ((row.modified_at as string) > existing.modified_at) {
				const cols = Object.keys(row).filter((c) => c !== pk);
				target.run(
					`UPDATE ${e.table_name} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${pk} = ?`,
					[...cols.map((c) => row[c] as string | number | null), row[pk] as string],
				);
			}
		}
	}

	it("concurrent edits to the SAME model's row resolve last-full-row-write-wins", () => {
		// Both hosts set opus route_order; the later modified_at wins the whole row.
		insertRow(
			hostA,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify(["site-a:bedrock:opus"]),
				fallback_policy: JSON.stringify({ a: 1 }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:01.000Z",
			},
			SITE_A,
		);
		insertRow(
			hostB,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify(["site-b:anthropic:opus"]),
				fallback_policy: JSON.stringify({ b: 2 }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:05.000Z",
			},
			SITE_B,
		);

		replayLWW(hostA, pull(hostB, "model_routing_rules"), "logical_model");
		const winner = findModelRoutingRule(hostA, "opus");
		// The later write (host B) wins the whole row — both fields together.
		expect(JSON.parse(winner?.route_order ?? "[]")).toEqual(["site-b:anthropic:opus"]);
		expect(JSON.parse(winner?.fallback_policy ?? "{}")).toEqual({ b: 2 });
	});
});
