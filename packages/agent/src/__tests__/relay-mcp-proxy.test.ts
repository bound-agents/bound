/**
 * Tests for remote MCP proxy commands via relay.
 *
 * Regression: just-bash normalizes custom command return values to
 * { stdout, stderr, exitCode, env }, stripping extra fields like
 * outboxEntryId. This caused isRelayRequest() to always return false,
 * so the agent loop never entered RELAY_WAIT for remote MCP tool calls.
 * The tool result was "Command completed successfully" (empty stdout).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, readUndelivered } from "@bound/core";
import { createDefineCommands, loopContextStorage } from "@bound/sandbox";
import type { CommandContext, CommandResult } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import type { Logger } from "@bound/shared";
import { Bash, InMemoryFs } from "just-bash";
import {
	type RelayToolCallRequest,
	generateRemoteMCPProxyCommands,
	isRelayRequest,
} from "../mcp-bridge";

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-mcp-proxy-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);

	// Seed a remote host with MCP tools
	db.run(
		`INSERT INTO hosts (site_id, host_name, mcp_tools, online_at, modified_at, deleted)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		[
			"remote-spoke-1",
			"remote-spoke",
			JSON.stringify(["github", "atproto"]),
			new Date().toISOString(),
			new Date().toISOString(),
		],
	);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		/* already closed */
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		/* already deleted */
	}
});

function createTestContext(overrides?: Partial<CommandContext>): CommandContext {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
	};
	return {
		db,
		siteId: "local-hub-site",
		eventBus: new TypedEventEmitter(),
		logger,
		...overrides,
	};
}

describe("Remote MCP proxy commands via relay", () => {
	it("generates proxy commands for remote MCP servers", () => {
		const { commands, remoteServerNames } = generateRemoteMCPProxyCommands(
			db,
			"local-hub-site",
			new Set(), // no local servers
		);

		expect(remoteServerNames.size).toBe(2);
		expect(remoteServerNames.has("github")).toBe(true);
		expect(remoteServerNames.has("atproto")).toBe(true);
		expect(commands.length).toBe(2);
	});

	it("proxy command handler writes relay outbox entry and returns RelayToolCallRequest", async () => {
		const { commands } = generateRemoteMCPProxyCommands(db, "local-hub-site", new Set());
		const githubCmd = commands.find((c) => c.name === "github");
		if (!githubCmd) throw new Error("expected github command");

		const ctx = createTestContext();
		const result = await githubCmd.handler(
			{ subcommand: "list_commits", owner: "karashiiro", repo: "bound" },
			ctx,
		);

		// Direct handler call should return RelayToolCallRequest
		expect(isRelayRequest(result)).toBe(true);
		const relayReq = result as RelayToolCallRequest;
		expect(relayReq.outboxEntryId).toBeDefined();
		expect(relayReq.targetSiteId).toBe("remote-spoke-1");
		expect(relayReq.toolName).toBe("github");

		// Should have written outbox entry
		const outbox = readUndelivered(db);
		expect(outbox.length).toBe(1);
		expect(outbox[0].kind).toBe("tool_call");
	});

	it("relay request is available via loopContextStorage after sandbox.exec", async () => {
		// This is the CRITICAL test. just-bash strips extra fields from custom command
		// return values, so isRelayRequest(result) fails on the direct return value.
		// The fix: the proxy handler stores the full RelayToolCallRequest in
		// loopContextStorage, and the agent loop reads it from there.
		const { commands } = generateRemoteMCPProxyCommands(db, "local-hub-site", new Set());
		const ctx = createTestContext();
		const customCommands = createDefineCommands(commands, ctx);

		const fs = new InMemoryFs();
		const bash = new Bash({ fs, customCommands });

		let capturedRelayRequest: (CommandResult & Record<string, unknown>) | undefined;

		await loopContextStorage.run({ threadId: "test-thread", taskId: undefined }, async () => {
			await bash.exec("github list_commits --owner karashiiro --repo bound");

			// The relay request should be stored in the context
			const store = loopContextStorage.getStore();
			capturedRelayRequest = store?.relayRequest;
		});

		// The relay request should be available via the side-channel
		expect(capturedRelayRequest).toBeDefined();
		expect(isRelayRequest(capturedRelayRequest as CommandResult)).toBe(true);
		const relayReq = capturedRelayRequest as unknown as RelayToolCallRequest;
		expect(relayReq.outboxEntryId).toBeDefined();
		expect(relayReq.targetSiteId).toBe("remote-spoke-1");
		expect(relayReq.toolName).toBe("github");
	});

	it("relay request is consumed and does not leak to subsequent commands", async () => {
		// Ensure the relay request doesn't leak across tool calls
		const { commands } = generateRemoteMCPProxyCommands(db, "local-hub-site", new Set());
		const ctx = createTestContext();
		const customCommands = createDefineCommands(commands, ctx);

		const fs = new InMemoryFs();
		const bash = new Bash({ fs, customCommands });

		await loopContextStorage.run({ threadId: "test-thread", taskId: undefined }, async () => {
			// First call: relay request should be stored
			await bash.exec("github list_commits --owner karashiiro --repo bound");
			const store = loopContextStorage.getStore();
			expect(store?.relayRequest).toBeDefined();

			// Simulate the agent loop consuming the relay request
			if (store) store.relayRequest = undefined;

			// Second call (non-relay): relay request should NOT be set
			await bash.exec("echo hello");
			expect(store?.relayRequest).toBeUndefined();
		});
	});
});
