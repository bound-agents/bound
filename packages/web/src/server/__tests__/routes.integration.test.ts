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

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
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

	describe("GET /api/files/download/:id", () => {
		it("returns 404 for unknown file id", async () => {
			const request = new Request("http://localhost:3000/api/files/download/unknown-id");
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
			const fileId = file.id;

			// Mark as deleted
			db.exec("UPDATE files SET deleted = 1 WHERE id = ?", [fileId]);

			const request = new Request(`http://localhost:3000/api/files/download/${fileId}`);
			const response = await app.fetch(request);

			expect(response.status).toBe(404);
		});

		it("returns 404 when content is null", async () => {
			// Insert a file with null content directly
			const fileId = "test-null-content";
			db.exec(
				"INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					fileId,
					"/test.txt",
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

			const request = new Request(`http://localhost:3000/api/files/download/${fileId}`);
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

			const request = new Request(`http://localhost:3000/api/files/download/${file.id}`);
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

			const request = new Request(`http://localhost:3000/api/files/download/${file.id}`);
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

			const request = new Request(`http://localhost:3000/api/files/download/${file.id}`);
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
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

	describe("POST /api/threads/:id/messages with file_ids", () => {
		async function createThread(): Promise<string> {
			const res = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);
			const t = await res.json();
			return t.id;
		}

		it("inlines text file content into message when file_ids provided", async () => {
			const threadId = await createThread();
			// Upload a text file first
			const form = new FormData();
			form.append("file", new File(["Hello from file!"], "note.txt", { type: "text/plain" }));
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const uploaded = await uploadRes.json();

			// Send message with file_id
			const msgRes = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "check this", file_ids: [uploaded.id] }),
				}),
			);

			expect(msgRes.status).toBe(201);
			const msg = await msgRes.json();
			// File content must be appended to the message
			expect(msg.content).toContain("check this");
			expect(msg.content).toContain("Hello from file!");
			expect(msg.content).toContain("note.txt");
		});

		it("appends binary file metadata (not raw content) when file is binary", async () => {
			const threadId = await createThread();
			const form = new FormData();
			form.append(
				"file",
				new File([new Uint8Array([137, 80, 78, 71])], "img.png", { type: "image/png" }),
			);
			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const uploaded = await uploadRes.json();

			const msgRes = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "see image", file_ids: [uploaded.id] }),
				}),
			);

			const msg = await msgRes.json();
			expect(msg.content).toContain("see image");
			expect(msg.content).toContain("img.png");
			// Must NOT dump raw base64 into the message
			expect(msg.content).not.toContain(Buffer.from([137, 80, 78, 71]).toString("base64"));
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
