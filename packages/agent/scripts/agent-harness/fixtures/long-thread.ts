/**
 * Long-thread fixture — reproduces the progressive fidelity truncation
 * shape observed on thread `24ac7854` (600+ messages, 391 truncated per turn).
 *
 * Unlike other fixtures that grow organically during inference, this fixture
 * pre-seeds ~200 messages into the harness's in-memory DB so that Stage 7
 * truncation fires on the FIRST inference turn. This lets the `fidelity`
 * diagnostic observe the three-tier system immediately without burning budget
 * on hundreds of inference calls.
 *
 * Shape:
 *   - 200 pre-seeded messages: 4 user messages + 98 tool_call/tool_result pairs
 *   - Each tool_result is ~1500 chars (total ~300k chars ≈ ~75k tokens estimated)
 *   - Production-scale volatile-prefix seeding (~67k tokens)
 *   - Combined with system prompt + tools, exceeds the 200k budget on turn 1
 *   - Thread summary seeded to exercise ancient marker's summary inclusion
 *
 * The `fidelity` diagnostic running this fixture should observe:
 *   - progressive fidelity fires (middleFolded > 0)
 *   - three tiers populated with reasonable token allocation
 *   - middle-tier digest is byte-stable between consecutive cold rebuilds
 *   - budget utilization in the 80-95% band
 */

import type { HarnessFixture, PreSeededMessage } from "./types";

// Generate deterministic pre-seeded messages that mimic a coding session.
function generatePreSeededMessages(): PreSeededMessage[] {
	const msgs: PreSeededMessage[] = [];

	// User message 1: initial request
	msgs.push({
		role: "user",
		content: "Please go through our GitHub issues and handle all of the simple ones",
	});

	// Assistant acknowledges
	msgs.push({
		role: "assistant",
		content:
			"I'll go through the GitHub issues and identify which ones are simple enough to " +
			"handle. Let me start by checking what's open.",
	});

	// Generate 80 tool_call + tool_result pairs simulating a coding session
	for (let i = 0; i < 80; i++) {
		const toolNames = ["boundless_bash", "boundless_read", "boundless_edit"];
		const toolName = toolNames[i % 3];
		const toolId = `toolu_${String(i).padStart(4, "0")}`;

		let toolInput: string;
		let toolResult: string;

		switch (toolName) {
			case "boundless_bash": {
				const commands = [
					"git status",
					"bun test packages/less",
					"git diff --stat",
					"grep -r 'wrapToVisualRows' packages/less/",
					"bun run typecheck",
				];
				const cmd = commands[i % commands.length];
				toolInput = JSON.stringify([
					{ type: "tool_use", id: toolId, name: toolName, input: { command: cmd } },
				]);
				toolResult = generateToolOutput(i, cmd);
				break;
			}
			case "boundless_read": {
				const paths = [
					"packages/less/src/tui/message-block.tsx",
					"packages/less/src/tui/util/wrap.ts",
					"packages/less/src/tui/components/tool-result.tsx",
				];
				const path = paths[i % paths.length];
				toolInput = JSON.stringify([
					{ type: "tool_use", id: toolId, name: toolName, input: { path } },
				]);
				toolResult = generateFileContent(i, path);
				break;
			}
			default: {
				const paths = [
					"packages/less/src/tui/util/wrap.ts",
					"packages/less/src/tui/message-block.tsx",
				];
				const path = paths[i % paths.length];
				toolInput = JSON.stringify([
					{ type: "tool_use", id: toolId, name: toolName, input: { path, content: "..." } },
				]);
				toolResult = `Edited ${path} — 12 lines changed`;
				break;
			}
		}

		msgs.push({ role: "tool_call", content: toolInput });
		msgs.push({ role: "tool_result", content: toolResult });

		// Insert user messages at intervals to exercise middle-tier user preservation
		if (i === 20) {
			msgs.push({
				role: "user",
				content: "go ahead and do all of those, none of them sound like large changes",
			});
			msgs.push({
				role: "assistant",
				content:
					"I'll proceed with implementing fixes for issues #74, #75, and #77. " +
					"Starting with #77 since it's the most straightforward — fixing the " +
					"tool output wrapping in boundless.",
			});
		}
		if (i === 50) {
			msgs.push({
				role: "user",
				content: "Continue",
			});
		}
		if (i === 70) {
			msgs.push({
				role: "user",
				content: "How's the progress on the wrap fix?",
			});
			msgs.push({
				role: "assistant",
				content:
					"The wrapToVisualRows helper is working with all tests passing. " +
					"I'm now integrating it into the MessageBlock component.",
			});
		}
	}

	return msgs;
}

function generateToolOutput(seed: number, command: string): string {
	// Generate ~1500 chars of deterministic output per tool result.
	// Realistic enough for the folding compressor to extract meaningful summaries.
	const lines: string[] = [
		"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_bash",
		`Exit code: ${seed % 7 === 0 ? "1" : "0"}`,
		"stdout:",
		`$ ${command}`,
	];

	// Pad with deterministic filler lines to reach ~1500 chars
	const fillerLine = `  ${String(seed).padStart(4, "0")}  packages/less/src/tui/message-block.tsx | ${seed + 10} ${"+-".repeat(20)}`;
	while (lines.join("\n").length < 1400) {
		lines.push(fillerLine);
	}

	return lines.join("\n");
}

function generateFileContent(seed: number, path: string): string {
	// Generate ~1500 chars of synthetic file content
	const lines: string[] = [
		"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_read",
		`File: ${path}`,
		"",
	];

	for (let line = 1; line <= 40; line++) {
		lines.push(
			`${String(line).padStart(4, " ")}  import { Box, Text } from "ink"; // line ${seed * 40 + line}`,
		);
	}

	return lines.join("\n");
}

export const longThreadFixture: HarnessFixture = {
	name: "long-thread",
	description:
		"Pre-seeds ~200 messages to trigger progressive fidelity truncation on turn 1 — " +
		"exercises three-tier system with production-scale volatile-prefix",

	volatilePrefix: {
		pinnedCount: 90,
		pinnedValueChars: 2000,
		summaryCount: 90,
		detailCount: 320,
		skillCount: 6,
	},

	initialUserContent:
		"The wrap fix tests are passing but the integration into MessageBlock still has " +
		"a rendering bug — can you check the current state and fix it?",

	threadSummary: [
		"# Summary",
		"",
		"## GOAL",
		"Kara asked me to go through GitHub issues in `bound-agents/bound` and handle the " +
			"simple ones. I'm working on issues #74 and #75 (tool output wrapping in boundless).",
		"",
		"## KEY CONTEXT",
		"- Repo path: `/Users/harness/bound`",
		"- Created `fix/boundless-tool-output-wrap` branch",
		"- `wrapToVisualRows` helper completed with all tests passing",
		"- Integrating into MessageBlock.tsx (in progress)",
		"",
		"## PROGRESS",
		"- Issue #77: PR #85 merged (thread color fix)",
		"- Issue #74/#75: wrapToVisualRows written and tested, MessageBlock integration " +
			"in progress — last edit was updating the render function to use wrapped lines " +
			"instead of raw text output",
	].join("\n"),

	tools: [
		{
			type: "function",
			function: {
				name: "boundless_bash",
				description: "Execute a bash command. Returns stdout/stderr/exit_code.",
				parameters: {
					type: "object",
					properties: { command: { type: "string", description: "Shell command" } },
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_read",
				description: "Read a file. Returns up to 2000 lines.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Absolute path" } },
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_edit",
				description: "Edit a file with a diff.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Absolute path" },
						old_string: { type: "string" },
						new_string: { type: "string" },
					},
					required: ["path", "old_string", "new_string"],
				},
			},
		},
	],

	toolStubs: {
		boundless_bash: (input) => {
			const command = String(input.command ?? "");
			return [
				"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_bash",
				"Exit code: 0",
				"stdout:",
				`$ ${command}`,
				"  packages/less/src/tui/message-block.tsx | 24 +++++++++-------",
				"  packages/less/src/tui/util/wrap.ts      | 48 ++++++++++++++++++++++",
				"  2 files changed, 58 insertions(+), 14 deletions(-)",
				"",
				"stderr:",
				"",
			].join("\n");
		},
		boundless_read: (input) => {
			const path = String(input.path ?? "");
			const lines = Array.from(
				{ length: 30 },
				(_, i) => `${String(i + 1).padStart(4, " ")}  // synthetic line for ${path}`,
			);
			return [
				"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_read",
				`File: ${path}`,
				"",
				...lines,
			].join("\n");
		},
		boundless_edit: (input) => {
			const path = String(input.path ?? "");
			return `Edited ${path} — applied diff successfully`;
		},
	},

	preSeededMessages: generatePreSeededMessages(),
};
