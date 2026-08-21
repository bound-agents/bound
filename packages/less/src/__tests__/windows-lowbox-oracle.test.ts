import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../tools/bash";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { resolveShell } from "../tools/shell";
import type { ToolResult } from "../tools/types";

/**
 * Mandatory windows-latest oracle for the production Windows sandbox path.
 *
 * This suite deliberately has no availability probe, skip, or passthrough mode:
 * before the bound-owned lowbox backend exists, the Windows lane must stay red.
 */
describe.skipIf(process.platform !== "win32")("Windows AppContainer lowbox oracle", () => {
	it("selects appcontainer_lowbox and preserves distinct stdout/stderr pipes", async () => {
		const cwd = join(tmpdir(), `bound-lowbox-oracle-${randomBytes(4).toString("hex")}`);
		mkdirSync(cwd, { recursive: true });
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [],
			network: "open",
			onUnavailable: "error",
		};
		const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
		const logger = {
			info: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
			warn: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
		};

		try {
			const tool = createBashTool("windows-latest", resolveShell(undefined), sandbox, logger);
			const result: ToolResult = await tool(
				{
					command:
						'[Console]::Out.WriteLine("LOWBOX_STDOUT"); [Console]::Error.WriteLine("LOWBOX_STDERR")',
					timeout: 30_000,
				},
				new AbortController().signal,
				cwd,
			);

			const spawn = events.findLast((entry) => entry.event === "sandbox_spawn");
			const backend = spawn?.fields?.backend;
			if (backend === "isolation_session") {
				expect(backend, "legacy IsolationSession still owns the Windows sandbox path").toBe(
					"appcontainer_lowbox",
				);
			}

			expect(backend, "appcontainer_lowbox was not selected").toBe("appcontainer_lowbox");
			expect(result.isError, "appcontainer_lowbox execution failed").toBeUndefined();

			const output = result.content[1]?.text ?? "";
			const stdout = output.match(/stdout:\n([\s\S]*?)(?:\n\nstderr:|$)/)?.[1] ?? "";
			const stderr = output.match(/stderr:\n([\s\S]*)$/)?.[1] ?? "";
			expect(stdout).toContain("LOWBOX_STDOUT");
			expect(stdout).not.toContain("LOWBOX_STDERR");
			expect(stderr).toContain("LOWBOX_STDERR");
			expect(stderr).not.toContain("LOWBOX_STDOUT");
		} finally {
			rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
