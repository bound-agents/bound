import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createWebApp } from "../index";

describe("R-U18: Thread colors cycle sequentially 0-9", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
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
		const RealDate = Date;
		let now = Date.parse("2026-08-20T03:00:00.000Z");
		globalThis.Date = class extends RealDate {
			constructor(...args: ConstructorParameters<typeof RealDate>) {
				super(...(args.length === 0 ? [now++] : args));
			}

			static now() {
				return now;
			}
		} as DateConstructor;

		try {
			// Create 12 threads to see the full cycle (0-9) and wrap around.
			for (let i = 0; i < 12; i++) {
				const request = new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				});
				const response = await app.fetch(request);
				expect(response.status).toBe(201);
				threads.push(await response.json());
			}
		} finally {
			globalThis.Date = RealDate;
		}

		// Verify colors cycle: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1
		expect(threads.map((thread) => thread.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
	});

	it("color assignment continues from most recent thread", async () => {
		const RealDate = Date;
		let now = Date.parse("2026-08-20T03:00:00.000Z");
		globalThis.Date = class extends RealDate {
			constructor(...args: ConstructorParameters<typeof RealDate>) {
				super(...(args.length === 0 ? [now++] : args));
			}

			static now() {
				return now;
			}
		} as DateConstructor;

		try {
			// Create 3 threads.
			for (let i = 0; i < 3; i++) {
				await app.fetch(
					new Request("http://localhost:3000/api/threads", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({}),
					}),
				);
			}

			const response = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);

			expect((await response.json()).color).toBe(3);
		} finally {
			globalThis.Date = RealDate;
		}
	});

	it("deleted threads do not affect color sequence", async () => {
		// Create 2 threads (colors 0, 1)
		const request1 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		await app.fetch(request1);

		const request2 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response2 = await app.fetch(request2);
		const thread2 = await response2.json();

		// Soft delete the second thread
		db.run("UPDATE threads SET deleted = 1 WHERE id = ?", [thread2.id]);

		// Create a new thread - should be color 1 (skips deleted thread, advances from thread1's color 0)
		const request3 = new Request("http://localhost:3000/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const response3 = await app.fetch(request3);
		const thread3 = await response3.json();
		expect(thread3.color).toBe(1);
	});

	it("assigns colors deterministically with a controlled clock and no elapsed wall time", async () => {
		const RealDate = Date;
		let now = Date.parse("2026-08-20T03:00:00.000Z");
		globalThis.Date = class extends RealDate {
			constructor(...args: ConstructorParameters<typeof RealDate>) {
				super(...(args.length === 0 ? [now++] : args));
			}

			static now() {
				return now;
			}
		} as DateConstructor;

		try {
			for (let i = 0; i < 3; i++) {
				const response = await app.fetch(
					new Request("http://localhost:3000/api/threads", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({}),
					}),
				);
				expect(response.status).toBe(201);
			}

			const response = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);

			expect((await response.json()).color).toBe(3);
		} finally {
			globalThis.Date = RealDate;
		}
	});

	it("color cycle skips system-driven (non-user-facing) threads", async () => {
		const RealDate = Date;
		let nowMs = Date.parse("2026-08-20T03:00:00.000Z");
		globalThis.Date = class extends RealDate {
			constructor(...args: ConstructorParameters<typeof RealDate>) {
				super(...(args.length === 0 ? [nowMs++] : args));
			}

			static now() {
				return nowMs;
			}
		} as DateConstructor;

		try {
			// User-facing thread (web): color 0
			let response = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);
			let thread = await response.json();
			expect(thread.color).toBe(0);

			// boundless thread: color 1
			response = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ interface: "boundless" }),
				}),
			);
			thread = await response.json();
			expect(thread.color).toBe(1);

			// Simulate webhook + scheduler threads landing directly in the DB.
			// Both routes hardcode color: 0; pre-fix this would pin the next
			// user-facing thread back to color 1 by anchoring the cycle to a
			// system row instead of the boundless row.
			const now = "2026-08-20T03:00:00.000Z";
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["webhook-test-id", "system", "webhook", "localhost", 0, now, now, now, 0],
			);
			const now2 = "2026-08-20T03:00:01.000Z";
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["scheduler-test-id", "system", "scheduler", "localhost", 0, now2, now2, now2, 0],
			);
			await new Promise((resolve) => setTimeout(resolve, 5));

			// Next user-facing thread should advance from boundless's color 1 -> 2,
			// NOT cycle off the webhook/scheduler color 0 -> 1.
			response = await app.fetch(
				new Request("http://localhost:3000/api/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ interface: "boundless" }),
				}),
			);
			thread = await response.json();
			expect(thread.color).toBe(2);
		} finally {
			globalThis.Date = RealDate;
		}
	});
});
