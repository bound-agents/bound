import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { formatProvenance } from "./provenance";
import type { ToolHandler } from "./types";

export const writeTool: ToolHandler = async (args, _signal, cwd) => {
	const { file_path, content } = args as {
		file_path?: string;
		content?: string;
	};

	if (!file_path || typeof file_path !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_write"),
			{
				type: "text",
				text: "Error: file_path is required and must be a string",
			},
		];
	}

	if (content === undefined || typeof content !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_write"),
			{
				type: "text",
				text: "Error: content is required and must be a string",
			},
		];
	}

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	const provenance = formatProvenance("unknown", cwd, "boundless_write");

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

		return [
			provenance,
			{
				type: "text",
				text: `Wrote ${byteCount} bytes to ${file_path}`,
			},
		];
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		return [
			provenance,
			{
				type: "text",
				text: `Error: ${error?.message || String(err)}`,
			},
		];
	}
};
