import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";

describe("API Routes", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = createApp(db, eventBus);
	});

	describe("GET /api/threads", () => {
		it("returns empty array when no threads exist", async () => {
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(0);
		});
	});

	describe("POST /api/threads", () => {
		it("creates a new thread", async () => {
			const request = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(201);
			const thread = await response.json();
			expect(thread.id).toBeDefined();
			expect(thread.user_id).toBe("default_web_user");
			expect(thread.interface).toBe("web");
		});
	});

	describe("GET /api/threads/:id", () => {
		it("returns 404 for non-existent thread", async () => {
			const request = new Request("http://localhost:3000/api/threads/invalid-id");
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("Thread not found");
		});

		it("returns thread by id", async () => {
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const createResponse = await app.fetch(createRequest);
			const thread = await createResponse.json();

			const getRequest = new Request(`http://localhost:3000/api/threads/${thread.id}`);
			const getResponse = await app.fetch(getRequest);

			expect(getResponse.status).toBe(200);
			const retrieved = await getResponse.json();
			expect(retrieved.id).toBe(thread.id);
		});
	});

	describe("GET /api/status", () => {
		it("returns system status", async () => {
			const request = new Request("http://localhost:3000/api/status");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const status = await response.json();
			expect(status.host_info).toBeDefined();
			expect(status.host_info.uptime_seconds).toBeDefined();
			expect(status.host_info.active_loops).toBeDefined();
		});
	});

	describe("GET /api/tasks", () => {
		it("returns empty array when no tasks exist", async () => {
			const request = new Request("http://localhost:3000/api/tasks");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
		});
	});

	describe("GET /api/files", () => {
		it("returns empty array when no files exist", async () => {
			const request = new Request("http://localhost:3000/api/files");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
		});
	});
});
