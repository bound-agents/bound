import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { emit } from "../commands/emit";

describe("platform-connectors Phase 4 — emit command broadcast", () => {
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	let eventBus: TypedEventEmitter;
	let siteId: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-emit-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		siteId = randomUUID();
		eventBus = new TypedEventEmitter();

		ctx = {
			db,
			siteId,
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		};
	});

	afterEach(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("AC4.1: writes event_broadcast relay entry when hub is configured", async () => {
		// Seed cluster_config with a hub entry
		db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
			"cluster_hub",
			"hub-site-id",
			new Date().toISOString(),
		]);

		// Track emitted events
		let emittedEvent: string | null = null;
		const listener = () => {
			emittedEvent = "task:triggered";
		};
		eventBus.on("task:triggered", listener);

		// Call emit handler with a test event
		const result = await emit.handler(
			{
				event: "task:triggered",
				payload: '{"task_id":"t1","trigger":"test"}',
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Assert: local event was emitted
		expect(emittedEvent).toBe("task:triggered");

		// Assert: relay_outbox has exactly one entry with kind = 'event_broadcast'
		const entries = db
			.query("SELECT * FROM relay_outbox WHERE kind = ? AND target_site_id = ?")
			.all("event_broadcast", "*") as Array<{
			id: string;
			kind: string;
			target_site_id: string;
			payload: string;
			source_site_id: string;
		}>;

		expect(entries).toHaveLength(1);

		const entry = entries[0];
		expect(entry.kind).toBe("event_broadcast");
		expect(entry.target_site_id).toBe("*");
		expect(entry.source_site_id).toBe(siteId);

		// Assert: payload contains the event name and original payload
		const payload = JSON.parse(entry.payload);
		expect(payload.event_name).toBe("task:triggered");
		expect(payload.event_payload).toEqual({ task_id: "t1", trigger: "test" });

		eventBus.off("task:triggered", listener);
	});

	it("AC4.2: does NOT write relay entry when hub is not configured", async () => {
		// Ensure cluster_config is empty (no hub entry)
		// cluster_config starts empty after schema

		// Track emitted events
		let emittedEvent: string | null = null;
		const listener = () => {
			emittedEvent = "task:triggered";
		};
		eventBus.on("task:triggered", listener);

		// Call emit handler
		const result = await emit.handler(
			{
				event: "task:triggered",
				payload: '{"task_id":"t2","trigger":"local"}',
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Assert: local event was emitted
		expect(emittedEvent).toBe("task:triggered");

		// Assert: relay_outbox has zero entries with kind = 'event_broadcast'
		const entries = db
			.query("SELECT * FROM relay_outbox WHERE kind = ?")
			.all("event_broadcast") as Array<{
			id: string;
			kind: string;
		}>;

		expect(entries).toHaveLength(0);
	});
});
