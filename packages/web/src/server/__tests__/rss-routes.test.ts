import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { createRssFeedsRoutes } from "../routes/rss";

let db: Database;
let siteId: string;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);
	siteId = `test-site-${randomBytes(4).toString("hex")}`;
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
});

function createBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		name: "test-feed",
		url: "https://example.com/feed.xml",
		...overrides,
	});
}

describe("rss-feeds routes", () => {
	describe("POST / creates feed, thread, and event task", () => {
		it("creates the three-row binding", async () => {
			const app = createRssFeedsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);

			expect(response.status).toBe(201);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json.name).toBe("test-feed");
			expect(json.url).toBe("https://example.com/feed.xml");
			expect(json.poll_interval_seconds).toBe(900);
			// seen_guids is poller-internal and must not leak into the response.
			expect(json).not.toHaveProperty("seen_guids");

			const task = db
				.prepare("SELECT type, trigger_spec, thread_id FROM tasks WHERE id = ?")
				.get(json.task_id as string) as {
				type: string;
				trigger_spec: string;
				thread_id: string;
			};
			expect(task.type).toBe("event");
			expect(task.trigger_spec).toBe("rss:test-feed");
			expect(task.thread_id).toBe(json.thread_id);

			const thread = db
				.prepare("SELECT interface, title FROM threads WHERE id = ?")
				.get(json.thread_id as string) as { interface: string; title: string };
			expect(thread.interface).toBe("rss");
			expect(thread.title).toBe("RSS: test-feed");
		});

		it("rejects invalid names", async () => {
			const app = createRssFeedsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: createBody({ name: "Bad Name!" }),
				}),
			);
			expect(response.status).toBe(400);
		});

		it("rejects non-http(s) URLs", async () => {
			const app = createRssFeedsRoutes(db);
			for (const url of ["file:///etc/passwd", "not a url", ""]) {
				const response = await app.fetch(
					new Request("http://localhost/", { method: "POST", body: createBody({ url }) }),
				);
				expect(response.status).toBe(400);
			}
		});

		it("rejects poll intervals under the floor", async () => {
			const app = createRssFeedsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: createBody({ poll_interval_seconds: 5 }),
				}),
			);
			expect(response.status).toBe(400);
		});

		it("rejects duplicate names", async () => {
			const app = createRssFeedsRoutes(db);
			await app.fetch(new Request("http://localhost/", { method: "POST", body: createBody() }));
			const response = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			expect(response.status).toBe(400);
		});

		it("restores a soft-deleted feed in place (deterministic id)", async () => {
			const app = createRssFeedsRoutes(db);
			const first = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			const firstJson = (await first.json()) as Record<string, unknown>;

			await app.fetch(new Request(`http://localhost/${firstJson.id}`, { method: "DELETE" }));

			const second = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			expect(second.status).toBe(201);
			const secondJson = (await second.json()) as Record<string, unknown>;
			expect(secondJson.id).toBe(firstJson.id);
		});
	});

	describe("GET / and GET /:id", () => {
		it("lists feeds with task-derived fields", async () => {
			const app = createRssFeedsRoutes(db);
			await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: createBody({ prompt: "Summarize new items", no_history: true }),
				}),
			);

			const response = await app.fetch(new Request("http://localhost/"));
			expect(response.status).toBe(200);
			const list = (await response.json()) as Array<Record<string, unknown>>;
			expect(list.length).toBe(1);
			expect(list[0].prompt).toBe("Summarize new items");
			expect(list[0].no_history).toBe(true);
		});

		it("404s for a missing feed", async () => {
			const app = createRssFeedsRoutes(db);
			const response = await app.fetch(new Request("http://localhost/nonexistent-id"));
			expect(response.status).toBe(404);
		});
	});

	describe("PATCH /:id", () => {
		it("updates url and resets the dedup cursor", async () => {
			const app = createRssFeedsRoutes(db);
			const created = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			const { id } = (await created.json()) as { id: string };

			// Simulate poller-advanced cursor.
			db.prepare("UPDATE rss_feeds SET seen_guids = ? WHERE id = ?").run('["a","b"]', id);

			const response = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ url: "https://other.example.com/feed.xml" }),
				}),
			);
			expect(response.status).toBe(200);

			const row = db.prepare("SELECT url, seen_guids FROM rss_feeds WHERE id = ?").get(id) as {
				url: string;
				seen_guids: string | null;
			};
			expect(row.url).toBe("https://other.example.com/feed.xml");
			expect(row.seen_guids).toBeNull();
		});

		it("updates prompt/model_hint/no_history on the linked task", async () => {
			const app = createRssFeedsRoutes(db);
			const created = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			const { id, task_id } = (await created.json()) as { id: string; task_id: string };

			const response = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ prompt: "New prompt", model_hint: "haiku", no_history: true }),
				}),
			);
			expect(response.status).toBe(200);

			const task = db
				.prepare("SELECT system_prompt_addition, model_hint, no_history FROM tasks WHERE id = ?")
				.get(task_id) as {
				system_prompt_addition: string;
				model_hint: string;
				no_history: number;
			};
			expect(task.system_prompt_addition).toBe("New prompt");
			expect(task.model_hint).toBe("haiku");
			expect(task.no_history).toBe(1);
		});

		it("rejects an invalid poll interval", async () => {
			const app = createRssFeedsRoutes(db);
			const created = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			const { id } = (await created.json()) as { id: string };

			const response = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ poll_interval_seconds: 1 }),
				}),
			);
			expect(response.status).toBe(400);
		});
	});

	describe("DELETE /:id", () => {
		it("soft-deletes the feed and cancels the task", async () => {
			const app = createRssFeedsRoutes(db);
			const created = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody() }),
			);
			const { id, task_id } = (await created.json()) as { id: string; task_id: string };

			const response = await app.fetch(new Request(`http://localhost/${id}`, { method: "DELETE" }));
			expect(response.status).toBe(204);

			const feed = db.prepare("SELECT deleted FROM rss_feeds WHERE id = ?").get(id) as {
				deleted: number;
			};
			expect(feed.deleted).toBe(1);

			const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task_id) as {
				status: string;
			};
			expect(task.status).toBe("cancelled");
		});
	});
});
