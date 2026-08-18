import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { formatSourceStructure, isLikelyBinary } from "@bound/shared";
import { formatProvenance } from "./provenance";
import type { ToolHandler, ToolResult } from "./types";

export function createReadStructureTool(hostname: string): ToolHandler {
	return async (args, _signal, cwd) => readStructureToolImpl(hostname, args, cwd);
}

async function readStructureToolImpl(
	hostname: string,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const path = args.path;
	const provenance = formatProvenance(hostname, cwd, "boundless_read_structure");
	if (typeof path !== "string") {
		return {
			content: [provenance, { type: "text", text: "Error: path is required and must be a string" }],
			isError: true,
		};
	}
	try {
		const resolvedCwd = realpathSync(cwd);
		const requestedPath = isAbsolute(path) ? path : resolve(cwd, path);
		const resolvedPath = realpathSync(requestedPath);
		const relativePath = relative(resolvedCwd, resolvedPath);
		if (
			relativePath === ".." ||
			relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(relativePath)
		) {
			return {
				content: [
					provenance,
					{ type: "text", text: "Error: path is outside the working directory" },
				],
				isError: true,
			};
		}
		const buffer = readFileSync(resolvedPath);
		if (isLikelyBinary(buffer.toString("utf8"))) {
			return {
				content: [
					provenance,
					{ type: "text", text: "Error: binary file is not supported by read_structure" },
				],
				isError: true,
			};
		}
		return {
			content: [
				provenance,
				{ type: "text", text: formatSourceStructure(buffer.toString("utf8"), resolvedPath) },
			],
		};
	} catch (err) {
		return {
			content: [provenance, { type: "text", text: `Error: ${(err as Error).message}` }],
			isError: true,
		};
	}
}

export const readStructureTool: ToolHandler = createReadStructureTool("unknown");
