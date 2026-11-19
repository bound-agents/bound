import { describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import type { PlatformMcpRegistry } from "../mcp-registry.js";
import { type DiscordClientFactory, setupDiscordServers } from "../setup-platform-servers.js";

/**
 * Tests for wireGatewayLifecycleLogging — the structured-logging handlers wired
 * to discord.js gateway events before login(). These are observability only
 * (every handler is a log line), but they are real behavior: the incident that
 * motivated gateway session recovery (2026-07-24 → 2026-08-14) turned on a
 * client going dark with no visible signal, so each lifecycle event must reach
 * the logger at the right level with the right fields.
 *
 * The handlers are registered inside setupDiscordServers via an injected client
 * factory, so a capturing fake client lets us emit each event and assert the
 * resulting log call without touching the discord.js dynamic import.
 */

interface LogCall {
	level: "debug" | "info" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; calls: LogCall[] } {
	const calls: LogCall[] = [];
	const record = (level: LogCall["level"]) => (msg: string, meta?: Record<string, unknown>) => {
		calls.push({ level, msg, meta });
	};
	return {
		calls,
		logger: {
			debug: record("debug"),
			info: record("info"),
			warn: record("warn"),
			error: record("error"),
		},
	};
}

type Handler = (...args: unknown[]) => void;

interface CapturingClient {
	on: (event: string, handler: Handler) => CapturingClient;
	emit: (event: string, ...args: unknown[]) => void;
	login: (token: string) => Promise<unknown>;
	// Deliberately NO isReady: keeps the watchdog branch out of this test so
	// the only timers are none, and the handlers under test are isolated.
	user?: { tag: string; id: string };
}

function makeCapturingClient(): CapturingClient {
	const handlers = new Map<string, Handler[]>();
	const client: CapturingClient = {
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return client;
		},
		emit: (event, ...args) => {
			for (const h of handlers.get(event) ?? []) h(...args);
		},
		login: async () => undefined,
	};
	return client;
}

function makeConfig(): PlatformConnectorConfig {
	return {
		platform: "discord",
		token: "test-token",
		allowed_users: [],
	} as unknown as PlatformConnectorConfig;
}

const noopRegistry = {
	registerServer: async () => {},
} as unknown as PlatformMcpRegistry;

async function wireAndGetClient(logger: Logger): Promise<CapturingClient> {
	const client = makeCapturingClient();
	const factory: DiscordClientFactory = async () => client;
	await setupDiscordServers(makeConfig(), noopRegistry, logger, undefined, factory, {
		// Watchdog effectively off; this client has no isReady() anyway.
		watchdogIntervalMs: 60_000,
		notReadyThresholdMs: 60_000,
	});
	return client;
}

describe("wireGatewayLifecycleLogging", () => {
	it("logs the bot identity at info on the ready event", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);
		client.user = { tag: "Bound#1234", id: "999" };

		client.emit("ready");

		const ready = calls.find((c) => c.msg === "[discord] Gateway ready");
		expect(ready).toBeDefined();
		expect(ready?.level).toBe("info");
		expect(ready?.meta).toEqual({ username: "Bound#1234", userId: "999" });
	});

	it("falls back to 'unknown' identity when client.user is absent on ready", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);
		// client.user left undefined.

		client.emit("ready");

		const ready = calls.find((c) => c.msg === "[discord] Gateway ready");
		expect(ready?.meta).toEqual({ username: "unknown", userId: "unknown" });
	});

	it("logs gateway errors at error level with the stringified error", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("error", new Error("boom"));

		const err = calls.find((c) => c.msg === "[discord] Gateway error");
		expect(err?.level).toBe("error");
		expect(String(err?.meta?.error)).toContain("boom");
	});

	it("logs gateway warnings at warn level with the message", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("warn", "rate limited");

		const warn = calls.find((c) => c.msg === "[discord] Gateway warning");
		expect(warn?.level).toBe("warn");
		expect(warn?.meta).toEqual({ message: "rate limited" });
	});

	it("logs a shard disconnect at warn with shardId and close code", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("shardDisconnect", { code: 4004 }, 2);

		const d = calls.find((c) => c.msg === "[discord] Shard disconnected");
		expect(d?.level).toBe("warn");
		expect(d?.meta).toEqual({ shardId: 2, code: 4004 });
	});

	it("logs a shard reconnecting at info with shardId", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("shardReconnecting", 1);

		const r = calls.find((c) => c.msg === "[discord] Shard reconnecting");
		expect(r?.level).toBe("info");
		expect(r?.meta).toEqual({ shardId: 1 });
	});

	it("logs a shard resume at info with shardId and replayed-event count", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("shardResume", 3, 42);

		const r = calls.find((c) => c.msg === "[discord] Shard resumed");
		expect(r?.level).toBe("info");
		expect(r?.meta).toEqual({ shardId: 3, replayedEvents: 42 });
	});

	it("logs session invalidation at error level", async () => {
		const { logger, calls } = makeCapturingLogger();
		const client = await wireAndGetClient(logger);

		client.emit("invalidated");

		// The lifecycle logger emits an error line; the recovery wiring (also
		// listening on `invalidated`) is a separate concern covered elsewhere.
		const inv = calls.find((c) => c.msg.includes("Session invalidated"));
		expect(inv?.level).toBe("error");
	});
});
