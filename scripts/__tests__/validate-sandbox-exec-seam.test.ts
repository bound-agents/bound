import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	ALLOWLIST,
	SEAM_PATH,
	collectViolations,
	findViolations,
	shouldExclude,
} from "../validate-sandbox-exec-seam";

describe("validate-sandbox-exec-seam", () => {
	it("keeps the allowlist empty", () => {
		expect(ALLOWLIST).toEqual([]);
	});

	it("excludes test files", () => {
		expect(shouldExclude("packages/agent/src/__tests__/relay-mcp-proxy.test.ts")).toBe(true);
		expect(shouldExclude("packages/agent/src/scheduler.ts")).toBe(false);
	});

	it("permits new Bash( and rawScript inside the seam file", () => {
		const content =
			"const bash = new RawScriptBash(opts);\nclass X extends Bash { a = rawScript; }\nnew Bash({});";
		expect(findViolations(SEAM_PATH, content)).toEqual([]);
	});

	it("flags new Bash( outside the seam", () => {
		const v = findViolations("packages/agent/src/foo.ts", "const b = new Bash({ fs });");
		expect(v).toEqual([
			{
				file: "packages/agent/src/foo.ts",
				line: 1,
				kind: "new-bash",
				text: "const b = new Bash({ fs });",
			},
		]);
	});

	it("flags rawScript and withRawScript references outside the seam", () => {
		const content = [
			"bash.exec(cmd, { ...opts, rawScript: true });",
			"ok();",
			"sandbox.bash.exec(cmd, withRawScript(opts));",
		].join("\n");
		const v = findViolations("packages/cli/src/commands/start/agent-factory.ts", content);
		expect(v.map((x) => [x.line, x.kind])).toEqual([
			[1, "raw-script"],
			[3, "raw-script"],
		]);
	});

	it("does not flag ordinary exec through the sandbox", () => {
		expect(
			findViolations("packages/agent/src/foo.ts", "await sandbox.bash.exec(cmd, opts);"),
		).toEqual([]);
	});

	it("finds no violations in the repo", async () => {
		const root = resolve(import.meta.dir, "..", "..");
		expect(await collectViolations(root)).toEqual([]);
	});
});
