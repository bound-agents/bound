import { describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import type { PlatformMcpRegistry } from "../mcp-registry.js";
import { type DiscordClientFactory, setupDiscordServers } from "../setup-platform-servers.js";

/**
 * Tests for gateway session recovery — the self-healing path for a Discord
 * client whose gateway session dies while its host still holds platform
 * leadership.
 *
 * Background (incident, 2026-07-24 → 2026-08-14): the hub's Discord client
 * went dark for three weeks while leader election kept renewing the lease.
 * Lease renewal never consults gateway health, and the only handler for
 * discord.js's terminal `invalidated` event was a log line ("manual restart
 * may be required"). discord.js auto-reconnects through transient
 * `shardDisconnect`s, but an invalidated session is final — the library
 * stops trying, so every slash command surfaced "The application did not
 * respond" and message intake silently stopped.
 *
 * The fix: (1) `invalidated` triggers destroy + re-login with bounded,
 * backing-off attempts; (2) a watchdog notices a client that reports
 * not-ready past a threshold (silent death, no event) and fires the same
 * recovery. Exhausted recovery gives up loudly; the watchdog re-arms it on
 * the next poll cycle, so a long Discord outage retries with pacing instead
 * of hot-looping.
 */

const quietLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeCapturingLogger(): { logger: Logger; errors: string[] } {
	const errors: string[] = [];
	return {
		errors,
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (msg: string) => {
				errors.push(msg);
			},
		},
	};
}

interface RecoverableClient {
	on: (event: string, handler: (...args: unknown[]) => void) => RecoverableClient;
	once: (event: string, handler: (...args: unknown[]) => void) => RecoverableClient;
	emit: (event: string) => void;
	login: (token: string) => Promise<unknown>;
	destroy: () => Promise<void>;
	isReady: () => boolean;
	setReady: (ready: boolean) => void;
	failNextLogins: (n: number) => void;
	counts: { login: number; destroy: number };
}

function makeRecoverableClient(): RecoverableClient {
	const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
	let ready = false;
	let loginFailuresLeft = 0;
	const counts = { login: 0, destroy: 0 };

	const client: RecoverableClient = {
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return client;
		},
		once: (event, handler) => client.on(event, handler),
		emit: (event) => {
			for (const handler of handlers.get(event) ?? []) handler();
		},
		login: async (_token: string) => {
			counts.login++;
			if (loginFailuresLeft > 0) {
				loginFailuresLeft--;
				throw new Error("login failed (injected)");
			}
			ready = true;
			return undefined;
		},
		destroy: async () => {
			counts.destroy++;
			ready = false;
		},
		isReady: () => ready,
		setReady: (value) => {
			ready = value;
		},
		failNextLogins: (n) => {
			loginFailuresLeft = n;
		},
		counts,
	};
	return client;
}

function makeMockRegistry(): PlatformMcpRegistry {
	return {
		registerServer: async () => {},
	} as unknown as PlatformMcpRegistry;
}

function makeConfig(): PlatformConnectorConfig {
	return {
		platform: "discord",
		token: "test-token",
		allowed_users: [],
	} as unknown as PlatformConnectorConfig;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Fast-cycle options so tests complete in milliseconds. Generous waitFor
// timeouts absorb host contention (see pre-commit flake history).
const fastRecovery = {
	initialDelayMs: 1,
	maxAttempts: 3,
	watchdogIntervalMs: 5,
	notReadyThresholdMs: 15,
};

describe("gateway session recovery", () => {
	it("re-logins after the invalidated event (destroy then login)", async () => {
		const client = makeRecoverableClient();
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			makeConfig(),
			makeMockRegistry(),
			quietLogger,
			undefined,
			factory,
			fastRecovery,
		);
		expect(client.counts.login).toBe(1);

		client.emit("invalidated");
		await waitFor(() => client.counts.login === 2);
		expect(client.counts.destroy).toBe(1);
		expect(client.isReady()).toBe(true);
	});

	it("retries with bounded attempts until re-login succeeds", async () => {
		const client = makeRecoverableClient();
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			makeConfig(),
			makeMockRegistry(),
			quietLogger,
			undefined,
			factory,
			fastRecovery,
		);

		// First two recovery attempts fail, third succeeds (maxAttempts: 3).
		client.failNextLogins(2);
		client.emit("invalidated");

		await waitFor(() => client.counts.login === 4 && client.isReady());
		expect(client.counts.destroy).toBe(3);
	});

	it("gives up loudly when all recovery attempts fail", async () => {
		const client = makeRecoverableClient();
		const factory: DiscordClientFactory = async () => client;
		const { logger, errors } = makeCapturingLogger();

		await setupDiscordServers(
			makeConfig(),
			makeMockRegistry(),
			logger,
			undefined,
			factory,
			// Watchdog off (huge threshold) so only the invalidated path runs
			// and the exhausted state is observable without re-arm noise.
			{ ...fastRecovery, watchdogIntervalMs: 60_000, notReadyThresholdMs: 60_000 },
		);

		client.failNextLogins(3);
		client.emit("invalidated");

		await waitFor(() => errors.some((e) => e.includes("recovery exhausted")));
		// Initial login + 3 failed recovery attempts, then stop.
		expect(client.counts.login).toBe(4);
		expect(client.isReady()).toBe(false);
	});

	it("watchdog fires recovery when the client sits not-ready past the threshold", async () => {
		const client = makeRecoverableClient();
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			makeConfig(),
			makeMockRegistry(),
			quietLogger,
			undefined,
			factory,
			fastRecovery,
		);
		expect(client.counts.login).toBe(1);

		// Silent death: no event fires, the client just stops being ready.
		client.setReady(false);

		await waitFor(() => client.counts.login >= 2 && client.isReady());
	});

	it("watchdog stays quiet while the client is ready", async () => {
		const client = makeRecoverableClient();
		const factory: DiscordClientFactory = async () => client;

		await setupDiscordServers(
			makeConfig(),
			makeMockRegistry(),
			quietLogger,
			undefined,
			factory,
			fastRecovery,
		);

		// Several watchdog cycles at 5ms intervals.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client.counts.login).toBe(1);
		expect(client.counts.destroy).toBe(0);
	});
});
