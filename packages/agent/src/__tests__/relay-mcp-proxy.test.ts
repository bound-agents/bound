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
import type { CommandContext } from "@bound/sandbox";
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

	it("exec wrapper propagates relay request via store object reference", async () => {
		// This tests the ACTUAL production flow. The exec wrapper in agent-factory.ts
		// creates its own loopContextStorage.run() scope. The command handler stores the
		// relay request in that scope's store. After .run() returns, the store is no
		// longer active via getStore(), but the store OBJECT is still mutated because
		// JS objects are passed by reference.
		//
		// The exec wrapper must check store.relayRequest after .run() returns and
		// propagate it as the return value.
		const { commands } = generateRemoteMCPProxyCommands(db, "local-hub-site", new Set());
		const ctx = createTestContext();
		const customCommands = createDefineCommands(commands, ctx);

		const fs = new InMemoryFs();
		const bash = new Bash({ fs, customCommands });

		// Simulate the agent-factory exec wrapper pattern:
		// Creates a store, runs sandbox.exec inside .run(), then checks the store.
		const store = {
			threadId: "test-thread",
			taskId: undefined,
			relayRequest: undefined as unknown,
		};
		const result = await loopContextStorage.run(store, () =>
			bash.exec("github list_commits --owner karashiiro --repo bound"),
		);

		// After .run() returns, the store object still has relayRequest set
		// because the command handler mutated the same JS object.
		expect(store.relayRequest).toBeDefined();
		expect(isRelayRequest(store.relayRequest)).toBe(true);
		const relayReq = store.relayRequest as RelayToolCallRequest;
		expect(relayReq.outboxEntryId).toBeDefined();
		expect(relayReq.targetSiteId).toBe("remote-spoke-1");
		expect(relayReq.toolName).toBe("github");

		// The just-bash result itself should NOT have the relay fields (this is the original bug)
		expect(isRelayRequest(result)).toBe(false);
	});

	it("exec wrapper returns relay request instead of empty result", async () => {
		// This is the end-to-end test matching the production exec wrapper.
		// The wrapper should detect store.relayRequest and return it as the result,
		// overriding the stripped just-bash result.
		const { commands } = generateRemoteMCPProxyCommands(db, "local-hub-site", new Set());
		const ctx = createTestContext();
		const customCommands = createDefineCommands(commands, ctx);

		const fs = new InMemoryFs();
		const bash = new Bash({ fs, customCommands });

		// Replicate the production exec wrapper from agent-factory.ts
		const execWithRelay = async (cmd: string) => {
			const store = {
				threadId: "test-thread",
				taskId: undefined,
				relayRequest: undefined as unknown,
			};
			const result = await loopContextStorage.run(store, () => bash.exec(cmd));
			// The wrapper should detect and return the relay request
			if (store.relayRequest && isRelayRequest(store.relayRequest)) {
				const req = store.relayRequest;
				store.relayRequest = undefined;
				return req;
			}
			return result;
		};

		const result = await execWithRelay("github list_commits --owner karashiiro --repo bound");
		expect(isRelayRequest(result)).toBe(true);
		const relayReq = result as RelayToolCallRequest;
		expect(relayReq.outboxEntryId).toBeDefined();
		expect(relayReq.targetSiteId).toBe("remote-spoke-1");
	});
});
