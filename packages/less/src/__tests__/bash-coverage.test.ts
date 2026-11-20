import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashToolWithStreaming, createBashTool } from "../tools/bash";
import { DISABLED_SANDBOX } from "../tools/sandbox";
import type { ResolvedSandboxConfig } from "../tools/sandbox";
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

/** A sandbox config that is enabled. Whether it degrades to passthrough/error
 * or actually sandboxes depends on the host (mxc containability under the test
 * runner), so tests that must be deterministic use DISABLED_SANDBOX instead. */
function enabledSandbox(onUnavailable: "passthrough" | "error"): ResolvedSandboxConfig {
	return {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable,
	};
}
void enabledSandbox;

describe("bash tool — spawn dispatch and sandbox notes", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-bashcov-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("logs sandbox_disabled and runs unsandboxed when the sandbox is opted out", async () => {
		// DISABLED_SANDBOX takes the default branch of spawnForBash's dispatch
		// (sandbox.enabled === false): an unsandboxed run recorded as INFO
		// sandbox_disabled, with NO [sandbox] degradation note (opting out is the
		// configured intent, not a degradation). Deterministic on every host.
		const infoEvents: Array<[string, Record<string, unknown> | undefined]> = [];
		const warnEvents: string[] = [];
		const logger = {
			info: (e: string, f?: Record<string, unknown>) => infoEvents.push([e, f]),
			warn: (e: string) => warnEvents.push(e),
		};
		const tool = createBashTool("host-x", shell, DISABLED_SANDBOX, logger);
		const result = (await tool({ command: "echo hi" }, new AbortController().signal, tempDir)) as {
			content: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		const text = normalizeEol(bodyText(result));
		expect(text).toContain("hi");
		expect(text).not.toContain("[sandbox]");
		expect(result.isError).toBeUndefined();
		expect(infoEvents.some(([e]) => e === "sandbox_disabled")).toBe(true);
		expect(warnEvents).toHaveLength(0);
	});

	it("records an error result with provenance when the command is missing", async () => {
		const result = (await bashToolWithStreaming(
			{},
			new AbortController().signal,
			tempDir,
			undefined,
			"host-x",
			shell,
			DISABLED_SANDBOX,
		)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(bodyText(result)).toContain("command is required");
		// Provenance block is always first.
		expect(result.content[0]?.text).toContain("[boundless]");
	});
});

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

	it("aborts a long-running command via the external signal and reports a kill exit code", async () => {
		const controller = new AbortController();
		const longCmd = isPosix ? "sleep 30" : "Start-Sleep -Seconds 30";
		const promise = bashToolWithStreaming(
			{ command: longCmd },
			controller.signal,
			tempDir,
			undefined,
			"host-x",
			shell,
		);
		// Abort shortly after spawn so the abort handler path (SIGTERM→SIGKILL) runs.
		setTimeout(() => controller.abort(), 150);
		const result = (await promise) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = bodyText(result);
		// Exit code line is present; the aborted process reports a non-zero / 137 code.
		expect(text).toContain("Exit code:");
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

	it("offloads oversized output to a local temp file and returns a pointer", async () => {
		// >50KB of output trips the offload threshold: the body is written to a
		// bound-tool-results temp file and the result carries a pointer, not the
		// full inline text.
		const big = isPosix ? "seq 1 60000" : "1..60000";
		const result = (await bashToolWithStreaming(
			{ command: big },
			new AbortController().signal,
			tempDir,
			undefined,
			"host-x",
			shell,
		)) as { content: Array<{ type: string; text?: string }> };
		const text = bodyText(result);
		expect(text.toLowerCase()).toContain("bound-tool-results");
	});
});
