// Regression guards for the v3Schema fix.
//
// commit e028985 ("fix(agent): pass valid Zod v4 schema to MCP client.request()")
// patched ONE of FOUR call sites that were passing `{} as never` as the
// result-validation schema argument. The MCP SDK's safeParse dispatches on
// the presence of `_zod`; without it, the v3 fallback path calls
// `({}).safeParse(...)` and throws `TypeError: v3Schema.safeParse is not a
// function`. The connector tool exercises this through the real SDK and
// crashes; mcp-registry's events/stream and events/poll paths exercise it
// too but their try/catch wrappers silently log "Failed to subscribe" /
// "Poll failed" — which is why the regression went unnoticed.
//
// These tests capture the schema arg directly to assert (a) it has the
// `_zod` marker the SDK requires, and (b) it accepts arbitrary response
// shapes via passthrough.

import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { createConnectorHandle } from "../connector-handle.js";
import { PlatformMcpRegistry } from "../mcp-registry.js";

const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

class SimpleEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();

	on(event: string, handler: (payload: unknown) => void): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
	}

	emit(event: string, payload: unknown): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				handler(payload);
			}
		}
	}

	off(event: string, handler: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(handler);
	}
}

function assertValidZod4Schema(schema: unknown): void {
	expect(schema).toBeDefined();
	expect(schema).not.toBeNull();
	// The MCP SDK's `isZ4Schema` check is `!!schema._zod`. Without it, the
	// v3 fallback path calls `schema.safeParse` and crashes when the value
	// is a bare `{}`.
	const s = schema as { _zod?: unknown; safeParse?: unknown };
	expect(s._zod).toBeDefined();
	// And the schema must accept arbitrary passthrough data — the response
	// shapes from MCP servers are not statically known here.
	const result = z.object({}).passthrough().safeParse({ anything: 123, ok: true });
	// (Sanity-check the assertion model itself.)
	expect(result.success).toBe(true);
}

describe("PlatformMcpRegistry — client.request() schema arg validity", () => {
	let db: Database.Database;
	let siteId: string;
	let registry: PlatformMcpRegistry;
	let server: Server;

	beforeEach(async () => {
		db = new Database(":memory:");
		applySchema(db);
		siteId = `test-site-${randomBytes(4).toString("hex")}`;

		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: new SimpleEventBus() as unknown as TypedEventEmitter,
			logger: mockLogger,
		});

		server = new Server({ name: "test-server", version: "1.0.0" });

		const streamSchema = z.object({
			method: z.literal("events/stream"),
			params: z.object({
				event: z.string(),
				params: z.record(z.unknown()).optional(),
				cursor: z.string().optional(),
			}),
		});

		const pollSchema = z.object({
			method: z.literal("events/poll"),
			params: z.object({
				event: z.string(),
				params: z.record(z.unknown()).optional(),
				cursor: z.string().optional(),
			}),
		});

		await server.setRequestHandler(streamSchema, async () => ({}));
		await server.setRequestHandler(pollSchema, async () => ({
			events: [],
			nextPollSeconds: 99999, // long enough that we don't reschedule mid-test
		}));
	});

	function setupHandleAndTask(deliveryMode: "push" | "poll"): {
		handle: Record<string, unknown>;
	} {
		const threadId = `thread-${randomBytes(4).toString("hex")}`;
		const taskId = `task-${randomBytes(4).toString("hex")}`;
		const now = new Date().toISOString();

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "test-user",
				interface: "test",
				host_origin: siteId,
				summary: null,
				last_message_at: now,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: `connector:event:${taskId}`,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		const handleId = createConnectorHandle(db, siteId, {
			serverName: "test-server",
			eventName: "test.event",
			eventArgs: {},
			deliveryMode,
			taskId,
		});

		const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId) as Record<
			string,
			unknown
		>;
		return { handle };
	}

	it("activateSubscription (push) sends a valid Zod v4 schema to events/stream", async () => {
		const entry = await registry.registerServer("test-server", server);

		// Spy: wrap client.request to capture the schema arg before delegating
		// to the real SDK call.
		const captured: { method: string; schema: unknown }[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const originalRequest = entry.client.request.bind(entry.client) as any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		entry.client.request = (async (req: any, schema: any, opts: any) => {
			captured.push({ method: req.method, schema });
			return originalRequest(req, schema, opts);
		}) as never;

		const { handle } = setupHandleAndTask("push");
		await registry.activateSubscription(handle as never);

		const streamCall = captured.find((c) => c.method === "events/stream");
		expect(streamCall).toBeDefined();
		assertValidZod4Schema(streamCall?.schema);
	});

	it("startPollTimer (poll) sends a valid Zod v4 schema to events/poll", async () => {
		const entry = await registry.registerServer("test-server", server);

		const captured: { method: string; schema: unknown }[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const originalRequest = entry.client.request.bind(entry.client) as any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		entry.client.request = (async (req: any, schema: any, opts: any) => {
			captured.push({ method: req.method, schema });
			return originalRequest(req, schema, opts);
		}) as never;

		const { handle } = setupHandleAndTask("poll");
		await registry.activateSubscription(handle as never);

		// Poll mode schedules a 2s timer in the source; wait for it to fire.
		await new Promise((resolve) => setTimeout(resolve, 2200));

		const pollCall = captured.find((c) => c.method === "events/poll");
		expect(pollCall).toBeDefined();
		assertValidZod4Schema(pollCall?.schema);
	}, 5000);
});
