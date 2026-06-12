/**
 * Relay-path argument coercion.
 *
 * The local MCP dispatch path (generateMCPCommands) coerces bash `--key value`
 * string args to their JSON-Schema types before callTool. The relay path
 * (RelayProcessor.executeToolCall, used when the MCP server lives on a remote
 * host) historically forwarded the raw strings, so a strict server that
 * validates `issue_number` as a JSON number rejected "160" with
 * "parameter issue_number is not of type float64". These tests pin the
 * symmetric behavior: the receiving host coerces against the connected
 * client's tool inputSchema before calling the tool.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import type { Logger, ToolCallPayload, TypedEventEmitter } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";

// MCPClient mock that records the args callTool actually received and lets the
// test control the advertised tool schemas + listTools call count.
class RecordingMCPClient implements Partial<MCPClient> {
	public lastCallArgs: Record<string, unknown> | null = null;
	public lastCallName: string | null = null;
	public listToolsCalls = 0;

	constructor(private toolList: Tool[]) {}

	async listTools(): Promise<Tool[]> {
		this.listToolsCalls++;
		return this.toolList;
	}

	async callTool(name: string, args: Record<string, unknown>) {
		this.lastCallName = name;
		this.lastCallArgs = args;
		return { content: JSON.stringify({ ok: true }), isError: false };
	}
}

const mockLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

function mockEventBus(): TypedEventEmitter {
	return new (require("@bound/shared").TypedEventEmitter)();
}

function makeProcessor(clients: Map<string, MCPClient>): RelayProcessor {
	return new RelayProcessor(db, "local-site", clients, null, mockLogger, mockEventBus());
}

const triageTool: Tool = {
	name: "triage_issue",
	description: "Triage an issue",
	inputSchema: {
		type: "object",
		properties: {
			owner: { type: "string" },
			repo: { type: "string" },
			issue_number: { type: "number" },
			labels: { type: "array", items: { type: "string" } },
			confirmed: { type: "boolean" },
			state: { type: "string", enum: ["open", "closed"] },
		},
		required: ["owner", "repo", "issue_number"],
	},
};

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-relay-arg-coercion-${testId}.db`);
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

// executeToolCall is private; invoke through a cast for a focused unit test.
function callExecute(processor: RelayProcessor, payload: ToolCallPayload): Promise<string> {
	return (
		processor as unknown as { executeToolCall(p: ToolCallPayload): Promise<string> }
	).executeToolCall(payload);
}

describe("RelayProcessor arg coercion", () => {
	it("coerces a numeric string arg to a number before callTool", async () => {
		const client = new RecordingMCPClient([triageTool]);
		const processor = makeProcessor(new Map([["github", client]]));

		await callExecute(processor, {
			tool: "github",
			args: { subcommand: "triage_issue", owner: "o", repo: "r", issue_number: "160" },
			timeout_ms: 30_000,
		} as ToolCallPayload);

		expect(client.lastCallName).toBe("triage_issue");
		expect(client.lastCallArgs?.issue_number).toBe(160);
		expect(typeof client.lastCallArgs?.issue_number).toBe("number");
		// subcommand must not leak into the tool args
		expect(client.lastCallArgs?.subcommand).toBeUndefined();
	});

	it("coerces boolean, array, and enum args per schema", async () => {
		const client = new RecordingMCPClient([triageTool]);
		const processor = makeProcessor(new Map([["github", client]]));

		await callExecute(processor, {
			tool: "github",
			args: {
				subcommand: "triage_issue",
				owner: "o",
				repo: "r",
				issue_number: "42",
				confirmed: "true",
				labels: JSON.stringify(["bug", "p1"]),
				state: "Closed",
			},
			timeout_ms: 30_000,
		} as ToolCallPayload);

		expect(client.lastCallArgs?.confirmed).toBe(true);
		expect(client.lastCallArgs?.labels).toEqual(["bug", "p1"]);
		expect(client.lastCallArgs?.state).toBe("closed");
	});

	it("passes through args for tools/params absent from the schema (no crash)", async () => {
		const client = new RecordingMCPClient([triageTool]);
		const processor = makeProcessor(new Map([["github", client]]));

		await callExecute(processor, {
			tool: "github",
			args: { subcommand: "unknown_tool", some_param: "123" },
			timeout_ms: 30_000,
		} as ToolCallPayload);

		// Unknown tool: no schema to coerce against, arg stays a string.
		expect(client.lastCallArgs?.some_param).toBe("123");
	});

	it("caches the tool schema so repeated calls do not re-list tools each time", async () => {
		const client = new RecordingMCPClient([triageTool]);
		const processor = makeProcessor(new Map([["github", client]]));

		const payload = {
			tool: "github",
			args: { subcommand: "triage_issue", owner: "o", repo: "r", issue_number: "1" },
			timeout_ms: 30_000,
		} as ToolCallPayload;

		await callExecute(processor, payload);
		await callExecute(processor, payload);
		await callExecute(processor, payload);

		expect(client.listToolsCalls).toBe(1);
	});

	it("still dispatches when listTools fails (coercion is best-effort)", async () => {
		const failingClient = new (class extends RecordingMCPClient {
			async listTools(): Promise<Tool[]> {
				throw new Error("listTools unavailable");
			}
		})([triageTool]);
		const processor = makeProcessor(new Map([["github", failingClient as unknown as MCPClient]]));

		await callExecute(processor, {
			tool: "github",
			args: { subcommand: "triage_issue", owner: "o", repo: "r", issue_number: "7" },
			timeout_ms: 30_000,
		} as ToolCallPayload);

		// Falls back to uncoerced string rather than throwing.
		expect(failingClient.lastCallArgs?.issue_number).toBe("7");
	});
});
