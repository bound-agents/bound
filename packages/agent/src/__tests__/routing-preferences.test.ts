import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "@bound/core";
import {
	STICKY_MIN_WINDOW_MS,
	cacheTtlToMs,
	loadDrainedRouteIds,
	loadRouteOrder,
	parseModelHint,
	resolveStickyRoute,
	stickyUntilMs,
} from "../routing-preferences";

const R_A = "site-a:bedrock:opus";
const R_B = "site-b:anthropic:opus";
const R_C = "site-c:openai:opus";

describe("cacheTtlToMs + stickyUntilMs (§5.3 cache-aware hysteresis)", () => {
	it("maps 5m and 1h hints, nulls everything else", () => {
		expect(cacheTtlToMs("5m")).toBe(5 * 60 * 1000);
		expect(cacheTtlToMs("1h")).toBe(60 * 60 * 1000);
		expect(cacheTtlToMs(undefined)).toBeNull();
		expect(cacheTtlToMs("7m")).toBeNull();
	});

	it("floors the sticky window at 5m when the route TTL is shorter/unknown", () => {
		const base = new Date("2026-01-01T00:00:00.000Z").getTime();
		// Unknown TTL → 5m floor.
		expect(stickyUntilMs("2026-01-01T00:00:00.000Z", null)).toBe(base + STICKY_MIN_WINDOW_MS);
		// 1h TTL → the longer window wins.
		expect(stickyUntilMs("2026-01-01T00:00:00.000Z", 60 * 60 * 1000)).toBe(base + 60 * 60 * 1000);
	});
});

describe("resolveStickyRoute (§5.3)", () => {
	const eligible = new Set([R_A, R_B]);
	// The lookup now carries the route's EFFECTIVE cache window (R-MC16): the
	// measured warm window, or the configured TTL when no history exists.
	const windowMs = (routeId: string) => (routeId === R_B ? 60 * 60 * 1000 : null);
	const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();

	it("stays on route B within B's cache window even after route A recovers (Done-when #2)", () => {
		// Thread failed over to B; A is eligible again (recovered) and ranked
		// higher. Within B's 1h window, the thread must stay on B.
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "opus",
				routeId: R_B,
				substitutedFrom: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0 + 30 * 60 * 1000, // 30 min later, inside B's 1h window
		});
		expect(decision).toEqual({ kind: "sticky", routeId: R_B });
	});

	it("drops to ranked selection once B's cache window goes cold", () => {
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "opus",
				routeId: R_B,
				substitutedFrom: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0 + 2 * 60 * 60 * 1000, // 2h later, past B's 1h window
		});
		expect(decision).toEqual({ kind: "ranked", reason: "window-cold" });
	});

	it("drops to ranked selection when the prior route is no longer eligible (drained/offline)", () => {
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "opus",
				routeId: R_C, // not in the eligible set
				substitutedFrom: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0 + 60 * 1000,
		});
		expect(decision).toEqual({ kind: "ranked", reason: "route-ineligible" });
	});

	it("does not stick when the upcoming turn targets a different model", () => {
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "opus",
				routeId: R_B,
				substitutedFrom: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "sonnet",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0 + 60 * 1000,
		});
		expect(decision).toEqual({ kind: "ranked", reason: "different-model" });
	});

	it("inherits a sticky refusal substitution for the originally-requested model", () => {
		// Prior turn ran model 'sonnet' after a refusal substituted away from the
		// requested 'opus'. The next 'opus' turn inherits the substitution route.
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "sonnet",
				routeId: R_B,
				substitutedFrom: "opus",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0 + 60 * 1000,
		});
		expect(decision).toEqual({ kind: "sticky", routeId: R_B });
	});

	it("falls back to ranked when the thread has no prior ok turn", () => {
		const decision = resolveStickyRoute({
			priorTurn: null,
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: windowMs,
			nowMs: t0,
		});
		expect(decision).toEqual({ kind: "ranked", reason: "no-prior-turn" });
	});

	it("uses a measured window that outlasts the configured TTL (R-MC16)", () => {
		// Route A's configured TTL would floor at 5m, but history measured a 90-min
		// warm window on it. A turn 40 min old must still stick — the measured window
		// (not the short configured TTL) governs stickiness.
		const decision = resolveStickyRoute({
			priorTurn: {
				modelId: "opus",
				routeId: R_A,
				substitutedFrom: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			requestedModel: "opus",
			eligibleRouteIds: eligible,
			cacheWindowMsByRoute: (routeId) => (routeId === R_A ? 90 * 60 * 1000 : null),
			nowMs: t0 + 40 * 60 * 1000,
		});
		expect(decision).toEqual({ kind: "sticky", routeId: R_A });
	});
});

describe("parseModelHint (§5.4 hard pin via logical_model@RouteId)", () => {
	it("parses a logical model with a hard pin", () => {
		const { logicalModel, pin } = parseModelHint("opus@site-a:bedrock:opus");
		expect(logicalModel).toBe("opus");
		expect(pin).toEqual({ logicalModel: "opus", routeId: "site-a:bedrock:opus" });
	});

	it("treats a plain model id (and 'default') as unpinned", () => {
		expect(parseModelHint("opus").pin).toBeNull();
		expect(parseModelHint("default").pin).toBeNull();
		expect(parseModelHint(undefined).pin).toBeNull();
	});

	it("parses a leading-@ pin as a route-only pin with no explicit logical model", () => {
		const { logicalModel, pin } = parseModelHint("@site-a:bedrock:opus");
		expect(logicalModel).toBeUndefined();
		expect(pin).toEqual({ logicalModel: null, routeId: "site-a:bedrock:opus" });
	});

	it("ignores a trailing @ with no RouteId (malformed, treated as plain hint)", () => {
		expect(parseModelHint("opus@")).toEqual({ logicalModel: "opus", pin: null });
	});
});

describe("drain + route_order DB read wrappers", () => {
	let db: Database;
	const SITE = "site-aaaaaa";

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("loadDrainedRouteIds reflects live drains and un-drains", () => {
		insertRow(
			db,
			"route_drains",
			{
				route_id: R_A,
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE,
		);
		expect(loadDrainedRouteIds(db).has(R_A)).toBe(true);

		// Un-drain: the route is no longer excluded.
		softDelete(db, "route_drains", R_A, SITE);
		expect(loadDrainedRouteIds(db).has(R_A)).toBe(false);
	});

	it("loadRouteOrder parses a RouteId[] and nulls malformed JSON", () => {
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify([R_B, R_A]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE,
		);
		expect(loadRouteOrder(db, "opus")).toEqual([R_B, R_A]);
		expect(loadRouteOrder(db, "nonexistent")).toBeNull();
	});
});
