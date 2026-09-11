import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createStatusRoutes } from "../routes/status";

describe("/api/models cluster aggregation (AC5.1-AC5.5)", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;
	const localHostName = "local-host";
	const localSiteId = "local-site-id";

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = createStatusRoutes(db, eventBus, localHostName, localSiteId, {
			models: [
				{ id: "local-claude", provider: "anthropic" },
				{ id: "local-gpt", provider: "openai" },
			],
			default: "local-claude",
		});

		// Insert local host row using raw SQL (for testing only)
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
		).run(localSiteId, localHostName, JSON.stringify(["local-claude", "local-gpt"]), now, now);
	});

	describe("AC5.1: Returns union of local and remote models", () => {
		it("returns local models from config", async () => {
			const res = await app.fetch(new Request("http://localhost/models"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				models: Array<{
					id: string;
					provider: string;
					host: string;
					via: string;
					status: string;
				}>;
			};

			const localModels = body.models.filter((m) => m.via === "local");
			expect(localModels).toHaveLength(2);
			expect(localModels[0].id).toBe("local-claude");
			expect(localModels[1].id).toBe("local-gpt");
		});

		it("includes remote models from hosts table", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("remote-site-1", "remote-host-1", JSON.stringify(["gpt-4"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				models: Array<{
					id: string;
					provider: string;
					host: string;
					via: string;
					status: string;
				}>;
			};

			const remoteModels = body.models.filter((m) => m.id === "gpt-4" && m.via === "relay");
			expect(remoteModels).toHaveLength(1);
			expect(remoteModels[0].host).toBe("remote-host-1");
		});
	});

	describe("AC5.2: Remote models annotated with relay", () => {
		it("marks remote models with via: relay", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("remote-site-2", "remote-host-2", JSON.stringify(["remote-model"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{
					id: string;
					host: string;
					via: string;
					status: string;
				}>;
			};

			const remoteModel = body.models.find((m) => m.id === "remote-model");
			expect(remoteModel?.via).toBe("relay");
			expect(remoteModel?.host).toBe("remote-host-2");
		});

		it("marks remote models with status: online when fresh", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("remote-site-3", "remote-host-3", JSON.stringify(["fresh-model"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "fresh-model");
			expect(model?.status).toBe("online");
		});
	});

	describe("AC5.3: Stale models annotated offline", () => {
		it("marks models offline when host online_at > 5 minutes ago", async () => {
			const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("stale-site", "stale-host", JSON.stringify(["stale-model"]), staleTime, staleTime);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "stale-model");
			expect(model?.status).toBe("offline?");
		});

		it("marks models offline when host online_at is null", async () => {
			const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run(
				"no-online-site",
				"no-online-host",
				JSON.stringify(["no-online-model"]),
				null,
				staleTime,
			);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "no-online-model");
			expect(model?.status).toBe("offline?");
		});
	});

	describe("#271: Duplicate model ids collapse to one entry", () => {
		it("lists a model shared across two remote hosts exactly once", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("host-a", "host-a", JSON.stringify(["shared-model"]), now, now);

			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("host-b", "host-b", JSON.stringify(["shared-model"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; host: string }>;
			};

			const sharedModels = body.models.filter((m) => m.id === "shared-model");
			expect(sharedModels).toHaveLength(1);
		});

		it("collapses a model present both locally and remotely, keeping the local annotation", async () => {
			// local-gpt is a local backend (seeded in beforeEach); advertise the same
			// id from a remote host. The API must return one entry, local-first.
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("remote-dup-site", "remote-dup-host", JSON.stringify(["local-gpt"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; provider: string; via: string; status: string }>;
			};

			const dupModels = body.models.filter((m) => m.id === "local-gpt");
			expect(dupModels).toHaveLength(1);
			expect(dupModels[0].via).toBe("local");
			expect(dupModels[0].status).toBe("local");
			expect(dupModels[0].provider).toBe("openai");
		});

		it("collapses two local backends sharing an id, keeping the first-seen provider", async () => {
			// Pooled backends: same id, distinct providers. Fresh route with two such
			// local backends — the API returns one entry, provider = first-seen.
			const pooledApp = createStatusRoutes(db, eventBus, localHostName, localSiteId, {
				models: [
					{ id: "opus", provider: "anthropic" },
					{ id: "opus", provider: "bedrock-mantle" },
				],
				default: "opus",
			});

			const res = await pooledApp.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string; provider: string }>;
				default: string;
			};

			const opusModels = body.models.filter((m) => m.id === "opus");
			expect(opusModels).toHaveLength(1);
			expect(opusModels[0].provider).toBe("anthropic");
			expect(body.default).toBe("opus");
		});

		it("preserves distinct model ids across local and remote (dedup is by id, not lossy)", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("distinct-site", "distinct-host", JSON.stringify(["remote-only-model"]), now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string }>;
			};

			const ids = body.models.map((m) => m.id);
			expect(ids).toContain("local-claude");
			expect(ids).toContain("local-gpt");
			expect(ids).toContain("remote-only-model");
		});
	});

	describe("Returns local models with correct annotations", () => {
		it("marks local models with host: hostName and via: local", async () => {
			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{
					id: string;
					host: string;
					via: string;
					status: string;
				}>;
			};

			const localModel = body.models.find((m) => m.id === "local-claude");
			expect(localModel?.host).toBe(localHostName);
			expect(localModel?.via).toBe("local");
			expect(localModel?.status).toBe("local");
		});

		it("includes default model in response", async () => {
			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as { default: string };

			expect(body.default).toBe("local-claude");
		});
	});

	describe("Live config (SIGHUP reload propagation)", () => {
		it("reflects a model added after route construction when given a config getter", async () => {
			// The /models endpoint historically captured a ModelsConfig snapshot at
			// route-construction time, so a SIGHUP reload that added a backend (e.g.
			// gpt-5.x) updated the router but never the discovery endpoint. Passing a
			// getter lets the route read live config per request.
			let live = {
				models: [{ id: "boot-model", provider: "anthropic" }],
				default: "boot-model",
			};
			const liveApp = createStatusRoutes(db, eventBus, localHostName, localSiteId, () => live);

			const before = (await (
				await liveApp.fetch(new Request("http://localhost/models"))
			).json()) as { models: Array<{ id: string }>; default: string };
			expect(before.models.map((m) => m.id)).toEqual(["boot-model"]);

			// Simulate SIGHUP reload reassigning appContext.config.modelBackends.
			live = {
				models: [
					{ id: "boot-model", provider: "anthropic" },
					{ id: "gpt-5.5", provider: "bedrock-mantle" },
				],
				default: "boot-model",
			};

			const after = (await (
				await liveApp.fetch(new Request("http://localhost/models"))
			).json()) as { models: Array<{ id: string; via: string }>; default: string };
			const localIds = after.models.filter((m) => m.via === "local").map((m) => m.id);
			expect(localIds).toEqual(["boot-model", "gpt-5.5"]);
		});
	});

	describe("Edge cases", () => {
		it("ignores remote hosts with invalid JSON in models column", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("bad-json-site", "bad-json-host", "not valid json", now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				models: Array<{ host: string }>;
			};

			const badHost = body.models.find((m) => m.host === "bad-json-host");
			expect(badHost).toBeFalsy();
		});

		it("ignores deleted hosts", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			).run("deleted-site", "deleted-host", JSON.stringify(["deleted-model"]), now, now, 1);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ id: string }>;
			};

			const deletedModel = body.models.find((m) => m.id === "deleted-model");
			expect(deletedModel).toBeFalsy();
		});

		it("ignores hosts with null models column", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("null-models-site", "null-models-host", null, now, now);

			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ host: string }>;
			};

			const nullHost = body.models.find((m) => m.host === "null-models-host");
			expect(nullHost).toBeFalsy();
		});

		it("excludes local host from remote query by site_id", async () => {
			const res = await app.fetch(new Request("http://localhost/models"));

			const body = (await res.json()) as {
				models: Array<{ host: string; via: string }>;
			};

			// Local models should appear with host=localHostName and via=local
			// but NOT as relay models even though it's in the hosts table
			const remoteLocalModels = body.models.filter(
				(m) => m.host === localHostName && m.via === "relay",
			);
			expect(remoteLocalModels).toHaveLength(0);
		});
	});
});
