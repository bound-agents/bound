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
		app = createStatusRoutes(
			db,
			eventBus,
			localHostName,
			localSiteId,
			{
				models: [
					{ id: "local-claude", provider: "anthropic" },
					{ id: "local-gpt", provider: "openai" },
				],
				default: "local-claude",
			},
		);

		// Insert local host row using raw SQL (for testing only)
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
		).run(
			localSiteId,
			localHostName,
			JSON.stringify(["local-claude", "local-gpt"]),
			now,
			now,
		);
	});

	describe("AC5.1: Returns union of local and remote models", () => {
		it("returns local models from config", async () => {
			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

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

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

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

			const remoteModels = body.models.filter(
				(m) => m.id === "gpt-4" && m.via === "relay",
			);
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

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{
					id: string;
					host: string;
					via: string;
					status: string;
				}>;
			};

			const remoteModel = body.models.find(
				(m) => m.id === "remote-model",
			);
			expect(remoteModel?.via).toBe("relay");
			expect(remoteModel?.host).toBe("remote-host-2");
		});

		it("marks remote models with status: online when fresh", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("remote-site-3", "remote-host-3", JSON.stringify(["fresh-model"]), now, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "fresh-model");
			expect(model?.status).toBe("online");
		});
	});

	describe("AC5.3: Stale models annotated offline", () => {
		it("marks models offline when host online_at > 5 minutes ago", async () => {
			const staleTime = new Date(
				Date.now() - 6 * 60 * 1000,
			).toISOString();
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("stale-site", "stale-host", JSON.stringify(["stale-model"]), staleTime, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "stale-model");
			expect(model?.status).toBe("offline?");
		});

		it("marks models offline when host online_at is null", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("no-online-site", "no-online-host", JSON.stringify(["no-online-model"]), null, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ id: string; status: string }>;
			};

			const model = body.models.find((m) => m.id === "no-online-model");
			expect(model?.status).toBe("offline?");
		});
	});

	describe("AC5.5: Same model on multiple hosts listed separately", () => {
		it("lists shared model from each host with different host annotations", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("host-a", "host-a", JSON.stringify(["shared-model"]), now, now);

			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("host-b", "host-b", JSON.stringify(["shared-model"]), now, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ id: string; host: string }>;
			};

			const sharedModels = body.models.filter(
				(m) => m.id === "shared-model",
			);
			expect(sharedModels).toHaveLength(2);
			expect(sharedModels.map((m) => m.host).sort()).toEqual([
				"host-a",
				"host-b",
			]);
		});
	});

	describe("Returns local models with correct annotations", () => {
		it("marks local models with host: hostName and via: local", async () => {
			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

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
			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as { default: string };

			expect(body.default).toBe("local-claude");
		});
	});

	describe("Edge cases", () => {
		it("ignores remote hosts with invalid JSON in models column", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("bad-json-site", "bad-json-host", "not valid json", now, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				models: Array<{ host: string }>;
			};

			const badHost = body.models.find(
				(m) => m.host === "bad-json-host",
			);
			expect(badHost).toBeFalsy();
		});

		it("ignores deleted hosts", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			).run("deleted-site", "deleted-host", JSON.stringify(["deleted-model"]), now, now, 1);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ id: string }>;
			};

			const deletedModel = body.models.find(
				(m) => m.id === "deleted-model",
			);
			expect(deletedModel).toBeFalsy();
		});

		it("ignores hosts with null models column", async () => {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			).run("null-models-site", "null-models-host", null, now, now);

			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

			const body = (await res.json()) as {
				models: Array<{ host: string }>;
			};

			const nullHost = body.models.find(
				(m) => m.host === "null-models-host",
			);
			expect(nullHost).toBeFalsy();
		});

		it("excludes local host from remote query by site_id", async () => {
			const res = await app.fetch(
				new Request("http://localhost/models"),
			);

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
