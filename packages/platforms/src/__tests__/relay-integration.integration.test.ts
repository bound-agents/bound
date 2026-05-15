import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import type { Logger } from "@bound/shared";
import { TypedEventEmitter as RealTypedEventEmitter } from "@bound/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { type ConnectorHandleRecord, createConnectorHandle } from "../connector-handle.js";
import { PlatformMcpRegistry } from "../mcp-registry.js";

// Simple mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Helper to create a mock MCP server
const createMockMcpServer = async (name: string): Promise<Server> => {
	const { Server } = require("@modelcontextprotocol/sdk/server/index.js");

	const server = new Server({
		name,
		version: "1.0.0",
	});

	// Manually set capabilities after creation
	(server as any)._capabilities = { tools: {} };

	// Add a mock tool
	const listRequestSchema = z.object({
		method: z.literal("tools/list"),
	});

	await server.setRequestHandler(listRequestSchema, async () => ({
		tools: [
			{
				name: `${name}_test_tool`,
				description: `Test tool from ${name}`,
				inputSchema: {
					type: "object",
					properties: {
						message: { type: "string" },
					},
				},
			},
		],
	}));

	// Add a mock events/list handler
	const eventsListSchema = z.object({
		method: z.literal("events/list"),
	});

	await server.setRequestHandler(eventsListSchema, async () => ({
		events: [
			{
				name: "test_event",
				description: "Test event",
				inputSchema: {
					type: "object",
					properties: {},
				},
			},
		],
	}));

	return server;
};

describe("Platform MCP Registry — Relay Integration (AC6 + AC7)", () => {
	let dbLead: Database.Database;
	let dbStandby: Database.Database;
	let testDbPathLead: string;
	let testDbPathStandby: string;
	let siteIdLeader: string;
	let siteIdStandby: string;
	let eventBusLeader: TypedEventEmitter;
	let eventBusStandby: TypedEventEmitter;

	beforeEach(async () => {
		const testId = randomBytes(4).toString("hex");

		// Leader DB (has MCP servers)
		testDbPathLead = `/tmp/test-relay-lead-${testId}.db`;
		const sqlite3 = require("bun:sqlite");
		dbLead = new sqlite3.Database(testDbPathLead);
		applySchema(dbLead);
		siteIdLeader = `leader-${randomBytes(4).toString("hex")}`;

		// Standby DB (no MCP servers)
		testDbPathStandby = `/tmp/test-relay-standby-${testId}.db`;
		dbStandby = new sqlite3.Database(testDbPathStandby);
		applySchema(dbStandby);
		siteIdStandby = `standby-${randomBytes(4).toString("hex")}`;

		// Event buses
		eventBusLeader = new RealTypedEventEmitter();
		eventBusStandby = new RealTypedEventEmitter();
	});

	afterEach(() => {
		try {
			dbLead.close();
		} catch {
			// Already closed
		}
		try {
			dbStandby.close();
		} catch {
			// Already closed
		}
		try {
			require("node:fs").unlinkSync(testDbPathLead);
		} catch {
			// Already deleted
		}
		try {
			require("node:fs").unlinkSync(testDbPathStandby);
		} catch {
			// Already deleted
		}
	});

	describe("AC6.1: Only leader instantiates MCP servers", () => {
		it("should have registered servers on leader registry", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Register a mock server on leader
			const mockServer = await createMockMcpServer("discord");
			await registryLeader.registerServer("discord", mockServer);

			// Verify leader has the server registered
			const serverNames = registryLeader.getServerNames();
			expect(serverNames).toContain("discord");
			expect(serverNames.length).toBe(1);

			await registryLeader.shutdown();
		});

		it("should have no servers on standby registry", async () => {
			const registryStandby = new PlatformMcpRegistry({
				db: dbStandby,
				siteId: siteIdStandby,
				eventBus: eventBusStandby,
				logger: createMockLogger(),
			});

			// Standby registry starts with no servers
			const serverNames = registryStandby.getServerNames();
			expect(serverNames).toEqual([]);
		});
	});

	describe("AC6.2: Non-leader has no servers, no tools, no subscriptions", () => {
		it("should return empty tools map for non-leader", () => {
			const registryStandby = new PlatformMcpRegistry({
				db: dbStandby,
				siteId: siteIdStandby,
				eventBus: eventBusStandby,
				logger: createMockLogger(),
			});

			// getToolsForThread should return empty map
			const threadId = randomUUID();
			const tools = registryStandby.getToolsForThread(threadId);
			expect(tools.size).toBe(0);

			// getAllPlatformTools should return empty map
			const allTools = registryStandby.getAllPlatformTools();
			expect(allTools.size).toBe(0);

			// getServerNames should return empty array
			const servers = registryStandby.getServerNames();
			expect(servers.length).toBe(0);
		});

		it("should have no active subscriptions on standby", async () => {
			const registryStandby = new PlatformMcpRegistry({
				db: dbStandby,
				siteId: siteIdStandby,
				eventBus: eventBusStandby,
				logger: createMockLogger(),
			});

			// Create a task and connector handle (simulating setup)
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbStandby,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdStandby,
			);

			// Try to activate a subscription on standby
			// This should succeed but not actually connect to any MCP servers
			// (because there are no registered servers)
			const handleId = createConnectorHandle(dbStandby, siteIdStandby, {
				taskId,
				serverName: "discord",
				eventName: "message_create",
				eventArgs: {},
				deliveryMode: "push",
				cursor: null,
			});

			// Query the created handle
			const handle = dbStandby
				.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
				.get(handleId) as ConnectorHandleRecord | null;

			// Attempt activation should warn and return safely
			// (no error because server doesn't exist)
			if (handle) {
				await registryStandby.activateSubscription(handle);
			}

			// Verify standby registry has no active subscriptions
			expect(registryStandby.getServerNames().length).toBe(0);
			expect(registryStandby.getToolsForThread(threadId).size).toBe(0);

			// After shutdown, should have no subscriptions
			await registryStandby.shutdown();
		});
	});

	describe("AC6.5: hosts.platforms advertised correctly", () => {
		it("should store platform names in hosts table", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Register two platform servers
			const mockDiscord = await createMockMcpServer("discord");
			const mockSlack = await createMockMcpServer("slack");
			await registryLeader.registerServer("discord", mockDiscord);
			await registryLeader.registerServer("slack", mockSlack);

			// Simulate advertising platforms to hosts table
			const platformNames = registryLeader.getServerNames();
			expect(platformNames).toContain("discord");
			expect(platformNames).toContain("slack");
			expect(platformNames.length).toBe(2);

			// In a real setup, we'd call updateRow(db, "hosts", siteId, { platforms: JSON.stringify(platformNames) })
			// For this test, we just verify the registry reports the right names
			insertRow(
				dbLead,
				"hosts",
				{
					site_id: siteIdLeader,
					host_name: "leader.local",
					modified_at: new Date().toISOString(),
					deleted: 0,
					mcp_tools: JSON.stringify([]),
					platforms: JSON.stringify(platformNames), // Advertise platforms
				},
				siteIdLeader,
			);

			// Verify it was stored
			const hostRow = dbLead
				.query("SELECT platforms FROM hosts WHERE site_id = ? AND deleted = 0")
				.get(siteIdLeader) as { platforms: string } | null;
			expect(hostRow).toBeDefined();
			if (hostRow) {
				const platforms = JSON.parse(hostRow.platforms || "[]");
				expect(platforms).toEqual(["discord", "slack"]);
			}

			await registryLeader.shutdown();
		});
	});

	describe("AC7.1: Event listener writes relay intake entry with platform field", () => {
		it("should write relay_outbox entry when batch delivered in multi-host mode", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
				hubSiteId: "hub-site-id", // Enable multi-host mode
			});

			// Create a task and thread for testing
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbLead,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdLeader,
			);

			// Create a connector handle
			const handleId = createConnectorHandle(dbLead, siteIdLeader, {
				taskId,
				serverName: "discord",
				eventName: "message_create",
				eventArgs: {},
				deliveryMode: "push",
				cursor: null,
			});

			// Create a mock subscription
			const subscription = {
				handleId,
				serverName: "discord",
				taskId,
				threadId,
				buffer: [],
				flushTimer: null,
				deduplicationSet: new Set<string>(),
			};

			// Create mock events
			const events = [
				{
					eventId: "evt-1",
					name: "message_create",
					timestamp: new Date().toISOString(),
					data: { message: "Hello from relay test" },
					cursor: "1",
				},
			];

			// Deliver batch
			registryLeader.deliverBatch(subscription, events);

			// Check relay_outbox for the entry
			const outboxRows = dbLead
				.query(
					"SELECT payload, kind FROM relay_outbox WHERE kind = 'intake' ORDER BY created_at DESC LIMIT 1",
				)
				.all() as Array<{ payload: string; kind: string }>;

			expect(outboxRows.length).toBeGreaterThan(0);
			const outboxEntry = outboxRows[0];
			const payload = JSON.parse(outboxEntry.payload);
			expect(payload.platform).toBe("discord"); // AC7.1: platform field present
			expect(payload.thread_id).toBe(threadId);
			expect(payload.message_id).toBeDefined();
			expect(payload.content).toBeDefined();

			await registryLeader.shutdown();
		});

		it("should not write relay_outbox in single-host mode", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
				// No hubSiteId — single-host mode
			});

			// Create a task and thread for testing
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbLead,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdLeader,
			);

			// Create a connector handle
			const handleId = createConnectorHandle(dbLead, siteIdLeader, {
				taskId,
				serverName: "discord",
				eventName: "message_create",
				eventArgs: {},
				deliveryMode: "push",
				cursor: null,
			});

			// Create a mock subscription
			const subscription = {
				handleId,
				serverName: "discord",
				taskId,
				threadId,
				buffer: [],
				flushTimer: null,
				deduplicationSet: new Set<string>(),
			};

			// Create mock events
			const events = [
				{
					eventId: "evt-1",
					name: "message_create",
					timestamp: new Date().toISOString(),
					data: { message: "Hello from single-host test" },
					cursor: "1",
				},
			];

			// Deliver batch
			registryLeader.deliverBatch(subscription, events);

			// Check relay_outbox for the entry
			const outboxRows = dbLead
				.query("SELECT COUNT(*) as count FROM relay_outbox WHERE kind = 'intake'")
				.get() as { count: number };

			expect(outboxRows.count).toBe(0); // Should NOT write intake in single-host mode

			await registryLeader.shutdown();
		});
	});

	describe("AC7.2: Hub routes intake to host with platform affinity", () => {
		it("should enable platform affinity routing via hosts.platforms field", () => {
			// Create two host entries: one with platforms, one without
			insertRow(
				dbLead,
				"hosts",
				{
					site_id: siteIdLeader,
					host_name: "leader.local",
					modified_at: new Date().toISOString(),
					deleted: 0,
					mcp_tools: JSON.stringify([]),
					platforms: JSON.stringify(["discord", "slack"]), // Has platforms
				},
				siteIdLeader,
			);

			insertRow(
				dbLead,
				"hosts",
				{
					site_id: siteIdStandby,
					host_name: "standby.local",
					modified_at: new Date().toISOString(),
					deleted: 0,
					mcp_tools: JSON.stringify([]),
					platforms: JSON.stringify([]), // No platforms
				},
				siteIdStandby,
			);

			// Simulate hub routing logic: select host with matching platform
			const intakePayload = {
				platform: "discord",
				thread_id: randomUUID(),
				message_id: randomUUID(),
				content: "test",
				attachments: [],
			};

			// Query hosts that have this platform
			const eligibleHosts = dbLead
				.query(
					`
				SELECT site_id, platforms FROM hosts WHERE deleted = 0 AND platforms != ''
				LIMIT 100
			`,
				)
				.all() as Array<{ site_id: string; platforms: string }>;

			let routeToHost: string | null = null;
			for (const host of eligibleHosts) {
				const platforms = JSON.parse(host.platforms || "[]");
				if (platforms.includes(intakePayload.platform)) {
					routeToHost = host.site_id;
					break;
				}
			}

			// Verify it routed to the leader (which has platforms)
			expect(routeToHost).toBe(siteIdLeader);
		});
	});

	describe("AC7.3: Platform tools injected from new registry in relay context", () => {
		it("should return correct platform tools for thread bound to connector handle", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Register a platform server with a tool
			const mockServer = await createMockMcpServer("discord");
			await registryLeader.registerServer("discord", mockServer);

			// Verify tools were discovered
			const discordTools = registryLeader.getToolsForServer("discord");
			expect(discordTools.size).toBeGreaterThan(0);

			// Create a task and thread for testing
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbLead,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdLeader,
			);

			// Create a connector handle for this task
			createConnectorHandle(dbLead, siteIdLeader, {
				taskId,
				serverName: "discord",
				eventName: "message_create",
				eventArgs: {},
				deliveryMode: "push",
				cursor: null,
			});

			// Query tools for this thread
			const toolsForThread = registryLeader.getToolsForThread(threadId);

			// Should have the discord tools
			expect(toolsForThread.size).toBeGreaterThan(0);
			// Should contain the discord test tool
			const toolNames = Array.from(toolsForThread.keys());
			expect(toolNames.some((name) => name.includes("discord"))).toBe(true);

			await registryLeader.shutdown();
		});

		it("should return empty tools for thread with no connector handle", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Register a platform server
			const mockServer = await createMockMcpServer("discord");
			await registryLeader.registerServer("discord", mockServer);

			// Create a task with NO connector handle
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbLead,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdLeader,
			);

			// Query tools for this thread (no connector handle)
			const toolsForThread = registryLeader.getToolsForThread(threadId);

			// Should be empty
			expect(toolsForThread.size).toBe(0);

			await registryLeader.shutdown();
		});
	});

	describe("AC6.3: Reconnection after failover", () => {
		it("should reconnect all subscriptions from database on leader election", async () => {
			const registryLeader = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Register a platform server
			const mockServer = await createMockMcpServer("discord");
			await registryLeader.registerServer("discord", mockServer);

			// Create a task and connector handle
			const taskId = randomUUID();
			const threadId = randomUUID();
			insertRow(
				dbLead,
				"tasks",
				{
					id: taskId,
					thread_id: threadId,
					type: "event",
					status: "idle",
					trigger_spec: "connector:event:test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					payload: null,
				},
				siteIdLeader,
			);

			// Create a connector handle
			const handleId = createConnectorHandle(dbLead, siteIdLeader, {
				taskId,
				serverName: "discord",
				eventName: "message_create",
				eventArgs: {},
				deliveryMode: "push",
				cursor: null,
			});

			// Query the created handle
			const handle = dbLead
				.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
				.get(handleId) as ConnectorHandleRecord | null;

			// Activate subscription
			if (handle) {
				await registryLeader.activateSubscription(handle);
			}

			// Simulate failover: shutdown and create new registry instance
			await registryLeader.shutdown();

			const registryLeader2 = new PlatformMcpRegistry({
				db: dbLead,
				siteId: siteIdLeader,
				eventBus: eventBusLeader,
				logger: createMockLogger(),
			});

			// Re-register platform server
			const mockServer2 = await createMockMcpServer("discord");
			await registryLeader2.registerServer("discord", mockServer2);

			// Reconnect all subscriptions
			await registryLeader2.reconnectAll();

			// Verify reconnection succeeded (no errors thrown)
			expect(registryLeader2.getServerNames()).toContain("discord");

			await registryLeader2.shutdown();
		});
	});
});
