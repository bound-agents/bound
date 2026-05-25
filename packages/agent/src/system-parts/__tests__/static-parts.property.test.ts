/**
 * Property tests for the static system parts builder.
 *
 * Byte-stability is the load-bearing invariant — this output sits
 * inside the system-level cache breakpoint per R-VC25.
 *
 * Properties:
 *   Y1 Determinism — same inputs produce byte-equal output.
 *   Y2 Section ordering — env, concurrency, persona?, orientation, schema?.
 *   Y3 Orientation command sort-stability.
 *   Y4 Empty registry → no MCP commands subsection.
 *   Y5 Persona absent → persona slot omitted.
 *   Y6 Schema block omits zero-column tables (handled gracefully on
 *      a partial test DB — applySchema produces all rows but tests
 *      should still get deterministic output).
 *   Y7 hostName/siteId fallback to "unknown" when undefined.
 */

import Database from "bun:sqlite";
import { describe, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { CommandRegistryEntry } from "@bound/shared";
import fc from "fast-check";
import { CONCURRENCY_PARAGRAPH, ENVIRONMENT_PARAGRAPH, buildStaticSystemParts } from "../build";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

const cmdName = fc
	.string({ minLength: 1, maxLength: 16 })
	.filter((s) => /^[a-z][a-z0-9_-]*$/.test(s));
const cmdDesc = fc.string({ minLength: 0, maxLength: 40 }).filter((s) => !/[\n\r]/.test(s));

const cmdRegistryArb = fc.uniqueArray(
	fc.tuple(cmdName, cmdDesc).map(
		([name, description]): CommandRegistryEntry => ({
			name,
			description,
		}),
	),
	{ maxLength: 6, selector: (c) => c.name },
);

describe("buildStaticSystemParts — property tests", () => {
	it("Y1: determinism — same inputs produce byte-equal output", () => {
		fc.assert(
			fc.property(
				cmdRegistryArb,
				fc.option(fc.string({ minLength: 0, maxLength: 60 }), { nil: null }),
				fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
				fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
				(registry, persona, hostName, siteId) => {
					const db = freshDb();
					const a = buildStaticSystemParts({
						db,
						persona,
						commandRegistry: registry,
						hostName: hostName ?? undefined,
						siteId: siteId ?? undefined,
					}).join("\n\n");
					const b = buildStaticSystemParts({
						db,
						persona,
						commandRegistry: registry,
						hostName: hostName ?? undefined,
						siteId: siteId ?? undefined,
					}).join("\n\n");
					db.close();
					return a === b;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("Y2: section ordering — env first, concurrency second, persona before orientation", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: "PERSONA_BODY",
			commandRegistry: [],
			hostName: "h",
			siteId: "s",
		});
		// First two parts MUST be env then concurrency.
		if (out[0] !== ENVIRONMENT_PARAGRAPH) throw new Error("env not first");
		if (out[1] !== CONCURRENCY_PARAGRAPH) throw new Error("concurrency not second");
		// Persona MUST sit before orientation when present.
		const personaIdx = out.findIndex((p) => p === "PERSONA_BODY");
		const orientationIdx = out.findIndex((p) => p.startsWith("## Orientation"));
		if (personaIdx === -1) throw new Error("persona missing");
		if (orientationIdx === -1) throw new Error("orientation missing");
		if (personaIdx >= orientationIdx) throw new Error("persona must precede orientation");
		db.close();
	});

	it("Y3: orientation command sort-stability — order doesn't matter", () => {
		fc.assert(
			fc.property(cmdRegistryArb, (registry) => {
				if (registry.length < 2) return true;
				const db = freshDb();
				const forward = buildStaticSystemParts({
					db,
					persona: null,
					commandRegistry: registry,
					hostName: "h",
					siteId: "s",
				}).join("\n\n");
				const reversed = buildStaticSystemParts({
					db,
					persona: null,
					commandRegistry: [...registry].reverse(),
					hostName: "h",
					siteId: "s",
				}).join("\n\n");
				db.close();
				return forward === reversed;
			}),
			{ numRuns: 50 },
		);
	});

	it("Y4: empty registry → orientation has no MCP commands subsection", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: null,
			commandRegistry: [],
			hostName: "h",
			siteId: "s",
		});
		const orientation = out.find((p) => p.startsWith("## Orientation"));
		if (!orientation) throw new Error("orientation missing");
		if (orientation.includes("### Additional MCP Commands")) {
			throw new Error("MCP commands subsection should be absent for empty registry");
		}
		db.close();
	});

	it("Y4b: non-empty registry → MCP commands subsection present", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: null,
			commandRegistry: [{ name: "demo", description: "test cmd" }],
			hostName: "h",
			siteId: "s",
		});
		const orientation = out.find((p) => p.startsWith("## Orientation"));
		if (!orientation) throw new Error("orientation missing");
		if (!orientation.includes("### Additional MCP Commands")) {
			throw new Error("MCP commands subsection should be present");
		}
		if (!orientation.includes("demo")) {
			throw new Error("command name should appear in orientation");
		}
		db.close();
	});

	it("Y5: persona absent → persona slot omitted entirely", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: null,
			commandRegistry: [],
			hostName: "h",
			siteId: "s",
		});
		// Output should be: env, concurrency, orientation, schema (or 3 if no schema).
		// Persona slot must not appear.
		if (out.length > 4) throw new Error(`unexpected length: ${out.length}`);
		// Sanity: env is index 0, concurrency 1, orientation 2.
		if (!out[2].startsWith("## Orientation")) {
			throw new Error("orientation should be at index 2 when persona absent");
		}
		db.close();
	});

	it("Y6: schema block respects column-presence (always present on applySchema'd DB)", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: null,
			commandRegistry: [],
			hostName: "h",
			siteId: "s",
		});
		const schema = out.find((p) => p.startsWith("## Database Schema"));
		if (!schema) throw new Error("schema missing on a fully-schema'd DB");
		// Schema block should mention at least one of the synced tables.
		if (!schema.includes("### threads") && !schema.includes("### messages")) {
			throw new Error("schema block should include synced tables");
		}
		db.close();
	});

	it("Y7: hostName/siteId fallback to 'unknown' when undefined", () => {
		const db = freshDb();
		const out = buildStaticSystemParts({
			db,
			persona: null,
			commandRegistry: [],
			hostName: undefined,
			siteId: undefined,
		});
		const orientation = out.find((p) => p.startsWith("## Orientation"));
		if (!orientation) throw new Error("orientation missing");
		if (!orientation.includes("Host: unknown")) throw new Error("hostName fallback regression");
		if (!orientation.includes("Site ID: unknown")) throw new Error("siteId fallback regression");
		db.close();
	});

	it("Y-cache-stability: byte-equal output on consecutive calls with same DB", () => {
		// The R-VC25 stable-prefix invariant. This output rides the
		// system-level cache breakpoint; bytes MUST be byte-identical
		// across cold rebuilds of the same DB state.
		const db = freshDb();
		const args = {
			db,
			persona: "stable persona",
			commandRegistry: [{ name: "foo", description: "bar" }],
			hostName: "host-A",
			siteId: "site-A",
		};
		const a = buildStaticSystemParts(args).join("\n\n");
		const b = buildStaticSystemParts(args).join("\n\n");
		const c = buildStaticSystemParts(args).join("\n\n");
		if (a !== b || b !== c) throw new Error("cache-stability regression");
		db.close();
	});
});
