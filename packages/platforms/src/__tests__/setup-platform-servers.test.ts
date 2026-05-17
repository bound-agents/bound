import { describe, expect, it } from "bun:test";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import type { PlatformMcpRegistry } from "../mcp-registry.js";
import { type DiscordClientFactory, setupDiscordServers } from "../setup-platform-servers.js";

/**
 * Tests for setupDiscordServers — login-before-register ordering invariant.
 *
 * Background (incident 2026-05-17, follow-up to commits 1039fbb + 8f55bd7):
 * the prior order was register → login. If discord login() rejected (invalid
 * token, network blip during a leadership-gain window, etc.), the outer
 * for-loop in packages/cli/src/commands/start/server.ts:848-862 caught the
 * throw with a `warn` and continued — but the prior registerServer() call
 * had already exposed the tool to the cluster relay, pointing at a Client
 * whose rest._token was never set. Every subsequent discord_list_channels
 * call surfaced "Expected token to be set for this request, but none was
 * present" via the now-correct error-propagation path (8f55bd7).
 *
 * The fix: login first. If it rejects, registration never runs, and the
 * outer catch leaves the cluster with "tool not found" (correct: discord
 * isn't wired here on this leader) instead of a half-initialized stub.
 *
 * Test seam: setupDiscordServers takes an optional DiscordClientFactory so
 * tests can inject a controllable client without touching the discord.js
 * dynamic import (which Bun's mock.module can't easily intercept due to
 * discord.js's CJS shape — observed in this fix's first iteration).
 */

const mockLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface MockClient {
	on: (event: string, handler: (...args: unknown[]) => void) => MockClient;
	login: (token: string) => Promise<unknown>;
	__loginCalls: Array<{ token: string; tickAt: number }>;
}

function makeClientFactory(
	loginBehavior: "resolve" | "reject",
	sequence: { tick: number },
): { factory: DiscordClientFactory; client: MockClient } {
	const client: MockClient = {
		on: (_event, _handler) => client,
		login: async (token: string) => {
			client.__loginCalls.push({ token, tickAt: ++sequence.tick });
			if (loginBehavior === "reject") {
				throw new Error("An invalid token was provided.");
			}
			return undefined;
		},
		__loginCalls: [],
	};
	const factory: DiscordClientFactory = async () => client;
	return { factory, client };
}

function makeMockRegistry(sequence: { tick: number }) {
	const calls: Array<{ platform: string; tickAt: number }> = [];
	const registry = {
		registerServer: async (platform: string, _server: unknown) => {
			calls.push({ platform, tickAt: ++sequence.tick });
		},
	} as unknown as PlatformMcpRegistry;
	return { registry, calls };
}

describe("setupDiscordServers — login-before-register ordering", () => {
	it("throws when login() rejects, and registry.registerServer is never called", async () => {
		const sequence = { tick: 0 };
		const { factory, client } = makeClientFactory("reject", sequence);
		const { registry, calls } = makeMockRegistry(sequence);

		const config: PlatformConnectorConfig = {
			platform: "discord",
			token: "bogus-token",
			allowed_users: [],
		} as unknown as PlatformConnectorConfig;

		await expect(setupDiscordServers(config, registry, mockLogger, factory)).rejects.toThrow(
			"An invalid token was provided.",
		);

		// The bug: pre-fix, registry.registerServer ran BEFORE login, so this
		// array would have one entry ('discord') even though login rejected.
		// Post-fix, login fails first and registration is skipped entirely.
		expect(calls).toEqual([]);

		// Login was attempted with the configured token.
		expect(client.__loginCalls).toHaveLength(1);
		expect(client.__loginCalls[0].token).toBe("bogus-token");
	});

	it("calls login before registerServer when login resolves (ordering assertion)", async () => {
		const sequence = { tick: 0 };
		const { factory, client } = makeClientFactory("resolve", sequence);
		const { registry, calls } = makeMockRegistry(sequence);

		const config: PlatformConnectorConfig = {
			platform: "discord",
			token: "good-token",
			allowed_users: [],
		} as unknown as PlatformConnectorConfig;

		await setupDiscordServers(config, registry, mockLogger, factory);

		// Both happened.
		expect(client.__loginCalls).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].platform).toBe("discord");

		// Ordering: login's tickAt must precede registerServer's tickAt.
		// Pre-fix this was inverted (register at tick 1, login at tick 2)
		// and this assertion fails.
		const loginTick = client.__loginCalls[0].tickAt;
		const registerTick = calls[0].tickAt;
		expect(loginTick).toBeLessThan(registerTick);
	});

	it("non-discord platforms short-circuit without touching login or register", async () => {
		const sequence = { tick: 0 };
		const { factory, client } = makeClientFactory("resolve", sequence);
		const { registry, calls } = makeMockRegistry(sequence);

		const config: PlatformConnectorConfig = {
			platform: "some-other-platform",
			token: "irrelevant",
		} as unknown as PlatformConnectorConfig;

		await setupDiscordServers(config, registry, mockLogger, factory);

		expect(client.__loginCalls).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	it("discord-interaction platform also enforces login-before-register", async () => {
		// Both 'discord' and 'discord-interaction' go through this path.
		// Cover both to prevent a future split that re-introduces the bug
		// for one platform but not the other.
		const sequence = { tick: 0 };
		const { factory, client } = makeClientFactory("reject", sequence);
		const { registry, calls } = makeMockRegistry(sequence);

		const config: PlatformConnectorConfig = {
			platform: "discord-interaction",
			token: "bogus",
			allowed_users: [],
		} as unknown as PlatformConnectorConfig;

		await expect(setupDiscordServers(config, registry, mockLogger, factory)).rejects.toThrow();

		expect(calls).toEqual([]);
		expect(client.__loginCalls).toHaveLength(1);
	});
});
