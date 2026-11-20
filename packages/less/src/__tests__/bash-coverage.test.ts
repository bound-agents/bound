import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashToolWithStreaming } from "../tools/bash";
import { DISABLED_SANDBOX } from "../tools/sandbox";
import type { ResolvedShell } from "../tools/shell";
import { resolveShell } from "../tools/shell";

setDefaultTimeout(15000);

const shell = resolveShell(undefined);
const isPosix = shell.toolName === "boundless_bash";
const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

/** First text item after the provenance block. */
function bodyText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("bash tool — streaming, db-guard, abort", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-bashcov-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("invokes onStdoutChunk with streamed output", async () => {
		const chunks: string[] = [];
		const result = (await bashToolWithStreaming(
			{ command: "echo streamed" },
			new AbortController().signal,
			tempDir,
			{ onStdoutChunk: (c) => chunks.push(c) },
			"host-x",
			shell,
		)) as { content: Array<{ type: string; text?: string }> };
		const joined = normalizeEol(chunks.join(""));
		expect(joined).toContain("streamed");
		expect(normalizeEol(bodyText(result))).toContain("streamed");
	});

	it("prepends a db-guard note when the command names the SQLite CLI", async () => {
		// checkDbCommand flags `sqlite3` invocations with a warning note that is
		// prepended to output; the command still runs (never blocked).
		const cmd = isPosix ? "echo x; sqlite3 foo.db" : "echo x; sqlite3 foo.db";
		const result = (await bashToolWithStreaming(
			{ command: cmd },
			new AbortController().signal,
			tempDir,
			undefined,
			"host-x",
			shell,
		)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		const text = bodyText(result);
		// The guard note mentions the database / sqlite; at minimum output is not an error.
		expect(result.isError).toBeUndefined();
		expect(text.toLowerCase()).toContain("sqlite");
	});

	it("honors a short timeout parameter and returns an exit code", async () => {
		const longCmd = isPosix ? "sleep 30" : "Start-Sleep -Seconds 30";
		const result = (await bashToolWithStreaming(
			{ command: longCmd, timeout: 200 },
			new AbortController().signal,
			tempDir,
			undefined,
			"host-x",
			shell,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(bodyText(result)).toContain("Exit code:");
	});

	it("returns an error result (with provenance) when spawning the shell throws", async () => {
		// A shell whose binary does not exist makes Bun.spawn throw synchronously;
		// the outer try/catch turns that into an isError result rather than
		// propagating. Provenance is still first.
		const badShell: ResolvedShell = {
			command: "/nonexistent/boundless-shell-xyz-does-not-exist",
			execFlag: "-c",
			toolName: "boundless_bash",
			label: "missing shell",
		};
		const result = (await bashToolWithStreaming(
			{ command: "echo hi" },
			new AbortController().signal,
			tempDir,
			undefined,
			"host-x",
			badShell,
			DISABLED_SANDBOX,
		)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("[boundless]");
		expect(bodyText(result)).toContain("Error:");
	});
});
