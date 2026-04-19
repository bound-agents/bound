import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { formatProvenance } from "./provenance";
import type { ToolHandler, ToolResult } from "./types";

export function createWriteTool(hostname: string): ToolHandler {
	return async (args, _signal, cwd) => {
		return writeToolImpl(hostname, args, cwd);
	};
}

async function writeToolImpl(
	hostname: string,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const { file_path, content } = args as {
		file_path?: string;
		content?: string;
	};

	const provenance = formatProvenance(hostname, cwd, "boundless_write");

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

	if (content === undefined || typeof content !== "string") {
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: "Error: content is required and must be a string",
				},
			],
			isError: true,
		};
		return result;
	}

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	try {
		// Create parent directories
		const parentDir = dirname(resolvedPath);
		mkdirSync(parentDir, { recursive: true });

		// Atomic write: write to temp file, then rename
		const tempPath = resolve(
			parentDir,
			`.${basename(resolvedPath)}.tmp.${randomBytes(4).toString("hex")}`,
		);

		writeFileSync(tempPath, content, "utf-8");
		renameSync(tempPath, resolvedPath);

		// Calculate byte count
		const byteCount = Buffer.byteLength(content, "utf-8");

		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: `Wrote ${byteCount} bytes to ${file_path}`,
				},
			],
		};
		return result;
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
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

export const writeTool: ToolHandler = createWriteTool("unknown");
