import Database from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { connectorHandleId } from "../connector-handle-id.js";
import { createConnectorHandle } from "../connector-handle.js";
import { createConnectorTool } from "../connector-tool.js";
import { PlatformMcpRegistry } from "../mcp-registry.js";

// Simple mock logger
const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

// Simple event bus for testing
class SimpleEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();

	on<K extends string>(event: K, handler: (payload: unknown) => void): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
	}

	emit<K extends string>(event: K, payload: unknown): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				handler(payload);
			}
		}
	}

	off<K extends string>(event: K, handler: (payload: unknown) => void): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
		}
	}
}

describe("Connector Tool", () => {
	let db: Database.Database;
	let siteId: string;
	let eventBus: SimpleEventBus;
	let registry: PlatformMcpRegistry;
	let server: Server;

	beforeEach(async () => {
		// Setup database
		const dbPath = ":memory:";
		db = new Database(dbPath);
		applySchema(db);

		siteId = `test-site-${randomBytes(4).toString("hex")}`;

		eventBus = new SimpleEventBus();

		// Create registry
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: eventBus as unknown as TypedEventEmitter,
			logger: mockLogger,
		});

		// Create minimal MCP server that can emit events
		server = new Server({
			name: "test-platform",
			version: "1.0.0",
		});

		// Define request schemas
		const listRequestSchema = z.object({
			method: z.literal("events/list"),
		});

		const streamRequestSchema = z.object({
			method: z.literal("events/stream"),
		});

		const pollRequestSchema = z.object({
			method: z.literal("events/poll"),
		});

		// Add request handlers
		await server.setRequestHandler(listRequestSchema, async () => ({
			events: [
				{
					name: "message.received",
					description: "Message received in channel",
					inputSchema: {
						type: "object",
						properties: {
							channel_id: { type: "string", description: "Channel ID" },
						},
					},
				},
				{
					name: "user.joined",
					description: "User joined server",
					inputSchema: {
						type: "object",
						properties: {
							server_id: { type: "string", description: "Server ID" },
						},
					},
				},
			],
		}));

		await server.setRequestHandler(streamRequestSchema, async () => ({}));

		await server.setRequestHandler(pollRequestSchema, async () => ({
			events: [],
			nextPollSeconds: 2,
		}));
	});

	describe("AC2.1: list action returns all connected servers", () => {
		it("lists local platform servers and remote from hosts.platforms", async () => {
			// Setup: Register server locally
			await registry.registerServer("test-platform", server);

			// Setup: Add a remote platform to hosts table
			insertRow(
				db,
				"hosts",
				{
					site_id: "remote-host-site",
					host_name: "remote.example.com",
					version: null,
					sync_url: null,
					mcp_servers: null,
					mcp_tools: null,
					models: null,
					overlay_root: null,
					online_at: null,
					modified_at: new Date().toISOString(),
					platforms: JSON.stringify(["remote-platform"]),
					deleted: 0,
				},
				"remote-host-site",
			);

			// Create tool and execute list action
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "list",
			})) as string;

			expect(result).toContain("test-platform");
			expect(result).toContain("remote-platform");
			expect(result).toContain("Connected platform servers:");
		});
	});

	describe("AC2.2: channels action returns events with bindings list", () => {
		it("lists events and surfaces specific bound handles per event", async () => {
			// Setup: Register server
			const entry = await registry.registerServer("test-platform", server);
			const client = entry.client;

			// Pre-bind two handles on message.received with different args,
			// to verify per-arg-set bindings are surfaced (not just a boolean).
			const argsA = { channel_id: "pre-bound-123" };
			const argsB = { channel_id: "pre-bound-456" };
			const handleIdA = createConnectorHandle(db, siteId, {
				serverName: "test-platform",
				eventName: "message.received",
				eventArgs: argsA,
				deliveryMode: "push",
				taskId: "task-A",
			});
			const handleIdB = createConnectorHandle(db, siteId, {
				serverName: "test-platform",
				eventName: "message.received",
				eventArgs: argsB,
				deliveryMode: "poll",
				taskId: "task-B",
			});

			// Mock client.request
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const originalRequest = client.request as any;
			client.request = async function (request: any) {
				if (request.method === "events/list") {
					return {
						events: [
							{
								name: "message.received",
								description: "Message received in channel",
								inputSchema: {
									type: "object",
									properties: {
										channel_id: { type: "string", description: "Channel ID" },
									},
								},
							},
							{
								name: "user.joined",
								description: "User joined server",
								inputSchema: {
									type: "object",
									properties: {
										server_id: { type: "string", description: "Server ID" },
									},
								},
							},
						],
					};
				}
				return originalRequest.call(this, request);
			} as never;

			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
				server_name: "test-platform",
			})) as string;

			const parsed = JSON.parse(result);
			expect(parsed.length).toBe(2);

			const msgReceived = parsed.find((e: any) => e.name === "message.received");
			expect(msgReceived).toBeDefined();
			expect(Array.isArray(msgReceived.bindings)).toBe(true);
			expect(msgReceived.bindings.length).toBe(2);

			// The boolean is gone — callers MUST inspect bindings now.
			expect(msgReceived.bound).toBeUndefined();

			const bindingA = msgReceived.bindings.find((b: any) => b.id === handleIdA);
			expect(bindingA).toBeDefined();
			expect(bindingA.event_args).toEqual(argsA);
			expect(bindingA.delivery_mode).toBe("push");
			expect(bindingA.task_id).toBe("task-A");
			expect(typeof bindingA.created_at).toBe("string");

			const bindingB = msgReceived.bindings.find((b: any) => b.id === handleIdB);
			expect(bindingB).toBeDefined();
			expect(bindingB.event_args).toEqual(argsB);
			expect(bindingB.delivery_mode).toBe("poll");
			expect(bindingB.task_id).toBe("task-B");

			const userJoined = parsed.find((e: any) => e.name === "user.joined");
			expect(userJoined).toBeDefined();
			expect(Array.isArray(userJoined.bindings)).toBe(true);
			expect(userJoined.bindings.length).toBe(0);
		});

		it("returns error when server_name not provided", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("server_name");
		});

		// Regression guard for the v3Schema fix. The MCP SDK's safeParse
		// dispatches on `_zod`; passing `{}` as the result schema lands on
		// the v3 fallback path which calls `({}).safeParse(...)` and crashes.
		// Commit e028985 patched the relay-processor call site only — this
		// test exercises events/list through the real SDK transport so we
		// don't have a routing-divergence regression again.
		it("events/list goes through the real SDK without rejecting on the result schema", async () => {
			await registry.registerServer("test-platform", server);

			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
				server_name: "test-platform",
			})) as string;

			// If the schema is invalid, the SDK rejects the request and
			// connector-tool surfaces it as `Error: ...`. With the fix, we
			// get a JSON array of events (annotated with bound flags) back.
			expect(result.startsWith("Error:")).toBe(false);
			const parsed = JSON.parse(result);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed.length).toBeGreaterThan(0);
			expect(parsed[0]).toHaveProperty("name");
		});
	});

	describe("AC2.3: channels fallback to remotePlatformRequest", () => {
		it("uses remotePlatformRequest when server not local", async () => {
			let remoteCalled = false;
			const remotePlatformRequest = async (
				serverName: string,
				method: string,
				_params: Record<string, unknown>,
			) => {
				remoteCalled = true;
				expect(serverName).toBe("remote-platform");
				expect(method).toBe("events/list");
				return {
					events: [
						{
							name: "event.one",
							description: "Event one",
						},
					],
				};
			};

			const toolContext = {
				registry,
				db,
				siteId,
				remotePlatformRequest,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
				server_name: "remote-platform",
			})) as string;

			expect(remoteCalled).toBe(true);
			const parsed = JSON.parse(result);
			expect(parsed.length).toBe(1);
			expect(parsed[0].name).toBe("event.one");
			expect(Array.isArray(parsed[0].bindings)).toBe(true);
			expect(parsed[0].bindings.length).toBe(0);
			expect(parsed[0].bound).toBeUndefined();
		});

		it("returns error when server not local and no remotePlatformRequest", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
				// no remotePlatformRequest
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
				server_name: "nonexistent-server",
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("not found");
			expect(result).toContain("no remote relay");
		});
	});

	describe("AC2.4: attach creates handle, task, and thread", () => {
		it("creates all resources with correct linkage", async () => {
			await registry.registerServer("test-platform", server);

			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "attach",
				server_name: "test-platform",
				event_name: "message.received",
				event_args: { channel_id: "ch-123" },
			})) as string;

			expect(result).toContain("Attached:");
			expect(result).toContain("test-platform:message.received");

			// Extract IDs
			const handleMatch = result.match(/handle ([a-f0-9-]+),/);
			const taskMatch = result.match(/task ([a-f0-9-]+),/);
			const threadMatch = result.match(/thread ([a-f0-9-]+) for/);

			expect(handleMatch).not.toBeNull();
			expect(taskMatch).not.toBeNull();
			expect(threadMatch).not.toBeNull();

			const handleId = handleMatch?.[1];
			const taskId = taskMatch?.[1];
			const threadId = threadMatch?.[1];

			// Verify connector handle
			const handleRow = db
				.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
				.get(handleId) as any;

			expect(handleRow).toBeDefined();
			expect(handleRow.server_name).toBe("test-platform");
			expect(handleRow.event_name).toBe("message.received");
			expect(handleRow.task_id).toBe(taskId);

			// Verify task
			const taskRow = db
				.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0")
				.get(taskId) as any;

			expect(taskRow).toBeDefined();
			expect(taskRow.type).toBe("event");
			expect(taskRow.trigger_spec).toContain("connector:event:");
			expect(taskRow.thread_id).toBe(threadId);
			expect(taskRow.no_history).toBe(0);

			// Verify thread
			const threadRow = db
				.query("SELECT * FROM threads WHERE id = ? AND deleted = 0")
				.get(threadId) as any;

			expect(threadRow).toBeDefined();
			expect(threadRow.interface).toBe("platform");
		});

		it("returns error when parameters missing", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);

			// Missing server_name
			let result = (await tool.execute?.({
				action: "attach",
				event_name: "msg.received",
				event_args: { channel_id: "ch-123" },
			})) as string;
			expect(result).toContain("Error:");
			expect(result).toContain("server_name");

			// Missing event_name
			result = (await tool.execute?.({
				action: "attach",
				server_name: "test-platform",
				event_args: { channel_id: "ch-123" },
			})) as string;
			expect(result).toContain("Error:");
			expect(result).toContain("event_name");

			// Missing event_args
			result = (await tool.execute?.({
				action: "attach",
				server_name: "test-platform",
				event_name: "message.received",
			})) as string;
			expect(result).toContain("Error:");
			expect(result).toContain("event_args");
		});
	});

	describe("AC2.5: attach activates subscription when local leader", () => {
		it("calls activateSubscription when local client exists", async () => {
			await registry.registerServer("test-platform", server);

			// Track if activateSubscription is called
			let activateSubscriptionCalled = false;
			const originalActivate = registry.activateSubscription;
			registry.activateSubscription = mock(async (handle: any) => {
				activateSubscriptionCalled = true;
				return originalActivate.call(registry, handle);
			});

			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "attach",
				server_name: "test-platform",
				event_name: "message.received",
				event_args: { channel_id: "ch-456" },
			})) as string;

			expect(result).toContain("Attached:");
			expect(activateSubscriptionCalled).toBe(true);
		});
	});

	describe("AC2.6: detach soft-deletes handle and task", () => {
		it("soft-deletes both handle and associated task", async () => {
			// Setup: Create handle and task
			const eventArgsObj = { channel_id: "ch-999" };
			const handleId = connectorHandleId("test-platform", "message.received", eventArgsObj);
			const taskId = "task-123";

			createConnectorHandle(db, siteId, {
				serverName: "test-platform",
				eventName: "message.received",
				eventArgs: eventArgsObj,
				deliveryMode: "push",
				taskId,
			});

			// Create associated task
			const now = new Date().toISOString();
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${handleId}`,
					payload: JSON.stringify({}),
					created_at: now,
					created_by: "system",
					thread_id: "thread-123",
					origin_thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: null,
					last_run_at: null,
					run_count: 0,
					max_runs: null,
					requires: null,
					model_hint: null,
					no_history: 0,
					inject_mode: "results",
					depends_on: null,
					require_success: 0,
					alert_threshold: 5,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Verify both exist before detach
			let handleRow = db
				.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
				.get(handleId) as any;
			expect(handleRow).toBeDefined();

			let taskRow = db.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(taskId) as any;
			expect(taskRow).toBeDefined();

			// Execute detach
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "detach",
				handle_id: handleId,
			})) as string;

			expect(result).toContain("Detached:");

			// Verify both are soft-deleted
			handleRow = db
				.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
				.get(handleId) as any;
			expect(handleRow).toBeNull();

			taskRow = db.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(taskId) as any;
			expect(taskRow).toBeNull();
		});
	});

	describe("AC2.7: attach idempotency check", () => {
		it("returns error when handle already exists", async () => {
			await registry.registerServer("test-platform", server);

			// Pre-create a handle
			const eventArgsObj = { channel_id: "ch-existing" };
			createConnectorHandle(db, siteId, {
				serverName: "test-platform",
				eventName: "message.received",
				eventArgs: eventArgsObj,
				deliveryMode: "push",
				taskId: "task-existing",
			});

			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "attach",
				server_name: "test-platform",
				event_name: "message.received",
				event_args: eventArgsObj,
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("already exists");
		});
	});

	describe("AC2.8: detach error when handle not found", () => {
		it("returns error when handle_id not found", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "detach",
				handle_id: "nonexistent-handle-id",
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("not found");
		});

		it("returns error when handle_id parameter missing", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "detach",
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("handle_id");
		});
	});

	describe("AC2.9: channels error when server not found and no relay", () => {
		it("returns error for missing server without remotePlatformRequest", async () => {
			const toolContext = {
				registry,
				db,
				siteId,
				// no remotePlatformRequest
			};

			const tool = createConnectorTool(toolContext);
			const result = (await tool.execute?.({
				action: "channels",
				server_name: "missing-server",
			})) as string;

			expect(result).toContain("Error:");
			expect(result).toContain("not found");
		});
	});

	describe("idempotency annotations", () => {
		it("classifies list/channels as read-only", () => {
			const ctx = {
				registry: new PlatformMcpRegistry({
					db,
					siteId,
					hubSiteId: undefined,
					eventBus,
					logger: mockLogger,
				}),
				db,
				siteId,
			};
			const tool = createConnectorTool(ctx);
			expect(tool.resolveAnnotations).toBeDefined();
			expect(tool.resolveAnnotations?.({ action: "list" })).toEqual({
				idempotent: true,
				readOnly: true,
			});
			expect(tool.resolveAnnotations?.({ action: "channels" })).toEqual({
				idempotent: true,
				readOnly: true,
			});
		});

		it("classifies attach/detach as idempotent mutations", () => {
			const ctx = {
				registry: new PlatformMcpRegistry({
					db,
					siteId,
					hubSiteId: undefined,
					eventBus,
					logger: mockLogger,
				}),
				db,
				siteId,
			};
			const tool = createConnectorTool(ctx);
			expect(tool.resolveAnnotations?.({ action: "attach" })).toEqual({
				idempotent: true,
				readOnly: false,
			});
			expect(tool.resolveAnnotations?.({ action: "detach" })).toEqual({
				idempotent: true,
				readOnly: false,
			});
		});
	});
});
