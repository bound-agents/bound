import { describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import type { PlatformMcpRegistry } from "../mcp-registry.js";
import { type DiscordClientFactory, setupDiscordServers } from "../setup-platform-servers.js";

// Branches gateway-session-recovery.test.ts leaves cold: the non-discord early
// return, the top-level setup error-catch, the lifecycle event-logging handlers
// (ready/error/warn/shard*/invalidated), and the destroy()-during-recovery
// failure path.

function makeCapturingLogger() {
	const lines: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
	const logger: Logger = {
		debug: (msg, ctx) => lines.push({ level: "debug", msg, ctx }),
		info: (msg, ctx) => lines.push({ level: "info", msg, ctx }),
		warn: (msg, ctx) => lines.push({ level: "warn", msg, ctx }),
		error: (msg, ctx) => lines.push({ level: "error", msg, ctx }),
		isLevelEnabled: () => true,
	} as unknown as Logger;
	return { logger, lines };
}

function makeMockRegistry(registered: string[]): PlatformMcpRegistry {
	return {
		registerServer: async (name: string) => {
			registered.push(name);
		},
	} as unknown as PlatformMcpRegistry;
}

// A client that records every wired handler so the test can fire lifecycle
// events and assert the structured log lines.
interface EventClient {
	on: (event: string, handler: (...args: unknown[]) => void) => EventClient;
	once: (event: string, handler: (...args: unknown[]) => void) => EventClient;
	emit: (event: string, ...args: unknown[]) => void;
	login: (token: string) => Promise<unknown>;
	user: { tag: string; id: string } | null;
	handlers: Map<string, Array<(...args: unknown[]) => void>>;
}

function makeEventClient(opts: { loginThrows?: boolean } = {}): EventClient {
	const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
	const client: EventClient = {
		handlers,
		user: { tag: "bound#0001", id: "1234" },
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return client;
		},
		once(event, handler) {
			return client.on(event, handler);
		},
		emit(event, ...args) {
			for (const h of handlers.get(event) ?? []) h(...args);
		},
		login: async () => {
			if (opts.loginThrows) throw new Error("invalid token");
			return undefined;
		},
	};
	// No isReady() — keeps the recovery watchdog unwired so these tests don't
	// race a background timer.
	return client;
}

const fastRecovery = {
	initialDelayMs: 1,
	maxAttempts: 2,
	watchdogIntervalMs: 60_000,
	notReadyThresholdMs: 60_000,
};

function discordConfig(): PlatformConnectorConfig {
	return {
		platform: "discord",
		token: "test-token",
		allowed_users: [],
	} as unknown as PlatformConnectorConfig;
}

describe("setupDiscordServers — non-discord platforms", () => {
	it("returns immediately without constructing a client for a non-discord platform", async () => {
		const registered: string[] = [];
		let factoryCalled = false;
		const factory: DiscordClientFactory = async () => {
			factoryCalled = true;
			return makeEventClient();
		};
		const config = { platform: "slack", allowed_users: [] } as unknown as PlatformConnectorConfig;

		await setupDiscordServers(
			config,
			makeMockRegistry(registered),
			makeCapturingLogger().logger,
			undefined,
			factory,
			fastRecovery,
		);

		expect(factoryCalled).toBe(false);
		expect(registered).toEqual([]);
	});
});

describe("setupDiscordServers — setup failure", () => {
	it("logs and rethrows when login() fails, before any registration", async () => {
		const registered: string[] = [];
		const { logger, lines } = makeCapturingLogger();
		const factory: DiscordClientFactory = async () => makeEventClient({ loginThrows: true });

		await expect(
			setupDiscordServers(
				discordConfig(),
				makeMockRegistry(registered),
				logger,
				undefined,
				factory,
				fastRecovery,
			),
		).rejects.toThrow("invalid token");

		// Login fails fast before registerServer — no tool exposed at a half-init client.
		expect(registered).toEqual([]);
		expect(
			lines.some((l) => l.level === "error" && l.msg.includes("Failed to setup Discord server")),
		).toBe(true);
	});
});

describe("wireGatewayLifecycleLogging — event handlers", () => {
	it("logs each gateway lifecycle event through the structured logger", async () => {
		const registered: string[] = [];
		const { logger, lines } = makeCapturingLogger();
		const client = makeEventClient();
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			discordConfig(),
			makeMockRegistry(registered),
			logger,
			undefined,
			factory,
			fastRecovery,
		);
		expect(registered).toEqual(["discord"]);

		client.emit("ready");
		client.emit("error", new Error("gw error"));
		client.emit("warn", "gw warning");
		client.emit("shardDisconnect", { code: 1006 }, 0);
		client.emit("shardReconnecting", 0);
		client.emit("shardResume", 0, 42);

		const msgs = lines.map((l) => l.msg);
		expect(msgs).toContain("[discord] Gateway ready");
		expect(msgs).toContain("[discord] Gateway error");
		expect(msgs).toContain("[discord] Gateway warning");
		expect(msgs).toContain("[discord] Shard disconnected");
		expect(msgs).toContain("[discord] Shard reconnecting");
		expect(msgs).toContain("[discord] Shard resumed");

		// ready logs the resolved user tag/id.
		const ready = lines.find((l) => l.msg === "[discord] Gateway ready");
		expect(ready?.ctx).toMatchObject({ username: "bound#0001", userId: "1234" });
	});

	it("falls back to 'unknown' when client.user is absent on ready", async () => {
		const registered: string[] = [];
		const { logger, lines } = makeCapturingLogger();
		const client = makeEventClient();
		client.user = null;
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			discordConfig(),
			makeMockRegistry(registered),
			logger,
			undefined,
			factory,
			fastRecovery,
		);

		client.emit("ready");
		const ready = lines.find((l) => l.msg === "[discord] Gateway ready");
		expect(ready?.ctx).toMatchObject({ username: "unknown", userId: "unknown" });
	});
});

describe("wireGatewaySessionRecovery — destroy() failure during recovery", () => {
	it("logs and continues recovery when destroy() rejects", async () => {
		const registered: string[] = [];
		const { logger, lines } = makeCapturingLogger();

		// Client with a destroy() that always rejects and a login() that succeeds
		// on the recovery attempt; recovery must log the destroy failure and
		// proceed to a successful re-login.
		const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
		let loginCalls = 0;
		let destroyCalls = 0;
		const client = {
			handlers,
			user: { tag: "t", id: "i" },
			on(event: string, handler: (...args: unknown[]) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return client;
			},
			once(event: string, handler: (...args: unknown[]) => void) {
				return client.on(event, handler);
			},
			emit(event: string, ...args: unknown[]) {
				for (const h of handlers.get(event) ?? []) h(...args);
			},
			login: async () => {
				loginCalls++;
				return undefined;
			},
			destroy: async () => {
				destroyCalls++;
				throw new Error("destroy boom");
			},
		};
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			discordConfig(),
			makeMockRegistry(registered),
			logger,
			undefined,
			factory,
			fastRecovery,
		);
		expect(loginCalls).toBe(1); // initial login

		client.emit("invalidated");
		// Recovery: destroy() rejects (logged), sleep, login() succeeds.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(destroyCalls).toBeGreaterThanOrEqual(1);
		expect(loginCalls).toBeGreaterThanOrEqual(2);
		expect(lines.some((l) => l.msg.includes("destroy() failed during recovery"))).toBe(true);
		expect(lines.some((l) => l.msg.includes("Gateway session recovered"))).toBe(true);
	});
});
