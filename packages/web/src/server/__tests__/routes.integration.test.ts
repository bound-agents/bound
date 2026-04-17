import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createWebApp } from "../index";

describe("API Routes", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
		app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
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

	describe("GET /api/threads - enhanced fields", () => {
		it("includes messageCount for threads with messages", async () => {
			// Create a thread via API
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const createResponse = await app.fetch(createRequest);
			const thread = await createResponse.json();

			// Insert 3 messages for the thread
			const now = new Date().toISOString();
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[`msg-${i}`, thread.id, "user", `message ${i}`, now, now, "localhost", 0],
				);
			}

			// Fetch threads list
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);
			const threads = await response.json();

			expect(threads.length).toBe(1);
			expect(threads[0].messageCount).toBe(3);
		});

		it("returns messageCount as 0 for threads with no messages", async () => {
			// Create a thread via API (without inserting messages)
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			await app.fetch(createRequest);

			// Fetch threads list
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);
			const threads = await response.json();

			expect(threads.length).toBe(1);
			expect(threads[0].messageCount).toBe(0);
		});

		it("includes lastModel from most recent turn", async () => {
			// Create a thread via API
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const createResponse = await app.fetch(createRequest);
			const thread = await createResponse.json();

			// Insert a turn with model_id = "opus"
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[thread.id, "opus", 100, 50, now],
			);

			// Fetch threads list
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);
			const threads = await response.json();

			expect(threads.length).toBe(1);
			expect(threads[0].lastModel).toBe("opus");
		});

		it("returns lastModel as null for threads with no turns", async () => {
			// Create a thread via API (without inserting turns)
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			await app.fetch(createRequest);

			// Fetch threads list
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);
			const threads = await response.json();

			expect(threads.length).toBe(1);
			expect(threads[0].lastModel).toBeNull();
		});

		it("returns lastModel from most recent turn when multiple turns exist", async () => {
			// Create a thread via API
			const createRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const createResponse = await app.fetch(createRequest);
			const thread = await createResponse.json();

			// Insert multiple turns with different models
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[thread.id, "gpt-4", 100, 50, now],
			);
			db.run(
				`INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[thread.id, "claude", 200, 100, now],
			);

			// Fetch threads list
			const request = new Request("http://localhost:3000/api/threads");
			const response = await app.fetch(request);
			const threads = await response.json();

			expect(threads.length).toBe(1);
			// Should be "claude" since it has the highest id (most recent)
			expect(threads[0].lastModel).toBe("claude");
		});
	});

	describe("POST /api/threads", () => {
		it("creates a new thread with the configured operatorUserId", async () => {
			const request = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const response = await app.fetch(request);

			expect(response.status).toBe(201);
			const thread = await response.json();
			expect(thread.id).toBeDefined();
			expect(thread.interface).toBe("web");
			expect(thread.user_id).toBe("test-operator");
			expect(thread.user_id).not.toBe("default_web_user");
		});

		it("lists only threads belonging to the configured operator", async () => {
			// Create a thread via the API (uses "test-operator" from beforeEach config)
			await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);

			// Manually insert a thread with a different user_id
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted)
				 VALUES ('other-thread', 'someone-else', 'web', 'localhost', 0, '', ?, ?, ?, 0)`,
				[now, now, now],
			);

			// GET should only return threads with the configured operator ID
			const response = await app.fetch(new Request("http://localhost:3000/api/threads"));
			const threads = await response.json();
			expect(threads.length).toBe(1);
			expect(threads[0].user_id).toBe("test-operator");
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

	describe("GET /api/tasks/:id", () => {
		it("returns 404 for non-existent task", async () => {
			const request = new Request("http://localhost:3000/api/tasks/nonexistent-id");
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("Task not found");
		});

		it("returns task by id", async () => {
			const taskId = "task-1";
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[taskId, "cron", "pending", "0 9 * * MON", now, now, 0],
			);

			const request = new Request(`http://localhost:3000/api/tasks/${taskId}`);
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const task = await response.json();
			expect(task.id).toBe(taskId);
			expect(task.type).toBe("cron");
			expect(task.status).toBe("pending");
		});

		it("returns 404 for deleted task", async () => {
			const taskId = "task-deleted";
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[taskId, "cron", "pending", "0 9 * * MON", now, now, 1],
			);

			const request = new Request(`http://localhost:3000/api/tasks/${taskId}`);
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("Task not found");
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

		it("returns files without content field", async () => {
			// Upload a text file first
			const form = new FormData();
			form.append("file", new File(["test content"], "test.txt", { type: "text/plain" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			expect(uploadRes.status).toBe(201);

			// Get list of files
			const request = new Request("http://localhost:3000/api/files");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const files = await response.json();
			expect(Array.isArray(files)).toBe(true);
			expect(files.length).toBe(1);
			// Verify content field is absent
			expect("content" in files[0]).toBe(false);
			// Verify other fields are present
			expect(files[0].id).toBeDefined();
			expect(files[0].path).toBeDefined();
			expect(files[0].is_binary).toBeDefined();
			expect(files[0].size_bytes).toBeDefined();
		});
	});

	describe("GET /api/files/download?path=", () => {
		it("returns 400 when path query param is missing", async () => {
			const request = new Request("http://localhost:3000/api/files/download");
			const response = await app.fetch(request);

			expect(response.status).toBe(400);
			const error = await response.json();
			expect(error.error).toBe("Missing required query parameter: path");
		});

		it("returns 404 for unknown file path", async () => {
			const request = new Request(
				"http://localhost:3000/api/files/download?path=/nonexistent/file.txt",
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("File not found");
		});

		it("returns 404 for deleted file", async () => {
			// Upload a text file
			const form = new FormData();
			form.append("file", new File(["content"], "test.txt", { type: "text/plain" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const file = await uploadRes.json();

			// Mark as deleted
			db.exec("UPDATE files SET deleted = 1 WHERE id = ?", [file.id]);

			const request = new Request(
				`http://localhost:3000/api/files/download?path=${encodeURIComponent(file.path)}`,
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
		});

		it("returns 404 when content is null", async () => {
			// Insert a file with null content directly
			const fileId = "test-null-content";
			const filePath = "/test-null.txt";
			db.exec(
				"INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					fileId,
					filePath,
					null,
					0,
					0,
					new Date().toISOString(),
					new Date().toISOString(),
					0,
					"test",
					"localhost",
				],
			);

			const request = new Request(
				`http://localhost:3000/api/files/download?path=${encodeURIComponent(filePath)}`,
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
			const error = await response.json();
			expect(error.error).toBe("File content not available");
		});

		it("returns text file with correct Content-Type and Content-Disposition", async () => {
			// Upload a text file
			const textContent = "Hello, this is a test file!";
			const form = new FormData();
			form.append("file", new File([textContent], "document.txt", { type: "text/plain" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const file = await uploadRes.json();

			const request = new Request(
				`http://localhost:3000/api/files/download?path=${encodeURIComponent(file.path)}`,
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(response.headers.get("Content-Disposition")).toContain("attachment");
			expect(response.headers.get("Content-Disposition")).toContain("document.txt");

			const responseText = await response.text();
			expect(responseText).toBe(textContent);
		});

		it("decodes base64 and returns binary file with correct headers", async () => {
			// Upload a binary file (PNG magic bytes)
			const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const form = new FormData();
			form.append("file", new File([pngBytes], "image.png", { type: "image/png" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const file = await uploadRes.json();

			const request = new Request(
				`http://localhost:3000/api/files/download?path=${encodeURIComponent(file.path)}`,
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("image/png");
			expect(response.headers.get("Content-Disposition")).toContain("attachment");
			expect(response.headers.get("Content-Disposition")).toContain("image.png");

			const arrayBuffer = await response.arrayBuffer();
			const returnedBytes = new Uint8Array(arrayBuffer);
			expect(returnedBytes).toEqual(pngBytes);
		});

		it("returns default MIME type for unknown extension", async () => {
			// Upload file with unknown extension
			const content = "some content";
			const form = new FormData();
			form.append("file", new File([content], "file.xyz123", { type: "application/octet-stream" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const file = await uploadRes.json();

			const request = new Request(
				`http://localhost:3000/api/files/download?path=${encodeURIComponent(file.path)}`,
			);
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
		});
	});

	describe("POST /api/threads/:id/messages", () => {
		it("returns 404 with deprecation message", async () => {
			// Create a thread first
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			// POST to messages endpoint should now return 404
			const messageRequest = new Request(
				`http://localhost:3000/api/threads/${thread.id}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "test" }),
				},
			);
			const response = await app.fetch(messageRequest);

			expect(response.status).toBe(404);
			const body = await response.json();
			expect(body.error).toContain("WebSocket message:send");
		});
	});

	describe("GET /api/threads/:id/messages", () => {
		it("returns messages for a thread", async () => {
			// Create a thread
			const createThreadRequest = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const threadResponse = await app.fetch(createThreadRequest);
			const thread = await threadResponse.json();

			// Insert a message directly (since POST is deprecated)
			const now = new Date().toISOString();
			db.exec(
				`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), thread.id, "user", "Test message", now, now, "localhost", 0],
			);

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

	describe("POST /api/files/upload", () => {
		it("stores a text file with correct is_binary=0 and real size_bytes", async () => {
			const content = "hello world";
			const form = new FormData();
			form.append("file", new File([content], "hello.txt", { type: "text/plain" }));

			const response = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);

			expect(response.status).toBe(201);
			const file = await response.json();
			expect(file.is_binary).toBe(0);
			expect(file.size_bytes).toBe(new TextEncoder().encode(content).byteLength);
			expect(file.content).toBe(content);
		});

		it("stores a binary file with is_binary=1 and base64 content", async () => {
			// PNG magic bytes
			const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const form = new FormData();
			form.append("file", new File([pngBytes], "img.png", { type: "image/png" }));

			const response = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);

			expect(response.status).toBe(201);
			const file = await response.json();
			expect(file.is_binary).toBe(1);
			expect(file.size_bytes).toBe(pngBytes.byteLength);
			// Content stored as base64
			expect(file.content).toBe(Buffer.from(pngBytes).toString("base64"));
		});

		it("creates a change_log entry (uses insertRow not raw db.run)", async () => {
			const form = new FormData();
			form.append("file", new File(["data"], "test.txt", { type: "text/plain" }));
			await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);

			const entry = db
				.prepare("SELECT COUNT(*) as c FROM change_log WHERE table_name = 'files'")
				.get() as { c: number };
			expect(entry.c).toBeGreaterThan(0);
		});
	});
});
