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

	describe("POST /api/threads/:id/messages", () => {
		it("creates a message for a thread", async () => {
			// First create a thread
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			// Then create a message
			const messageRequest = new Request(
				`http://localhost:3000/api/threads/${thread.id}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "Hello, world!" }),
				},
			);
			const messageResponse = await app.fetch(messageRequest);

			expect(messageResponse.status).toBe(201);
			const message = await messageResponse.json();
			expect(message.id).toBeDefined();
			expect(message.content).toBe("Hello, world!");
			expect(message.role).toBe("user");
			expect(message.thread_id).toBe(thread.id);
		});

		it("returns 404 for message on non-existent thread", async () => {
			const request = new Request("http://localhost:3000/api/threads/invalid-id/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "test" }),
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
		});

		it("returns 400 for invalid message body", async () => {
			// Create a thread first
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			// Try to create a message with invalid body
			const messageRequest = new Request(
				`http://localhost:3000/api/threads/${thread.id}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invalid: "body" }),
				},
			);
			const response = await app.fetch(messageRequest);

			expect(response.status).toBe(400);
		});
	});

	describe("GET /api/threads/:id/messages", () => {
		it("returns messages for a thread", async () => {
			// Create a thread and message
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			const messageRequest = new Request(
				`http://localhost:3000/api/threads/${thread.id}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "Test message" }),
				},
			);
			await app.fetch(messageRequest);

			// Get messages
			const getRequest = new Request(`http://localhost:3000/api/threads/${thread.id}/messages`);
			const getResponse = await app.fetch(getRequest);

			expect(getResponse.status).toBe(200);
			const messages = await getResponse.json();
			expect(Array.isArray(messages)).toBe(true);
			expect(messages.length).toBe(1);
			expect(messages[0].content).toBe("Test message");
		});
	});

	describe("POST /api/status/cancel/:threadId", () => {
		it("cancels an agent loop for a thread", async () => {
			// Create a thread first
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			// Cancel the agent loop
			const cancelRequest = new Request(`http://localhost:3000/api/status/cancel/${thread.id}`, {
				method: "POST",
			});
			const cancelResponse = await app.fetch(cancelRequest);

			expect(cancelResponse.status).toBe(200);
			const result = await cancelResponse.json();
			expect(result.cancelled).toBe(true);
			expect(result.thread_id).toBe(thread.id);
		});

		it("returns 404 for cancel on non-existent thread", async () => {
			const request = new Request("http://localhost:3000/api/status/cancel/invalid-id", {
				method: "POST",
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
		});
	});

	describe("Host header validation", () => {
		it("rejects non-localhost Host headers", async () => {
			const request = new Request("http://example.com:3000/api/threads", {
				headers: { Host: "example.com" },
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(400);
			const error = await response.json();
			expect(error.error).toBe("Invalid Host header");
		});

		it("allows localhost Host headers", async () => {
			const request = new Request("http://localhost:3000/api/threads", {
				headers: { Host: "localhost:3000" },
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
		});
	});
});
