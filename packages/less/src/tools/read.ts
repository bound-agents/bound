import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { formatProvenance } from "./provenance";
import type { ToolHandler, ToolResult } from "./types";

export function createReadTool(hostname: string): ToolHandler {
	return async (args, _signal, cwd) => {
		return readToolImpl(hostname, args, cwd);
	};
}

async function readToolImpl(
	hostname: string,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const { file_path, offset, limit } = args as {
		file_path?: string;
		offset?: number;
		limit?: number;
	};

	const provenance = formatProvenance(hostname, cwd, "boundless_read");

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

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	try {
		const buffer = readFileSync(resolvedPath);

		// Binary detection: check for null bytes in first 8KB
		const isBinary = buffer.indexOf(0) !== -1 && buffer.indexOf(0) < 8192;

		if (isBinary) {
			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: `Binary file: ${file_path} (${buffer.length} bytes)`,
					},
				],
			};
			return result;
		}

		const content = buffer.toString("utf-8");
		const lines = content.split("\n");

		// Remove trailing empty line if present (from split on trailing newline)
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		// Apply offset (1-indexed) and limit
		let startLine = 0;
		let endLine = lines.length;

		if (offset !== undefined) {
			startLine = Math.max(0, offset - 1); // Convert to 0-indexed
		}

		if (limit !== undefined) {
			endLine = Math.min(lines.length, startLine + limit);
		}

		// Format with line numbers (1-indexed for display)
		const numberedLines = lines
			.slice(startLine, endLine)
			.map((line, idx) => `  ${startLine + idx + 1}\t${line}`);

		const numberedContent = numberedLines.join("\n");

		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: numberedContent,
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
						text: `Error: ENOENT: no such file or directory: ${file_path}`,
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

export const readTool: ToolHandler = createReadTool("unknown");
