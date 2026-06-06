/**
 * Remote MCP help parity.
 *
 * Principle (Kara, 2026-06-06): the sandbox environment should look almost
 * exactly the same regardless of which host executes a command. The local MCP
 * dispatch path enumerates a server's subcommands (and per-subcommand params)
 * via a live listTools against the connected client. The relay path historically
 * answered `<server> --help` with a generic "Usage: <subcommand>" blurb and no
 * subcommand list at all — so an operator on the calling host could not discover
 * the verbs and had to guess.
 *
 * These tests pin two things:
 *  1. A shared formatter (formatMcpHelp) renders identical help text from a
 *     Tool[] regardless of caller, so local and relay paths can't drift.
 *  2. RelayProcessor.executeToolCall recognizes a help request and answers it
 *     from a live listTools on the host where the server actually lives, rather
 *     than trying to call a non-existent "help" tool.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Logger, ToolCallPayload } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatMcpHelp } from "../mcp-bridge";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";

const TOOLS: Tool[] = [
	{
		name: "issue_read",
		description: "Read an issue",
		inputSchema: {
			type: "object",
			properties: {
				owner: { type: "string", description: "Repo owner" },
				issue_number: { type: "number", description: "Issue number" },
			},
			required: ["owner", "issue_number"],
		},
	},
	{
		name: "issue_write",
		description: "Create or update an issue",
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string" },
				state: { type: "string" },
			},
			required: ["method"],
		},
	},
];

describe("formatMcpHelp (shared formatter)", () => {
	it("server-level help lists every subcommand with description and required params", () => {
		const result = formatMcpHelp("github-bound", TOOLS);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("github-bound subcommands:");
		expect(result.stdout).toContain("issue_read — Read an issue");
		expect(result.stdout).toContain("issue_write — Create or update an issue");
		expect(result.stdout).toContain("(required: owner, issue_number)");
		expect(result.stdout).toContain("github-bound <subcommand> --help");
	});

	it("subcommand-level help lists parameters with required/optional and descriptions", () => {
		const result = formatMcpHelp("github-bound", TOOLS, "issue_read");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("issue_read — Read an issue");
		expect(result.stdout).toContain("Parameters:");
		expect(result.stdout).toContain("owner (required) — Repo owner");
		expect(result.stdout).toContain("issue_number (required) — Issue number");
	});

	it("unknown subcommand returns an error listing the available subcommands", () => {
		const result = formatMcpHelp("github-bound", TOOLS, "nonexistent");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown subcommand: nonexistent");
		expect(result.stderr).toContain("issue_read");
		expect(result.stderr).toContain("issue_write");
	});

	it("empty tool list reports no subcommands available", () => {
		const result = formatMcpHelp("github-bound", []);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("(no subcommands available)");
	});
});

// MCPClient mock for the relay path.
class HelpMCPClient implements Partial<MCPClient> {
	public callToolInvocations: string[] = [];
	constructor(private toolList: Tool[]) {}
	async listTools(): Promise<Tool[]> {
		return this.toolList;
	}
	async callTool(name: string) {
		this.callToolInvocations.push(name);
		return { content: "{}", isError: false };
	}
}

const mockLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-mcp-help-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
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

function makeProcessor(clients: Map<string, MCPClient>): RelayProcessor {
	return new RelayProcessor(db, "local-site", clients, null, mockLogger, new TypedEventEmitter());
}

function callExecute(processor: RelayProcessor, payload: ToolCallPayload): Promise<string> {
	return (
		processor as unknown as { executeToolCall(p: ToolCallPayload): Promise<string> }
	).executeToolCall(payload);
}

describe("RelayProcessor help requests", () => {
	it("answers subcommand='help' from listTools instead of calling a help tool", async () => {
		const client = new HelpMCPClient(TOOLS);
		const processor = makeProcessor(new Map([["github-bound", client as unknown as MCPClient]]));

		const out = await callExecute(processor, {
			tool: "github-bound",
			args: { subcommand: "help" },
			timeout_ms: 30_000,
		} as ToolCallPayload);

		const payload = JSON.parse(out) as { stdout: string; exit_code: number };
		expect(payload.exit_code).toBe(0);
		expect(payload.stdout).toContain("github-bound subcommands:");
		expect(payload.stdout).toContain("issue_read");
		expect(payload.stdout).toContain("issue_write");
		// must NOT have tried to call a "help" tool on the server
		expect(client.callToolInvocations).not.toContain("help");
	});

	it("answers an empty subcommand as server-level help rather than throwing", async () => {
		const client = new HelpMCPClient(TOOLS);
		const processor = makeProcessor(new Map([["github-bound", client as unknown as MCPClient]]));

		const out = await callExecute(processor, {
			tool: "github-bound",
			args: {},
			timeout_ms: 30_000,
		} as ToolCallPayload);

		const payload = JSON.parse(out) as { stdout: string; exit_code: number };
		expect(payload.exit_code).toBe(0);
		expect(payload.stdout).toContain("github-bound subcommands:");
		expect(client.callToolInvocations.length).toBe(0);
	});

	it("answers a per-subcommand help flag with parameter detail", async () => {
		const client = new HelpMCPClient(TOOLS);
		const processor = makeProcessor(new Map([["github-bound", client as unknown as MCPClient]]));

		const out = await callExecute(processor, {
			tool: "github-bound",
			args: { subcommand: "issue_read", help: "true" },
			timeout_ms: 30_000,
		} as ToolCallPayload);

		const payload = JSON.parse(out) as { stdout: string; exit_code: number };
		expect(payload.exit_code).toBe(0);
		expect(payload.stdout).toContain("Parameters:");
		expect(payload.stdout).toContain("owner (required)");
		// help is a discovery request, not a dispatch
		expect(client.callToolInvocations).not.toContain("issue_read");
	});
});
