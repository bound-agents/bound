import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebApp } from "../index";

describe("Server Integration", () => {
	let db: ReturnType<typeof createDatabase>;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
	});

	describe("HTTP Routes", () => {
		it("serves API routes at /api/status", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/status");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toHaveProperty("host_info");
			expect(data.host_info).toHaveProperty("uptime_seconds");
			expect(data.host_info).toHaveProperty("active_loops");
		});

		it("serves /api/threads endpoint", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const threads = await response.json();
			expect(Array.isArray(threads)).toBe(true);
			expect(threads.length).toBe(0);
		});

		it("handles POST /api/threads to create a thread", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(201);
			const thread = await response.json();
			expect(thread.id).toBeDefined();
			expect(thread.user_id).toBe("test-operator");
		});

		it("handles GET /api/tasks", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/tasks");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const tasks = await response.json();
			expect(Array.isArray(tasks)).toBe(true);
		});

		it("handles GET /api/files", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/files");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const files = await response.json();
			expect(Array.isArray(files)).toBe(true);
		});

		it("serves static assets (SPA fallback)", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			// Note: This assumes dist/client/index.html exists from the build
			const request = new Request("http://localhost:3000/");
			const response = await app.fetch(request);

			// The response should be HTML (200) or not found if SPA wasn't built
			// We're just checking it doesn't error
			expect([200, 404]).toContain(response.status);
		});
	});

	describe("API error handling", () => {
		it("returns 404 for non-existent threads", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/threads/nonexistent");
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("Thread not found");
		});

		it("returns consistent error format", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
			const request = new Request("http://localhost:3000/api/threads/invalid-id");
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error).toHaveProperty("error");
		});
	});
});
