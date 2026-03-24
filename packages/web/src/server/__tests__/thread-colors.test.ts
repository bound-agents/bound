import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";

describe("R-U18: Thread colors cycle sequentially 0-9", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus);
	});

	it("first thread gets color 0", async () => {
		const request = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response = await app.fetch(request);

		expect(response.status).toBe(201);
		const thread = await response.json();
		expect(thread.color).toBe(0);
	});

	it("thread colors cycle sequentially 0-9", async () => {
		const threads = [];

		// Create 12 threads to see the full cycle (0-9) and wrap around
		for (let i = 0; i < 12; i++) {
			const request = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const response = await app.fetch(request);
			expect(response.status).toBe(201);
			const thread = await response.json();
			threads.push(thread);

			// Add small delay to ensure created_at timestamps differ
			await new Promise(resolve => setTimeout(resolve, 5));
		}

		// Verify colors cycle: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1
		expect(threads[0].color).toBe(0);
		expect(threads[1].color).toBe(1);
		expect(threads[2].color).toBe(2);
		expect(threads[3].color).toBe(3);
		expect(threads[4].color).toBe(4);
		expect(threads[5].color).toBe(5);
		expect(threads[6].color).toBe(6);
		expect(threads[7].color).toBe(7);
		expect(threads[8].color).toBe(8);
		expect(threads[9].color).toBe(9);
		expect(threads[10].color).toBe(0); // Wraps around
		expect(threads[11].color).toBe(1);
	});

	it("color assignment continues from most recent thread", async () => {
		// Create 3 threads
		for (let i = 0; i < 3; i++) {
			const request = new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			await app.fetch(request);
			await new Promise(resolve => setTimeout(resolve, 5));
		}

		// Last thread should have color 2 (0, 1, 2)
		// Next thread should be 3
		const request = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response = await app.fetch(request);
		const thread = await response.json();
		expect(thread.color).toBe(3);
	});

	it("deleted threads do not affect color sequence", async () => {
		// Create 2 threads (colors 0, 1)
		const request1 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		await app.fetch(request1);
		await new Promise(resolve => setTimeout(resolve, 5));

		const request2 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response2 = await app.fetch(request2);
		const thread2 = await response2.json();
		await new Promise(resolve => setTimeout(resolve, 5));

		// Soft delete the second thread
		db.run("UPDATE threads SET deleted = 1 WHERE id = ?", [thread2.id]);

		// Create a new thread - should still be color 2 (continues from last created_at)
		const request3 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response3 = await app.fetch(request3);
		const thread3 = await response3.json();
		expect(thread3.color).toBe(2);
	});
});
