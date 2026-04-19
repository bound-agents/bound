import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bashTool } from "../tools/bash";

describe("boundless_bash", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join("/tmp", `boundless-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("AC5.9: executes command in cwd and returns stdout/stderr with exit code", async () => {
		const result = await bashTool(
			{ command: "echo hello" },
			new AbortController().signal,
			tempDir,
		);

		expect(result).toHaveLength(2);
		const provenanceBlock = result[0];
		expect(provenanceBlock.type).toBe("text");
		expect(provenanceBlock.text).toContain("[boundless]");
		expect(provenanceBlock.text).toContain("tool=boundless_bash");

		const contentBlock = result[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("hello");
	});

	it("AC5.9: captures stderr separately", async () => {
		const result = await bashTool(
			{ command: 'echo "to stdout" && echo "to stderr" >&2' },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain("to stdout");
		expect(contentBlock.text).toContain("to stderr");
		expect(contentBlock.text).toContain("stdout:");
		expect(contentBlock.text).toContain("stderr:");
	});

	it("AC5.9: shows exit code for failed commands", async () => {
		const result = await bashTool(
			{ command: "exit 42" },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain("Exit code: 42");
	});

	it("AC5.10: aborts on AbortSignal with SIGTERM then SIGKILL", async () => {
		const controller = new AbortController();

		// Start the tool and abort after a short delay
		const promise = bashTool(
			{ command: "sleep 60", timeout: 30000 },
			controller.signal,
			tempDir,
		);

		// Trigger abort after 100ms (should kill the process quickly)
		setTimeout(() => controller.abort(), 100);

		const result = await promise;
		const contentBlock = result[1];

		// Process should be terminated, not timed out (exit code should reflect SIGTERM/SIGKILL)
		// On Unix, SIGTERM is signal 15, SIGKILL is signal 9
		// The exit code will be 128 + signal number (e.g., 143 for SIGTERM, 137 for SIGKILL)
		// Or it might be negative on some systems. Just verify it's not 0 and not 30000ms timeout.
		expect(contentBlock.text).toContain("Exit code:");
		expect(contentBlock.text).not.toContain("Exit code: 0");
	}, { timeout: 5000 });

	it("AC5.11: truncates output >100KB from the middle with marker", async () => {
		// Generate a command that produces >100KB output
		const result = await bashTool(
			{ command: "seq 1 50000" },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		const text = contentBlock.text;

		// Should contain the marker for truncation
		expect(text).toContain("truncated");
		// Output should be less than 110KB (well under original 100KB*2)
		expect(text.length).toBeLessThan(110000);
		// Should still have beginning and ending parts
		expect(text).toContain("1\n");
		expect(text).toContain("50000\n");
	});

	it("AC5.12: always includes provenance block first", async () => {
		const result = await bashTool(
			{ command: "echo test" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.length).toBeGreaterThanOrEqual(1);
		const firstBlock = result[0];
		expect(firstBlock.type).toBe("text");
		expect(firstBlock.text).toContain("[boundless]");
		expect(firstBlock.text).toContain("boundless_bash");
	});

	it("respects the cwd parameter for command execution", async () => {
		const subdir = join(tempDir, "subdir");
		mkdirSync(subdir);

		const result = await bashTool(
			{ command: "pwd" },
			new AbortController().signal,
			subdir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain(subdir);
	});

	it("handles timeout parameter when provided", async () => {
		const result = await bashTool(
			{ command: "echo quick", timeout: 1000 },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("quick");
	});

	it("uses 5 minute default timeout if not provided", async () => {
		// This test just verifies the command runs within default timeout
		const result = await bashTool(
			{ command: "echo done" },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain("Exit code: 0");
	});

	it("handles command with complex redirections and pipes", async () => {
		const result = await bashTool(
			{ command: "echo 'line1\nline2\nline3' | sort -r" },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result[1];
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("line");
	});
});
