import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findStringOccurrences } from "./match";
import { formatProvenance } from "./provenance";
import {
	DISABLED_SANDBOX,
	type ResolvedSandboxConfig,
	checkWritePath,
	formatWriteDenied,
} from "./sandbox-policy";
import type { ToolHandler, ToolResult } from "./types";

export function createEditTool(
	hostname: string,
	sandbox: ResolvedSandboxConfig = DISABLED_SANDBOX,
): ToolHandler {
	return async (args, _signal, cwd) => {
		return editToolImpl(hostname, args, cwd, sandbox);
	};
}

async function editToolImpl(
	hostname: string,
	args: Record<string, unknown>,
	cwd: string,
	sandbox: ResolvedSandboxConfig,
): Promise<ToolResult> {
	const { file_path, old_string, new_string } = args as {
		file_path?: string;
		old_string?: string;
		new_string?: string;
	};

	const provenance = formatProvenance(hostname, cwd, "boundless_edit");

	if (!file_path || typeof file_path !== "string") {
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: "Error: file_path is required and must be a string",
				},
			],
			isError: true,
		};
		return result;
	}

	if (old_string === undefined || typeof old_string !== "string") {
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: "Error: old_string is required and must be a string",
				},
			],
			isError: true,
		};
		return result;
	}

	if (new_string === undefined || typeof new_string !== "string") {
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: "Error: new_string is required and must be a string",
				},
			],
			isError: true,
		};
		return result;
	}

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	// In-process write guard: an edit reads then writes back to the same path, so
	// when the sandbox is enabled, confine the target to the writable set up front
	// (before the read) for a clean, rich error. This tool calls fs directly and
	// never passes through mxc's kernel guard.
	if (sandbox.enabled) {
		const check = checkWritePath(file_path, cwd, sandbox);
		if (!check.allowed) {
			return {
				content: [
					provenance,
					{ type: "text", text: formatWriteDenied("boundless_edit", file_path, check) },
				],
				isError: true,
			};
		}
	}

	try {
		const content = readFileSync(resolvedPath, "utf-8");

		const { count, occurrences } = findStringOccurrences(content, old_string);

		if (count === 0) {
			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: `Error: old_string not found in ${file_path}`,
					},
				],
				isError: true,
			};
			return result;
		}

		if (count > 1) {
			// Show context for the first couple of matches.
			const context = occurrences
				.slice(0, 2)
				.map((m) => `  Line ${m.line}: ${m.lineText}`)
				.join("\n");

			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: `Error: ${count} matches found for old_string in ${file_path}. Cannot edit with multiple matches.\n\nFirst match locations:\n${context}`,
					},
				],
				isError: true,
			};
			return result;
		}

		// Replace the single occurrence
		const newContent = content.replace(old_string, new_string);
		writeFileSync(resolvedPath, newContent, "utf-8");

		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: `Edited ${file_path}: replaced 1 occurrence`,
				},
			],
		};
		return result;
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error?.code === "ENOENT") {
			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: `Error: File not found: ${file_path}\n\nThis path does not exist. To create a new file, use the write tool instead.`,
					},
				],
				isError: true,
			};
			return result;
		}
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: `Error: ${error?.message || String(err)}`,
				},
			],
			isError: true,
		};
		return result;
	}
}

export const editTool: ToolHandler = createEditTool("unknown");
