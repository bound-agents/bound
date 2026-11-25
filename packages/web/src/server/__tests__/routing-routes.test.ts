import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import type { BackendCapabilities } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { createRoutingRoutes } from "../routes/routing";

// Exercises the Settings › Models server surface (2026-11-21-model-routing.md
// §9.3, 2026-11-21-model-catalog.md §9). The route assembles synced routing
// preferences (model_routing_rules / route_drains / model_aliases) against the
// per-host route supply advertised in hosts.models, folding in the local
// router's in-memory health snapshot, and mutates preferences through the
// change-log outbox (invariant #1). Health is NOT synced — it is read from the
// local ModelRouter only, so remote routes report health "unknown".

let db: Database;
let siteId: string;

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: false,
	vision: false,
	extended_thinking: false,
	max_context: 200000,
};

/** Seed a non-deleted host row advertising the given model entries. */
function seedHost(site: string, name: string, entries: unknown[]): void {
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, ?, 0, 1)",
	).run(site, name, JSON.stringify(entries), now, now);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	// A fixed, lexically-stable siteId so route-ordering assertions are deterministic.
	siteId = "site-aaaa";
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
});

describe("GET /models — Settings › Models assembly", () => {
	it("groups advertised routes under their logical model with supply fields", async () => {
		seedHost(siteId, "hub", [
			{ id: "gpt-5.6-sol", route_id: `${siteId}:codex:sol`, logical_model: "gpt-5.6-sol" },
		]);
		seedHost("site-msi", "MSI", [
			{ id: "gpt-5.6-sol", route_id: "site-msi:codex:sol", logical_model: "gpt-5.6-sol" },
		]);
		const app = createRoutingRoutes(db, siteId, null);

		const res = await app.fetch(new Request("http://localhost/models"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: Array<{
				logical_model: string;
				routes: Array<{ route_id: string; host_name: string; drained: boolean; health: string }>;
			}>;
		};
		const sol = body.models.find((m) => m.logical_model === "gpt-5.6-sol");
		expect(sol).toBeDefined();
		expect(sol?.routes.map((r) => r.route_id).sort()).toEqual([
			`${siteId}:codex:sol`,
			"site-msi:codex:sol",
		]);
		// No local router handle supplied → every route's health is "unknown".
		expect(sol?.routes.every((r) => r.health === "unknown")).toBe(true);
	});

	it("orders routes by the model's synced route_order, stale entries last", async () => {
		seedHost(siteId, "hub", [
			{ id: "opus", route_id: `${siteId}:anthropic:opus`, logical_model: "opus" },
		]);
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				// A dead RouteId first, then the live one: the live route sorts by its
				// declared position, the dead one surfaces as a stale entry.
				route_order: JSON.stringify(["dead:anthropic:opus", `${siteId}:anthropic:opus`]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			siteId,
		);
		const app = createRoutingRoutes(db, siteId, null);

		const res = await app.fetch(new Request("http://localhost/models"));
		const body = (await res.json()) as {
			models: Array<{
				logical_model: string;
				route_order: string[];
				routes: Array<{ route_id: string }>;
				stale_routes: Array<{ route_id: string }>;
			}>;
		};
		const opus = body.models.find((m) => m.logical_model === "opus");
		expect(opus?.route_order).toEqual(["dead:anthropic:opus", `${siteId}:anthropic:opus`]);
		expect(opus?.routes.map((r) => r.route_id)).toEqual([`${siteId}:anthropic:opus`]);
		expect(opus?.stale_routes.map((r) => r.route_id)).toEqual(["dead:anthropic:opus"]);
	});

	it("marks a drained route and reports the fallback policy", async () => {
		seedHost(siteId, "hub", [
			{ id: "haiku", route_id: `${siteId}:anthropic:haiku`, logical_model: "haiku" },
		]);
		insertRow(
			db,
			"route_drains",
			{
				route_id: `${siteId}:anthropic:haiku`,
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: "manual",
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			siteId,
		);
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "haiku",
				route_order: null,
				fallback_policy: JSON.stringify({ mode: "never" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			siteId,
		);
		const app = createRoutingRoutes(db, siteId, null);

		const res = await app.fetch(new Request("http://localhost/models"));
		const body = (await res.json()) as {
			models: Array<{
				logical_model: string;
				fallback_policy: { mode: string };
				routes: Array<{ route_id: string; drained: boolean }>;
			}>;
		};
		const haiku = body.models.find((m) => m.logical_model === "haiku");
		expect(haiku?.routes[0].drained).toBe(true);
		expect(haiku?.fallback_policy).toEqual({ mode: "never" });
	});

	it("reports local route health from the router snapshot", async () => {
		seedHost(siteId, "hub", [
			{ id: "opus", route_id: `${siteId}:anthropic:opus`, logical_model: "opus" },
		]);
		const router = new ModelRouter(new Map(), "opus");
		// Register a dynamic backend so the router can map backendId→RouteId.
		router.addDynamicBackend("opus", { capabilities: () => CAPS } as never, CAPS, undefined, {
			routeId: `${siteId}:anthropic:opus`,
			reasoningOrigin: `${siteId}:anthropic`,
		});
		const app = createRoutingRoutes(db, siteId, router);

		const res = await app.fetch(new Request("http://localhost/models"));
		const body = (await res.json()) as {
			models: Array<{ logical_model: string; routes: Array<{ route_id: string; health: string }> }>;
		};
		const opus = body.models.find((m) => m.logical_model === "opus");
		expect(opus?.routes[0].health).toBe("healthy");
	});
});

/** Advertise every model/route the preference-write tests reference. */
function seedSupply(): void {
	seedHost(siteId, "hub", [
		{ id: "opus", route_id: `${siteId}:anthropic:opus`, logical_model: "opus" },
		{ id: "opus-x", route_id: "a:x:1", logical_model: "opus" },
		{ id: "opus-y", route_id: "b:y:2", logical_model: "opus" },
		{ id: "haiku", route_id: `${siteId}:anthropic:haiku`, logical_model: "haiku" },
		{ id: "glm-5", route_id: `${siteId}:zai:glm-5`, logical_model: "glm-5" },
		{ id: "gpt-5.6-sol", route_id: `${siteId}:codex:sol`, logical_model: "gpt-5.6-sol" },
	]);
}

describe("PUT /models/:logical/route-order", () => {
	beforeEach(seedSupply);
	it("writes route_order through the outbox and round-trips", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/models/opus/route-order", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ route_order: ["a:x:1", "b:y:2"] }),
			}),
		);
		expect(res.status).toBe(200);
		const row = db
			.prepare(
				"SELECT route_order FROM model_routing_rules WHERE logical_model = ? AND deleted = 0",
			)
			.get("opus") as { route_order: string } | null;
		expect(JSON.parse(row?.route_order ?? "null")).toEqual(["a:x:1", "b:y:2"]);
		// The write must carry a change_log entry (synced; invariant #1).
		const cl = db
			.prepare("SELECT COUNT(*) as n FROM change_log WHERE table_name = 'model_routing_rules'")
			.get() as { n: number };
		expect(cl.n).toBeGreaterThan(0);
	});

	it("rejects a non-array payload with 400", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/models/opus/route-order", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ route_order: "nope" }),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("POST/DELETE /routes/:routeId/drain", () => {
	beforeEach(seedSupply);
	it("drains then un-drains a route", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const routeId = `${siteId}:anthropic:opus`;
		const enc = encodeURIComponent(routeId);

		const drain = await app.fetch(
			new Request(`http://localhost/routes/${enc}/drain`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason: "incident" }),
			}),
		);
		expect(drain.status).toBe(200);
		let row = db
			.prepare("SELECT reason FROM route_drains WHERE route_id = ? AND deleted = 0")
			.get(routeId) as { reason: string } | null;
		expect(row?.reason).toBe("incident");

		const undrain = await app.fetch(
			new Request(`http://localhost/routes/${enc}/drain`, { method: "DELETE" }),
		);
		expect(undrain.status).toBe(200);
		row = db
			.prepare("SELECT reason FROM route_drains WHERE route_id = ? AND deleted = 0")
			.get(routeId) as { reason: string } | null;
		expect(row).toBeNull();
	});
});

describe("PUT /models/:logical/fallback-policy", () => {
	beforeEach(seedSupply);
	it("stores a custom fallback list", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/models/opus/fallback-policy", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "custom", models: ["haiku", "glm-5"] }),
			}),
		);
		expect(res.status).toBe(200);
		const row = db
			.prepare(
				"SELECT fallback_policy FROM model_routing_rules WHERE logical_model = ? AND deleted = 0",
			)
			.get("opus") as { fallback_policy: string } | null;
		expect(JSON.parse(row?.fallback_policy ?? "null")).toEqual({
			mode: "custom",
			models: ["haiku", "glm-5"],
		});
	});

	it("rejects an unknown mode with 400", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/models/opus/fallback-policy", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "bogus" }),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("PUT /cluster-defaults", () => {
	beforeEach(seedSupply);
	it("stores the default fallback list and model roles as cluster_config", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/cluster-defaults", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					default_fallback_models: ["opus", "haiku"],
					roles: { default: "opus", heavy: "opus", fast: "haiku" },
				}),
			}),
		);
		expect(res.status).toBe(200);
		const fb = db
			.prepare("SELECT value FROM cluster_config WHERE key = 'routing.default_fallback_models'")
			.get() as { value: string } | null;
		expect(JSON.parse(fb?.value ?? "null")).toEqual(["opus", "haiku"]);
		const roles = db
			.prepare("SELECT value FROM cluster_config WHERE key = 'routing.model_roles'")
			.get() as { value: string } | null;
		expect(JSON.parse(roles?.value ?? "null")).toEqual({
			default: "opus",
			heavy: "opus",
			fast: "haiku",
		});
	});

	it("reads back the stored fallback list and roles through GET", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		await app.fetch(
			new Request("http://localhost/cluster-defaults", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					default_fallback_models: ["opus", "haiku"],
					roles: { default: "opus" },
				}),
			}),
		);
		const res = await app.fetch(new Request("http://localhost/cluster-defaults"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			default_fallback_models: string[];
			roles: Record<string, string>;
		};
		expect(body.default_fallback_models).toEqual(["opus", "haiku"]);
		expect(body.roles).toEqual({ default: "opus" });
	});

	it("returns an empty list and empty roles when nothing is stored", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(new Request("http://localhost/cluster-defaults"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			default_fallback_models: string[];
			roles: Record<string, string>;
		};
		expect(body.default_fallback_models).toEqual([]);
		expect(body.roles).toEqual({});
	});

	it("stores operator-named aliases alongside the reserved roles", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/cluster-defaults", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					roles: { default: "opus", reviewer: "opus", "gpt-fast": "gpt-5.6-sol" },
				}),
			}),
		);
		expect(res.status).toBe(200);
		const roles = db
			.prepare("SELECT value FROM cluster_config WHERE key = 'routing.model_roles'")
			.get() as { value: string } | null;
		expect(JSON.parse(roles?.value ?? "null")).toEqual({
			default: "opus",
			reviewer: "opus",
			"gpt-fast": "gpt-5.6-sol",
		});
	});

	it("rejects a role/alias name carrying the @ RouteId-pin syntax", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/cluster-defaults", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { "opus@site:p:opus": "opus" } }),
			}),
		);
		expect(res.status).toBe(400);
		const nothing = db
			.prepare("SELECT value FROM cluster_config WHERE key = 'routing.model_roles'")
			.get() as { value: string } | null;
		expect(nothing).toBeNull();
	});

	it("rejects a role/alias whose target is not a string", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request("http://localhost/cluster-defaults", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { default: 123 } }),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("PUT/DELETE /aliases/:providerKey", () => {
	it("assigns and clears an alias", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const enc = encodeURIComponent("codex:gpt-5.6-sol-2026");

		const assign = await app.fetch(
			new Request(`http://localhost/aliases/${enc}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ logical_model: "gpt-5.6-sol" }),
			}),
		);
		expect(assign.status).toBe(200);
		let row = db
			.prepare("SELECT logical_model FROM model_aliases WHERE provider_key = ? AND deleted = 0")
			.get("codex:gpt-5.6-sol-2026") as { logical_model: string | null } | null;
		expect(row?.logical_model).toBe("gpt-5.6-sol");

		const clear = await app.fetch(
			new Request(`http://localhost/aliases/${enc}`, { method: "DELETE" }),
		);
		expect(clear.status).toBe(200);
		row = db
			.prepare("SELECT logical_model FROM model_aliases WHERE provider_key = ? AND deleted = 0")
			.get("codex:gpt-5.6-sol-2026") as { logical_model: string | null } | null;
		expect(row).toBeNull();
	});
});

describe("GET /models — display-name disambiguation", () => {
	it("appends the snapshot only when two logical models share a display name", async () => {
		const e = (id: string, name: string) => ({
			id,
			route_id: `${siteId}:copilot:copilot-${id}`,
			logical_model: id,
			display_name: name,
			provider_model_id: id,
		});
		seedHost(siteId, "hub", [
			e("gpt-4o", "GPT-4o"),
			e("gpt-4o-2024-08-06", "GPT-4o"),
			e("gpt-4o-2024-11-20", "GPT-4o"),
			e("gpt-4-o-preview", "GPT-4o"),
			e("gpt-4o-mini", "GPT-4o mini"),
			e("gpt-6-luna", "GPT-6 Luna"),
		]);
		const app = createRoutingRoutes(db, siteId, null);
		const body = (await (await app.fetch(new Request("http://localhost/models"))).json()) as {
			models: Array<{ logical_model: string; display_name: string }>;
		};
		const names = Object.fromEntries(body.models.map((m) => [m.logical_model, m.display_name]));
		expect(names).toEqual({
			"gpt-4o": "GPT-4o",
			"gpt-4o-2024-08-06": "GPT-4o (2024-08-06)",
			"gpt-4o-2024-11-20": "GPT-4o (2024-11-20)",
			"gpt-4-o-preview": "GPT-4o (preview)",
			"gpt-4o-mini": "GPT-4o mini",
			"gpt-6-luna": "GPT-6 Luna",
		});
		expect(new Set(Object.values(names)).size).toBe(6);
	});
});

describe("GET /models — cluster-wide route health from peer snapshots", () => {
	type Body = {
		models: Array<{
			logical_model: string;
			routes: Array<{
				route_id: string;
				health: string;
				next_trial_at: number | null;
				health_source: string | null;
				health_observed_at: number | null;
			}>;
		}>;
	};
	const MSI_ROUTE = "site-msi:bedrock:opus";

	function seedMsi(onlineAt: string = new Date().toISOString()): void {
		db.prepare(
			"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, ?, 0, 1)",
		).run(
			"site-msi",
			"MSI",
			JSON.stringify([{ id: "opus", route_id: MSI_ROUTE, logical_model: "opus" }]),
			onlineAt,
			onlineAt,
		);
	}

	async function msiRoute(app: ReturnType<typeof createRoutingRoutes>) {
		const res = await app.fetch(new Request("http://localhost/models"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		return body.models.find((m) => m.logical_model === "opus")?.routes[0];
	}

	it("reports a remote route healthy from the serving host's snapshot", async () => {
		seedMsi();
		const asked: Array<{ site: string; timeout: number }> = [];
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => 1_000_000,
			relayRouteHealth: async (site, timeout) => {
				asked.push({ site, timeout });
				return { routes: [{ route_id: MSI_ROUTE, status: "healthy", next_trial_in_ms: null }] };
			},
		});
		const route = await msiRoute(app);
		expect(asked).toEqual([{ site: "site-msi", timeout: 4_000 }]);
		expect(route?.health).toBe("healthy");
		expect(route?.health_source).toBe("remote");
		expect(route?.health_observed_at).toBe(1_000_000);
	});

	it("converts a remote backoff to this host's clock", async () => {
		seedMsi();
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => 5_000,
			relayRouteHealth: async () => ({
				routes: [{ route_id: MSI_ROUTE, status: "backoff", next_trial_in_ms: 30_000 }],
			}),
		});
		const route = await msiRoute(app);
		expect(route?.health).toBe("backoff");
		expect(route?.next_trial_at).toBe(35_000);
	});

	it("keeps a route unknown when the peer does not answer", async () => {
		seedMsi();
		const app = createRoutingRoutes(db, siteId, null, {
			relayRouteHealth: async () => {
				throw new Error("Timeout waiting for platform_request response from site-msi");
			},
		});
		const route = await msiRoute(app);
		expect(route?.health).toBe("unknown");
		expect(route?.health_source).toBeNull();
	});

	it("keeps a route unknown when the peer's snapshot omits it", async () => {
		seedMsi();
		const app = createRoutingRoutes(db, siteId, null, {
			relayRouteHealth: async () => ({ routes: [] }),
		});
		expect((await msiRoute(app))?.health).toBe("unknown");
	});

	it("never asks, and never infers health from, a stale heartbeat", async () => {
		seedMsi(new Date(Date.now() - 10 * 60_000).toISOString());
		let asked = 0;
		const app = createRoutingRoutes(db, siteId, null, {
			relayRouteHealth: async () => {
				asked++;
				return { routes: [{ route_id: MSI_ROUTE, status: "healthy", next_trial_in_ms: null }] };
			},
		});
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(asked).toBe(0);
	});

	it("reuses a fresh snapshot, then ages a failed peer out to unknown", async () => {
		seedMsi();
		let now = 0;
		let calls = 0;
		let fail = false;
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => now,
			snapshotReuseMs: 15_000,
			snapshotMaxAgeMs: 60_000,
			hostLivenessMs: Number.POSITIVE_INFINITY,
			relayRouteHealth: async () => {
				calls++;
				if (fail) throw new Error("unreachable");
				return { routes: [{ route_id: MSI_ROUTE, status: "healthy", next_trial_in_ms: null }] };
			},
		});
		expect((await msiRoute(app))?.health).toBe("healthy");
		now = 10_000;
		expect((await msiRoute(app))?.health).toBe("healthy");
		expect(calls).toBe(1);
		fail = true;
		now = 30_000;
		// Refresh fails; the 30s-old observation is still within the age limit.
		expect((await msiRoute(app))?.health).toBe("healthy");
		expect(calls).toBe(2);
		now = 61_000;
		expect((await msiRoute(app))?.health).toBe("unknown");
	});

	it("asks a failing peer once per retry window, starting at clock zero", async () => {
		seedMsi();
		let now = 0;
		let calls = 0;
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => now,
			snapshotReuseMs: 15_000,
			snapshotMaxAgeMs: 60_000,
			hostLivenessMs: Number.POSITIVE_INFINITY,
			relayRouteHealth: async () => {
				calls++;
				throw new Error("no handler for route_health");
			},
		});
		for (let i = 0; i < 5; i++) expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(1);
		now = 14_999;
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(1);
		now = 15_000;
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(2);
		for (let i = 0; i < 3; i++) await msiRoute(app);
		expect(calls).toBe(2);
	});

	it("gates a timed-out peer the same way and shares the in-flight attempt", async () => {
		seedMsi();
		let now = 0;
		let calls = 0;
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => now,
			remoteTimeoutMs: 0,
			snapshotReuseMs: 15_000,
			hostLivenessMs: Number.POSITIVE_INFINITY,
			relayRouteHealth: () => {
				calls++;
				return new Promise(() => {});
			},
		});
		const concurrent = await Promise.all([msiRoute(app), msiRoute(app)]);
		expect(concurrent.map((r) => r?.health)).toEqual(["unknown", "unknown"]);
		expect(calls).toBe(1);
		now = 10_000;
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(1);
		now = 15_000;
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(2);
	});

	it("keeps an expired observation unknown while retries stay gated", async () => {
		seedMsi();
		let now = 0;
		let calls = 0;
		let fail = false;
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => now,
			snapshotReuseMs: 15_000,
			snapshotMaxAgeMs: 60_000,
			hostLivenessMs: Number.POSITIVE_INFINITY,
			relayRouteHealth: async () => {
				calls++;
				if (fail) throw new Error("unreachable");
				return { routes: [{ route_id: MSI_ROUTE, status: "healthy", next_trial_in_ms: null }] };
			},
		});
		expect((await msiRoute(app))?.health).toBe("healthy");
		fail = true;
		now = 61_000;
		expect((await msiRoute(app))?.health).toBe("unknown");
		expect(calls).toBe(2);
		now = 70_000;
		const route = await msiRoute(app);
		expect(route?.health).toBe("unknown");
		expect(route?.health_source).toBeNull();
		expect(calls).toBe(2);
	});

	it("tracks a peer's recovery across reads (backoff, then healthy)", async () => {
		seedMsi();
		let now = 0;
		let status: "backoff" | "healthy" = "backoff";
		const app = createRoutingRoutes(db, siteId, null, {
			clock: () => now,
			hostLivenessMs: Number.POSITIVE_INFINITY,
			relayRouteHealth: async () => ({
				routes: [
					{
						route_id: MSI_ROUTE,
						status,
						next_trial_in_ms: status === "backoff" ? 20_000 : null,
					},
				],
			}),
		});
		expect((await msiRoute(app))?.health).toBe("backoff");
		status = "healthy";
		now = 20_000;
		const route = await msiRoute(app);
		expect(route?.health).toBe("healthy");
		expect(route?.next_trial_at).toBeNull();
	});

	it("does not ask peers for local routes and marks local health as local", async () => {
		seedHost(siteId, "hub", [
			{ id: "opus", route_id: `${siteId}:anthropic:opus`, logical_model: "opus" },
		]);
		const router = new ModelRouter(new Map(), "opus");
		router.addDynamicBackend("opus", { capabilities: () => CAPS } as never, CAPS, undefined, {
			routeId: `${siteId}:anthropic:opus`,
			reasoningOrigin: `${siteId}:anthropic`,
		});
		let asked = 0;
		const app = createRoutingRoutes(db, siteId, router, {
			relayRouteHealth: async () => {
				asked++;
				return { routes: [] };
			},
		});
		const route = await msiRoute(app);
		expect(route?.health).toBe("healthy");
		expect(route?.health_source).toBe("local");
		expect(asked).toBe(0);
	});
});

describe("Wave 3 validation (422)", () => {
	beforeEach(seedSupply);
	const put = (app: ReturnType<typeof createRoutingRoutes>, path: string, body: unknown) =>
		app.fetch(
			new Request(`http://localhost${path}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	it("rejects an unknown RouteId in route_order", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await put(app, "/models/opus/route-order", { route_order: ["ghost:x:1"] });
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: string }).error).toContain("ghost:x:1");
	});

	it("allows removing a stale RouteId already in route_order", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify(["dead:a:b", "a:x:1"]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			siteId,
		);
		const res = await put(app, "/models/opus/route-order", { route_order: ["dead:a:b"] });
		expect(res.status).toBe(200);
	});

	it("rejects self-fallback and unknown fallback targets", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const self = await put(app, "/models/opus/fallback-policy", {
			mode: "custom",
			models: ["opus"],
		});
		expect(self.status).toBe(422);
		const ghost = await put(app, "/models/opus/fallback-policy", {
			mode: "custom",
			models: ["ghost"],
		});
		expect(ghost.status).toBe(422);
		expect(((await ghost.json()) as { error: string }).error).toContain("ghost");
	});

	it("normalizes an empty custom fallback list to never", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await put(app, "/models/opus/fallback-policy", { mode: "custom", models: [] });
		expect(res.status).toBe(200);
		const row = db
			.prepare("SELECT fallback_policy FROM model_routing_rules WHERE logical_model = 'opus'")
			.get() as { fallback_policy: string };
		expect(JSON.parse(row.fallback_policy)).toEqual({ mode: "never" });
	});

	it("rejects a role targeting an unadvertised model but allows clearing and unchanged dangling roles", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const bad = await put(app, "/cluster-defaults", { roles: { default: "ghost" } });
		expect(bad.status).toBe(422);
		expect(((await bad.json()) as { error: string }).error).toContain("ghost");
		insertRow(
			db,
			"cluster_config",
			{
				key: "routing.model_roles",
				value: JSON.stringify({ heavy: "gone" }),
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			},
			siteId,
		);
		const keep = await put(app, "/cluster-defaults", { roles: { heavy: "gone", fast: "haiku" } });
		expect(keep.status).toBe(200);
		const clear = await put(app, "/cluster-defaults", { roles: { fast: "haiku" } });
		expect(clear.status).toBe(200);
	});

	it("rejects an unknown default fallback model", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await put(app, "/cluster-defaults", { default_fallback_models: ["ghost"] });
		expect(res.status).toBe(422);
	});

	it("rejects draining an unadvertised route", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(
			new Request(`http://localhost/routes/${encodeURIComponent("ghost:x:1")}/drain`, {
				method: "POST",
			}),
		);
		expect(res.status).toBe(422);
	});

	it("sorts GET /models by display name case-insensitively", async () => {
		const app = createRoutingRoutes(db, siteId, null);
		const res = await app.fetch(new Request("http://localhost/models"));
		const body = (await res.json()) as { models: Array<{ display_name: string }> };
		const names = body.models.map((m) => m.display_name);
		expect(names).toEqual(
			[...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
		);
	});
});
