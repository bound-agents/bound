import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow, recordTurn } from "@bound/core";
import type { BackendCapabilities, LLMBackend } from "@bound/llm";
import { ModelRouter, makeRouteId } from "@bound/llm";
import { ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { resolveModel } from "../model-resolution";

const SITE = "site-local";

function caps(over: Partial<BackendCapabilities> = {}): BackendCapabilities {
	return {
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: false,
		vision: false,
		extended_thinking: false,
		max_context: 200000,
		...over,
	};
}

/** Minimal LLMBackend stub — resolution only reads capabilities(). */
function stubBackend(): LLMBackend {
	return {
		capabilities: () => caps(),
		chat: () => {
			throw new Error("not called");
		},
	} as unknown as LLMBackend;
}

/**
 * Build a router with one local backend `opus` whose RouteId is
 * `site-local:bedrock:opus`, plus a route identity so getRouteId resolves.
 */
function routerWithOpus(): ModelRouter {
	const backends = new Map<string, LLMBackend>([["opus", stubBackend()]]);
	const effectiveCaps = new Map([["opus", caps()]]);
	const routeIdentities = new Map([
		[
			"opus",
			{
				routeId: makeRouteId(SITE, "bedrock", "opus"),
				reasoningOrigin: `${SITE}:bedrock`,
			},
		],
	]);
	return new ModelRouter(
		backends,
		"opus",
		effectiveCaps,
		new Map(),
		undefined,
		Date.now,
		routeIdentities,
	);
}

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

describe("resolveModel — default-model resolution (§5.1, R-RT9/R-RT14)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	it("resolves 'default' to the local backend default when no cluster role is set", () => {
		const router = routerWithOpus();
		const res = resolveModel("default", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("prefers the synced cluster role default when it names a local backend", () => {
		const router = routerWithOpus();
		// Add a second local backend 'sonnet' and make it the cluster role default.
		router.addDynamicBackend("sonnet", stubBackend(), caps(), undefined, {
			routeId: makeRouteId(SITE, "anthropic", "sonnet"),
			reasoningOrigin: `${SITE}:anthropic`,
		});
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "sonnet" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE,
		);
		const res = resolveModel(undefined, router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("sonnet");
	});

	it("errors when the configured cluster default is unavailable, never switching to the local bootstrap", () => {
		const router = routerWithOpus();
		setDefaultRoles(db, { default: "some-remote-only-model" });
		for (const request of ["default", undefined]) {
			const res = resolveModel(request, router, db, SITE);
			expect(res.kind).toBe("error");
			if (res.kind === "error") {
				expect(res.error).toContain("some-remote-only-model");
				expect(res.reason).toBe("unknown-model");
			}
		}
	});
});

/** Write `routing.model_roles` through the outbox, as the operator surfaces do. */
function setDefaultRoles(db: Database, roles: unknown, raw = false): void {
	insertRow(
		db,
		"cluster_config",
		{
			key: ROUTING_MODEL_ROLES_KEY,
			value: raw ? String(roles) : JSON.stringify(roles),
			deleted: 0,
			modified_at: "2026-01-01T00:00:00.000Z",
		},
		SITE,
	);
}

/** Insert a live remote host advertising `models`. */
function addRemoteHost(db: Database, siteId: string, models: unknown[]): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO hosts (site_id, host_name, sync_url, models, deleted, online_at, modified_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		[siteId, siteId, `https://${siteId}.example`, JSON.stringify(models), now, now],
	);
}

const NOVA_ENTRY = {
	id: "bedrock-main-amazon.nova-2-lite-v1:0",
	logical_model: "nova-2-lite",
	route_id: "site-spoke:bedrock:bedrock-main-amazon.nova-2-lite-v1:0",
	capabilities: { max_context: 1000000 },
};
const OPUS_ENTRY = {
	id: "bedrock-main-anthropic.claude-opus-5-5",
	logical_model: "claude-opus-5-5",
	route_id: "site-spoke:bedrock:bedrock-main-anthropic.claude-opus-5-5",
	capabilities: { max_context: 1000000 },
};

describe("resolveModel — configured cluster default is authoritative (R-RT7, R-MC10)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	it("routes a backend-less hub to the remote host serving the configured default, not any-remote", () => {
		// Hub: no local backends, empty bootstrap default. The spoke advertises Nova
		// (lexically first) and Opus; the cluster default names Opus's logical model.
		const hub = new ModelRouter(new Map(), "");
		addRemoteHost(db, "site-spoke", [NOVA_ENTRY, OPUS_ENTRY]);
		setDefaultRoles(db, { default: "claude-opus-5-5" });
		for (const request of ["default", undefined, ""]) {
			const res = resolveModel(request, hub, db, "site-hub");
			expect(res.kind).toBe("remote");
			if (res.kind === "remote") {
				expect(res.modelId).toBe("claude-opus-5-5");
				expect(res.hosts.map((h) => h.routeId)).toEqual([OPUS_ENTRY.route_id]);
			}
		}
	});

	it("resolves the configured logical default to a local expanded backend", () => {
		const expandedId = "bedrock-main-anthropic.claude-opus-5-5";
		const backends = new Map<string, LLMBackend>([
			["local-bootstrap", stubBackend()],
			[expandedId, stubBackend()],
		]);
		const configs = new Map([
			["local-bootstrap", { id: "local-bootstrap", provider: "ollama", model: "llama3" }],
			[expandedId, { id: expandedId, provider: "bedrock", model: "anthropic.claude-opus-5-5" }],
		]);
		const router = new ModelRouter(
			backends,
			"local-bootstrap",
			new Map([
				["local-bootstrap", caps()],
				[expandedId, caps()],
			]),
			configs as unknown as ConstructorParameters<typeof ModelRouter>[3],
		);
		setDefaultRoles(db, { default: "claude-opus-5-5" });
		const res = resolveModel("default", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe(expandedId);
	});

	it("errors on a backend-less hub when the configured default has no route, even with Nova available", () => {
		const hub = new ModelRouter(new Map(), "");
		addRemoteHost(db, "site-spoke", [NOVA_ENTRY]);
		setDefaultRoles(db, { default: "claude-opus-5-5" });
		for (const request of ["default", undefined]) {
			const res = resolveModel(request, hub, db, "site-hub");
			expect(res.kind).toBe("error");
			if (res.kind === "error") expect(res.error).toContain("claude-opus-5-5");
		}
	});

	it("keeps the configured default transient when its only host is stale", () => {
		const hub = new ModelRouter(new Map(), "");
		addRemoteHost(db, "site-spoke", [NOVA_ENTRY]);
		const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, sync_url, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
			["site-stale", "stale", null, JSON.stringify([OPUS_ENTRY]), stale, stale],
		);
		setDefaultRoles(db, { default: "claude-opus-5-5" });
		const res = resolveModel(undefined, hub, db, "site-hub");
		expect(res.kind).toBe("error");
		if (res.kind === "error") expect(res.reason).toBe("transient-unavailable");
	});

	it("keeps hub bootstrap discovery when roles carry no default", () => {
		const hub = new ModelRouter(new Map(), "");
		addRemoteHost(db, "site-spoke", [NOVA_ENTRY]);
		setDefaultRoles(db, { heavy: "claude-opus-5-5" });
		const res = resolveModel(undefined, hub, db, "site-hub");
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") expect(res.modelId).toBe(NOVA_ENTRY.id);
	});

	for (const [label, roles, raw] of [
		["malformed JSON", "{not json", true],
		["a non-object value", "null", true],
		["an empty default", { default: "" }, false],
		["a non-string default", { default: 42 }, false],
	] as const) {
		it(`falls back to the local bootstrap default on ${label}`, () => {
			const router = routerWithOpus();
			setDefaultRoles(db, roles, raw);
			const res = resolveModel("default", router, db, SITE);
			expect(res.kind).toBe("local");
			if (res.kind === "local") expect(res.modelId).toBe("opus");
		});
	}
});

describe("resolveModel — role/alias resolution (§2.1, #281)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	function setRoles(roles: Record<string, string>): void {
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify(roles),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE,
		);
	}

	it("resolves an operator-named alias to its target local backend", () => {
		const router = routerWithOpus();
		// Alias `reviewer` → the local `opus` backend.
		setRoles({ reviewer: "opus" });
		const res = resolveModel("reviewer", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("resolves a non-default reserved role (heavy) to its target", () => {
		const router = routerWithOpus();
		setRoles({ heavy: "opus" });
		const res = resolveModel("heavy", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("lets an exact backend id beat an alias of the same name", () => {
		const router = routerWithOpus();
		// A perverse alias `opus` pointing elsewhere must NOT shadow the real
		// backend id `opus` — literal id precedence.
		router.addDynamicBackend("sonnet", stubBackend(), caps(), undefined, {
			routeId: makeRouteId(SITE, "anthropic", "sonnet"),
			reasoningOrigin: `${SITE}:anthropic`,
		});
		setRoles({ opus: "sonnet" });
		const res = resolveModel("opus", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("leaves a bare hint that is no role/alias untouched", () => {
		const router = routerWithOpus();
		setRoles({ reviewer: "opus" });
		const res = resolveModel("opus", router, db, SITE);
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("resolves an alias to a remote-only target (relay host selection)", () => {
		const router = routerWithOpus();
		// `sonnet` is served only by a remote host; the alias points there.
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, sync_url, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"site-remote",
				"Remote",
				"https://remote.example",
				JSON.stringify([
					{
						id: "sonnet",
						route_id: "site-remote:anthropic:sonnet",
						logical_model: "sonnet",
						capabilities: { max_context: 200000 },
					},
				]),
				0,
				now,
				now,
			],
		);
		setRoles({ heavy: "sonnet" });
		const res = resolveModel("heavy", router, db, SITE);
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") expect(res.modelId).toBe("sonnet");
	});
});

describe("resolveModel — hard route pin (§5.4)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	it("resolves to the pinned local route", () => {
		const router = routerWithOpus();
		const res = resolveModel("opus", router, db, SITE, undefined, {
			pin: { routeId: makeRouteId(SITE, "bedrock", "opus") },
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("errors 'no longer exists' when the pinned route is absent cluster-wide (never fails over)", () => {
		const router = routerWithOpus();
		// Pin a route that no backend or host advertises.
		const res = resolveModel("opus", router, db, SITE, undefined, {
			pin: { routeId: "site-ghost:bedrock:opus" },
		});
		expect(res.kind).toBe("error");
		if (res.kind === "error") {
			expect(res.reason).toBe("unknown-model");
			expect(res.error).toContain("no longer exists");
			// Crucially: it did NOT fall back to the eligible local 'opus' route.
		}
	});
});

describe("resolveModel — thread stickiness (§5.3, Done-when #2)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	it("reuses the prior ok turn's route within its cache window", () => {
		const router = routerWithOpus();
		const routeId = makeRouteId(SITE, "bedrock", "opus");
		// Record a prior ok turn on this thread that ran the opus route recently.
		recordTurn(
			db,
			{
				thread_id: "thread-1",
				model_id: "opus",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: new Date().toISOString(),
				route_id: routeId,
			},
			SITE,
		);
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("does not stick to a prior turn whose route is no longer eligible", () => {
		const router = routerWithOpus();
		// Prior turn ran a route that no longer exists; falls through to ranked
		// selection, which finds the live local opus backend.
		recordTurn(
			db,
			{
				thread_id: "thread-2",
				model_id: "opus",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: new Date().toISOString(),
				route_id: "site-ghost:bedrock:opus",
			},
			SITE,
		);
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-2",
			nowMs: Date.now(),
		});
		// Falls through to the live local opus (ranked selection), not an error.
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("falls through to ranked selection past the sticky cache window", () => {
		const router = routerWithOpus();
		const routeId = makeRouteId(SITE, "bedrock", "opus");
		// Prior turn is 2 hours old; opus has no cache_ttl, so the window is the 5m
		// floor — long cold. Resolution still lands on the live opus via ranking.
		recordTurn(
			db,
			{
				thread_id: "thread-3",
				model_id: "opus",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				route_id: routeId,
			},
			SITE,
		);
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-3",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
	});

	it("ignores a failed/aborted prior turn (status gate) for stickiness", () => {
		const router = routerWithOpus();
		recordTurn(
			db,
			{
				thread_id: "thread-4",
				model_id: "opus",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: new Date().toISOString(),
				route_id: "site-ghost:bedrock:opus",
				status: "error",
			},
			SITE,
		);
		// The only prior turn errored, so stickiness does not consider it and
		// resolution falls to ranked local opus.
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-4",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});
});

describe("resolveModel — drain exclusion in normal (non-sticky) resolution (§6.2, R-RT6/R-RT14, Done-when #4)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	/** Insert a non-stale remote host advertising `opus` on `routeId`. */
	function insertRemoteOpus(siteId: string, routeId: string): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				siteId,
				`Host ${siteId}`,
				JSON.stringify([
					{
						id: "opus",
						route_id: routeId,
						logical_model: "opus",
						capabilities: { max_context: 200000 },
					},
				]),
				0,
				now,
				now,
			],
		);
	}

	function drainRoute(routeId: string): void {
		insertRow(
			db,
			"route_drains",
			{
				route_id: routeId,
				drained_at: new Date().toISOString(),
				reason: null,
				deleted: 0,
				modified_at: new Date().toISOString(),
			},
			SITE,
		);
	}

	it("excludes a drained LOCAL route on a first turn, falling through to a non-drained remote route", () => {
		const router = routerWithOpus();
		const localRoute = makeRouteId(SITE, "bedrock", "opus");
		const remoteRoute = "site-remote:anthropic:opus";
		insertRemoteOpus("site-remote", remoteRoute);
		// Drain the local route. With no threadId (first turn), the drained local
		// backend must NOT win just by existing — resolution falls through to the
		// non-drained remote route serving the same model.
		drainRoute(localRoute);
		const res = resolveModel("opus", router, db, SITE);
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") {
			expect(res.hosts[0].site_id).toBe("site-remote");
			expect(res.hosts[0].routeId).toBe(remoteRoute);
		}
	});

	it("excludes a drained REMOTE route from normal resolution (no local backend for the model)", () => {
		// A router that holds no 'opus' backend: resolution goes straight to remote.
		const router = new ModelRouter(new Map<string, LLMBackend>(), "other");
		const remoteRoute = "site-remote:anthropic:opus";
		insertRemoteOpus("site-remote", remoteRoute);
		drainRoute(remoteRoute);
		// The only candidate route is drained → no eligible host → error.
		const res = resolveModel("opus", router, db, SITE);
		expect(res.kind).toBe("error");
	});

	it("keeps a non-drained remote route selectable when a DIFFERENT route is drained", () => {
		const router = new ModelRouter(new Map<string, LLMBackend>(), "other");
		const drainedRoute = "site-a:anthropic:opus";
		const liveRoute = "site-b:openai:opus";
		insertRemoteOpus("site-a", drainedRoute);
		insertRemoteOpus("site-b", liveRoute);
		drainRoute(drainedRoute);
		const res = resolveModel("opus", router, db, SITE);
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") {
			expect(res.hosts.some((h) => h.routeId === drainedRoute)).toBe(false);
			expect(res.hosts[0].routeId).toBe(liveRoute);
		}
	});
});

describe("resolveModel — route_order consulted in normal (non-sticky) resolution (§5.2, R-RT8, Done-when #1/#5)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	function insertRemoteOpus(siteId: string, routeId: string): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				siteId,
				`Host ${siteId}`,
				JSON.stringify([
					{
						id: "opus",
						route_id: routeId,
						logical_model: "opus",
						capabilities: { max_context: 200000 },
					},
				]),
				0,
				now,
				now,
			],
		);
	}

	it("ranks a route_order-listed remote route ahead of a lexically-smaller unlisted one", () => {
		const router = new ModelRouter(new Map<string, LLMBackend>(), "other");
		// 'bbb' is lexically after 'aaa', so without route_order 'aaa' ranks first.
		const routeAaa = "aaa-site:anthropic:opus";
		const routeBbb = "bbb-site:openai:opus";
		insertRemoteOpus("aaa-site", routeAaa);
		insertRemoteOpus("bbb-site", routeBbb);

		// Baseline: no route_order → lexical 'aaa' first.
		const baseline = resolveModel("opus", router, db, SITE);
		expect(baseline.kind).toBe("remote");
		if (baseline.kind === "remote") expect(baseline.hosts[0].routeId).toBe(routeAaa);

		// Operator route_order puts 'bbb' first — ranked selection must honor it.
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify([routeBbb]),
				fallback_policy: null,
				deleted: 0,
				modified_at: new Date().toISOString(),
			},
			SITE,
		);
		const ordered = resolveModel("opus", router, db, SITE);
		expect(ordered.kind).toBe("remote");
		if (ordered.kind === "remote") expect(ordered.hosts[0].routeId).toBe(routeBbb);
	});
});

describe("resolveModel — post-fallback stickiness (§7.3 step 4, R-RT20)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	function routerWithOpusAndSonnet(): ModelRouter {
		const backends = new Map<string, LLMBackend>([
			["opus", stubBackend()],
			["sonnet", stubBackend()],
		]);
		const effectiveCaps = new Map([
			["opus", caps()],
			["sonnet", caps()],
		]);
		const routeIdentities = new Map(
			["opus", "sonnet"].map((id) => [
				id,
				{ routeId: makeRouteId(SITE, "bedrock", id), reasoningOrigin: `${SITE}:bedrock` },
			]),
		);
		return new ModelRouter(
			backends,
			"opus",
			effectiveCaps,
			new Map(),
			undefined,
			Date.now,
			routeIdentities,
		);
	}

	function recordSubstitutedTurn(createdAt: string) {
		recordTurn(
			db,
			{
				thread_id: "thread-1",
				model_id: "sonnet",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: createdAt,
				route_id: makeRouteId(SITE, "bedrock", "sonnet"),
				substituted_from: "opus",
			},
			SITE,
		);
	}

	it("sticks to the substitute's route when the prior turn substituted for the requested model", () => {
		const router = routerWithOpusAndSonnet();
		recordSubstitutedTurn(new Date().toISOString());
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") {
			expect(res.modelId).toBe("sonnet");
			// The loop keeps stamping turns.substituted_from from this (R-RT20).
			expect(res.substitutedFrom).toBe("opus");
		}
	});

	it("returns to the requested model once the substitute's cache window is cold", () => {
		const router = routerWithOpusAndSonnet();
		recordSubstitutedTurn(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") expect(res.modelId).toBe("opus");
	});

	it("does not inherit a substitution recorded for a different requested model", () => {
		const router = routerWithOpusAndSonnet();
		recordSubstitutedTurn(new Date().toISOString());
		const res = resolveModel("sonnet", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") {
			expect(res.modelId).toBe("sonnet");
			expect(res.substitutedFrom).toBeUndefined();
		}
	});
});

describe("resolveModel — sticky substitute route never hard-pins (§5.3/§7.3, R-RT20)", () => {
	let db: Database;
	afterEach(() => db.close());
	beforeEach(() => {
		db = freshDb();
	});

	const SUB_ROUTE = "site-msi:zai:zai-glm-5.4";

	function recordGlmSubstitution(): void {
		recordTurn(
			db,
			{
				thread_id: "thread-1",
				model_id: "glm-5-4",
				tokens_in: 10,
				tokens_out: 10,
				tokens_cache_write: null,
				tokens_cache_read: null,
				created_at: new Date().toISOString(),
				route_id: SUB_ROUTE,
				substituted_from: "opus",
			},
			SITE,
		);
	}

	it("sticks to a remote substitute route advertised under its logical model", () => {
		const router = routerWithOpus();
		// Live shape: the turn records the LOGICAL model; the host advertises the
		// expanded backend id under that logical_model.
		addRemoteHost(db, "site-msi", [
			{
				id: "zai-glm-5.4",
				logical_model: "glm-5-4",
				route_id: SUB_ROUTE,
				capabilities: { max_context: 1000000 },
			},
		]);
		recordGlmSubstitution();
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") {
			expect(res.hosts[0].routeId).toBe(SUB_ROUTE);
			expect(res.substitutedFrom).toBe("opus");
		}
	});

	it("falls back to the requested model locally, with no error, when the sticky substitute route cannot be resolved", () => {
		const router = routerWithOpus();
		// Eligible for the sticky pool (fresh host, matching route) but carries no
		// max_context, so it cannot be turned into a resolution.
		addRemoteHost(db, "site-msi", [{ id: "glm-5-4", route_id: SUB_ROUTE, capabilities: {} }]);
		recordGlmSubstitution();
		const res = resolveModel("opus", router, db, SITE, undefined, {
			threadId: "thread-1",
			nowMs: Date.now(),
		});
		expect(res.kind).toBe("local");
		if (res.kind === "local") {
			expect(res.modelId).toBe("opus");
			expect(res.substitutedFrom).toBeUndefined();
		}
	});

	it("a real hard pin on a momentarily unavailable route still errors without failing over", () => {
		const router = routerWithOpus();
		const stale = "2020-01-01T00:00:00.000Z";
		db.run(
			`INSERT INTO hosts (site_id, host_name, sync_url, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
			[
				"site-msi",
				"site-msi",
				"https://site-msi.example",
				JSON.stringify([
					{ id: "opus", route_id: "site-msi:bedrock:opus", capabilities: { max_context: 200000 } },
				]),
				stale,
				stale,
			],
		);
		const res = resolveModel("opus", router, db, SITE, undefined, {
			pin: { routeId: "site-msi:bedrock:opus" },
		});
		expect(res.kind).toBe("error");
		if (res.kind === "error") {
			expect(res.reason).toBe("transient-unavailable");
			expect(res.error).toContain(
				'Pinned route "site-msi:bedrock:opus" is momentarily unavailable',
			);
		}
	});

	it("a hard pin resolves a remote route advertised under the pinned logical model", () => {
		const router = routerWithOpus();
		addRemoteHost(db, "site-msi", [
			{
				id: "zai-glm-5.4",
				logical_model: "glm-5-4",
				route_id: SUB_ROUTE,
				capabilities: { max_context: 1000000 },
			},
		]);
		const res = resolveModel("glm-5-4", router, db, SITE, undefined, {
			pin: { routeId: SUB_ROUTE },
		});
		expect(res.kind).toBe("remote");
		if (res.kind === "remote") expect(res.hosts[0].routeId).toBe(SUB_ROUTE);
	});
});
