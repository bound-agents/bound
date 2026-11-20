import { describe, expect, it } from "bun:test";
import { messageFixture, renderMessageBlock } from "./tui-message-fixtures";

const render120 = (message: Parameters<typeof renderMessageBlock>[0]) =>
	renderMessageBlock(message, { terminalColumns: 120 });

describe("MessageBlock round4 uncovered branches", () => {
	describe("exitCodeHint on tool_result error indicator (MessageBlock.tsx 227-246)", () => {
		const cases: Array<[number, string]> = [
			[2, "usage error"],
			[124, "timeout"],
			[126, "not executable"],
			[127, "not found"],
			[130, "interrupted"],
			[137, "killed"],
			[139, "segfault"],
			[143, "terminated"],
		];
		for (const [code, hint] of cases) {
			it(`labels exit code ${code} as "${hint}"`, () => {
				const message = messageFixture({
					id: `err-${code}`,
					role: "tool_result",
					tool_name: "bash",
					content: "command failed",
					exit_code: code,
				});
				const frame = render120(message).lastFrame() ?? "";
				expect(frame).toContain(hint);
			});
		}

		it("shows no hint for an unmapped non-zero exit code (default branch)", () => {
			const message = messageFixture({
				id: "err-99",
				role: "tool_result",
				tool_name: "bash",
				content: "weird failure",
				exit_code: 99,
			});
			const frame = render120(message).lastFrame() ?? "";
			// None of the known hints leak in for an unmapped code.
			expect(frame).not.toContain("usage error");
			expect(frame).not.toContain("segfault");
			expect(frame).toContain("weird failure");
		});
	});

	describe("MCP-OAuth consent notice (MessageBlock.tsx 928-963)", () => {
		it("renders a settled auth_challenge_raised result as a consent notice", () => {
			const text = [
				'Authorization required for MCP server "github".',
				"Scopes demanded: repo, read:user",
				"Challenge id: chal-abc-123",
			].join("\n");
			const message = messageFixture({
				id: "auth-1",
				role: "tool_result",
				tool_name: "github",
				content: text,
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("authorization required");
			expect(frame).toContain("github");
			expect(frame).toContain("chal-abc-123");
			expect(frame).toContain("bound login --challenge chal-abc-123");
		});

		it("includes the prior-failure line when the challenge was re-raised after a failure", () => {
			const text = [
				'Authorization required for MCP server "linear".',
				"The previous authorization attempt failed: token expired",
				"The server requires authorization (no specific scopes named).",
				"Challenge id: chal-xyz-789",
			].join("\n");
			const message = messageFixture({
				id: "auth-2",
				role: "tool_result",
				tool_name: "linear",
				content: text,
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("authorization required");
			expect(frame).toContain("linear");
			expect(frame).toContain("token expired");
			expect(frame).toContain("chal-xyz-789");
		});
	});

	describe("assistant cache-usage fragment (MessageBlock.tsx 820-848)", () => {
		it("renders a cache read/write fragment when metadata carries positive usage", () => {
			const message = messageFixture({
				id: "asst-cache",
				role: "assistant",
				content: "done",
				metadata: JSON.stringify({ cache_usage: { read: 1234, write: 56 } }),
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("agent");
			expect(frame).toContain("cache");
		});

		it("omits the cache fragment when usage is zero", () => {
			const message = messageFixture({
				id: "asst-zero",
				role: "assistant",
				content: "done",
				metadata: JSON.stringify({ cache_usage: { read: 0, write: 0 } }),
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("agent");
			expect(frame).not.toContain("cache ");
		});

		it("tolerates malformed metadata without crashing (catch branch)", () => {
			const message = messageFixture({
				id: "asst-bad",
				role: "assistant",
				content: "still rendered",
				metadata: "{not valid json",
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("still rendered");
		});
	});

	describe("tool_call with inline assistant text (MessageBlock.tsx 851-884)", () => {
		it("renders inline text above a single tool_use row", () => {
			const content = JSON.stringify([
				{ type: "text", text: "Let me check that file." },
				{ type: "tool_use", id: "tu1", name: "write", input: { path: "notes.txt" } },
			]);
			const message = messageFixture({
				id: "tc-inline",
				role: "tool_call",
				content,
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("agent");
			expect(frame).toContain("Let me check that file.");
			expect(frame).toContain("write");
		});
	});

	describe("fallback rendering for unknown roles (MessageBlock.tsx 1348-1356)", () => {
		it("renders an unknown role as a dim bracketed line", () => {
			const message = messageFixture({
				id: "weird-role",
				// biome-ignore lint/suspicious/noExplicitAny: exercising the fallback for an unmodeled role
				role: "mystery" as any,
				content: "unmapped payload",
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("mystery");
			expect(frame).toContain("unmapped payload");
		});
	});

	describe("non-text content block (MessageBlock.tsx 790-791)", () => {
		it("renders a [Non-text content] placeholder when a user message has only non-text blocks", () => {
			const content = JSON.stringify([{ type: "tool_result", tool_use_id: "x" }]);
			const message = messageFixture({
				id: "nontext",
				role: "user",
				content,
			});
			const frame = render120(message).lastFrame() ?? "";
			expect(frame).toContain("Non-text content");
		});
	});
});
