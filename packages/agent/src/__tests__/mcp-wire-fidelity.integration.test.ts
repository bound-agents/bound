/**
 * MCP write-path byte-fidelity harness.
 *
 * Issue #33: non-ASCII characters (✓ U+2713, ✗ U+2717, em dash U+2014, CJK,
 * emoji) were corrupted in `github-bound issue_write --body ...` calls — every
 * UTF-8 multi-byte sequence collapsed to a leading `â`. The reported and
 * shipped theories both located the fault on Bound's write path (a Latin-1
 * mis-decode in our pipeline, "fixed" by escaping the egress body to \uXXXX).
 *
 * This harness drives the EXACT path a real `<server> <subcommand> --body ...`
 * tool call takes, end to end, against a real loopback HTTP MCP server:
 *
 *   command string
 *     → just-bash tokenizer            (Bash from just-bash)
 *     → createDefineCommands parser    (--key value → args record)
 *     → generateMCPCommands dispatch   (subcommand routing)
 *     → coerceArgsFromSchema           (string → schema type)
 *     → MCPClient.callTool             (MCP SDK client)
 *     → real HTTP request over the wire
 *     → echo MCP server                (records received arguments)
 *
 * The server echoes back the precise bytes it received. If any hop Bound
 * controls corrupts UTF-8, this test fails and localizes it. It passing while
 * production still corrupts proves the fault is downstream of our egress —
 * inside the third-party MCP service — and that egress-side escaping cannot
 * fix it.
 *
 * Tight loop: `bun test packages/agent/src/__tests__/mcp-wire-fidelity.integration.test.ts`
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type CommandContext, createDefineCommands } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import type { Logger } from "@bound/shared";
import { Bash } from "just-bash";
import { generateMCPCommands } from "../mcp-bridge";
import { MCPClient } from "../mcp-client";
import { type EchoMcpServer, startEchoMcpServer } from "./fixtures/echo-mcp-server";

const SAMPLES: Record<string, string> = {
	checkmark: "✓",
	cross: "✗",
	emDash: "—",
	mixed: "check ✓ cross ✗ dash — end",
	curlyQuotes: "“quoted” and ‘single’",
	cjk: "日本語のテスト",
	emoji: "deploy 🚀 done ✅",
	accented: "café résumé naïve",
	combined: "✓✗— 日本語 🚀 café —",
};

function hex(s: string): string {
	return Buffer.from(s, "utf8").toString("hex");
}

const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as Logger;

describe("MCP write-path byte fidelity (issue #33)", () => {
	let echo: EchoMcpServer;
	let bash: Bash;
	let client: MCPClient;

	beforeAll(async () => {
		echo = await startEchoMcpServer([
			{ name: "issue_write", stringParams: ["body", "title"] },
			{ name: "add_issue_comment", stringParams: ["body"] },
		]);

		client = new MCPClient({ name: "github-bound", transport: "http", url: echo.url });
		await client.connect();

		const clients = new Map<string, MCPClient>([["github-bound", client]]);
		const { commands } = await generateMCPCommands(clients);

		const ctx: CommandContext = {
			// db / siteId only matter for media-bearing results, which echo tools
			// never return; a minimal stub is sufficient for text round-trips.
			db: {} as never,
			siteId: "test",
			eventBus: new TypedEventEmitter(),
			logger: silentLogger,
		};
		const registered = createDefineCommands(commands, ctx);
		bash = new Bash({ customCommands: registered });
	});

	afterAll(async () => {
		await client.disconnect();
		echo.stop();
	});

	/**
	 * Quote a value for a double-quoted bash argument: the only metacharacters
	 * that survive inside double quotes are $, `, \, and ". The issue's payloads
	 * contain none of these, but escape defensively so the harness is reusable.
	 */
	function dq(value: string): string {
		return `"${value.replace(/([$`\\"])/g, "\\$1")}"`;
	}

	for (const [label, value] of Object.entries(SAMPLES)) {
		it(`preserves ${label} through issue_write --body`, async () => {
			const result = await bash.exec(`github-bound issue_write --body ${dq(value)}`);
			expect(result.exitCode).toBe(0);

			const received = echo.lastArgs.get("issue_write");
			expect(received).toBeDefined();
			// Compare bytes, not just the decoded string, so a Latin-1 round-trip
			// that happens to render identically still fails.
			expect(hex(received?.body as string)).toBe(hex(value));
			expect(received?.body).toBe(value);
		});
	}

	it("preserves non-ASCII through add_issue_comment --body", async () => {
		const value = SAMPLES.combined;
		const result = await bash.exec(`github-bound add_issue_comment --body ${dq(value)}`);
		expect(result.exitCode).toBe(0);
		const received = echo.lastArgs.get("add_issue_comment");
		expect(hex(received?.body as string)).toBe(hex(value));
	});

	it("preserves non-ASCII across multiple flags simultaneously", async () => {
		const body = "body ✓ — 日本語";
		const title = "title ✗ 🚀";
		const result = await bash.exec(
			`github-bound issue_write --title ${dq(title)} --body ${dq(body)}`,
		);
		expect(result.exitCode).toBe(0);
		const received = echo.lastArgs.get("issue_write");
		expect(received?.body).toBe(body);
		expect(received?.title).toBe(title);
	});

	it("preserves non-ASCII through unquoted and single-quoted forms", async () => {
		// Unquoted (no shell metacharacters in the sample).
		const unq = "café—✓";
		const r1 = await bash.exec(`github-bound add_issue_comment --body ${unq}`);
		expect(r1.exitCode).toBe(0);
		expect(echo.lastArgs.get("add_issue_comment")?.body).toBe(unq);

		// Single-quoted: bash treats contents literally.
		const sq = "literal ✓ — 日本語 🚀";
		const r2 = await bash.exec(`github-bound add_issue_comment --body '${sq}'`);
		expect(r2.exitCode).toBe(0);
		expect(echo.lastArgs.get("add_issue_comment")?.body).toBe(sq);
	});
});
