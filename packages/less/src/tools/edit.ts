import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type HashlineEdit, applyHashlineEdits, formatWithHashes } from "@bound/shared";
import { contextFileStaleNote, isContextFile } from "./context-files";
import { checkDbWrite } from "./db-guard";
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
	contextFiles?: readonly string[],
): ToolHandler {
	return async (args, _signal, cwd) => {
		return editToolImpl(hostname, args, cwd, sandbox, contextFiles);
	};
}

/** Narrow unknown args into a validated edit list, or an error string. */
function parseEdits(raw: unknown): HashlineEdit[] | string {
	if (!Array.isArray(raw) || raw.length === 0) {
		return "Error: edits is required and must be a non-empty array of {start, end, content}";
	}
	const edits: HashlineEdit[] = [];
	for (let i = 0; i < raw.length; i++) {
		const e = raw[i] as Record<string, unknown>;
		if (
			typeof e !== "object" ||
			e === null ||
			typeof e.start !== "string" ||
			typeof e.end !== "string" ||
			typeof e.content !== "string"
		) {
			return `Error: edits[${i}] must be {start: "LINE:HASH", end: "LINE:HASH", content: string}`;
		}
		edits.push({ start: e.start, end: e.end, content: e.content });
	}
	return edits;
}

async function editToolImpl(
	hostname: string,
	args: Record<string, unknown>,
	cwd: string,
	sandbox: ResolvedSandboxConfig,
	contextFiles?: readonly string[],
): Promise<ToolResult> {
	const { file_path } = args as { file_path?: string };

	const provenance = formatProvenance(hostname, cwd, "boundless_edit");
	const fail = (text: string): ToolResult => ({
		content: [provenance, { type: "text", text }],
		isError: true,
	});

	if (!file_path || typeof file_path !== "string") {
		return fail("Error: file_path is required and must be a string");
	}

	const edits = parseEdits(args.edits);
	if (typeof edits === "string") {
		return fail(edits);
	}

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	// System-DB guard (#207): same correctness rule as boundless_write.
	const dbDenied = checkDbWrite("boundless_edit", file_path, cwd);
	if (dbDenied) {
		return fail(dbDenied);
	}

	// In-process write guard: an edit reads then writes back to the same path, so
	// when the sandbox is enabled, confine the target to the writable set up front
	// (before the read) for a clean, rich error. This tool calls fs directly and
	// never passes through mxc's kernel guard.
	if (sandbox.enabled) {
		const check = checkWritePath(file_path, cwd, sandbox);
		if (!check.allowed) {
			return fail(formatWriteDenied("boundless_edit", file_path, check));
		}
	}

	try {
		const content = readFileSync(resolvedPath, "utf-8");

		const applied = applyHashlineEdits(content, edits);
		if (!applied.ok) {
			return fail(`Error: ${applied.error}`);
		}

		writeFileSync(resolvedPath, applied.content, "utf-8");

		// Report fresh anchors for each replaced region so follow-up edits can
		// chain without a re-read.
		const regionViews = applied.regions
			.filter((r) => r.lineCount > 0)
			.map((r) => formatWithHashes(applied.content, r.startLine, r.lineCount))
			.filter((v) => v.length > 0);

		const summary = `Edited ${file_path}: applied ${edits.length} ${edits.length === 1 ? "edit" : "edits"}`;
		const text =
			regionViews.length > 0
				? `${summary}\n\nNew content (fresh anchors):\n${regionViews.join("\n⋯\n")}`
				: summary;

		const blocks: ToolResult["content"] = [provenance, { type: "text", text }];
		if (isContextFile(file_path, cwd, contextFiles)) {
			blocks.push({ type: "text", text: contextFileStaleNote(file_path) });
		}

		return { content: blocks };
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error?.code === "ENOENT") {
			return fail(
				`Error: File not found: ${file_path}\n\nThis path does not exist. To create a new file, use the write tool instead.`,
			);
		}
		return fail(`Error: ${error?.message || String(err)}`);
	}
}

export const editTool: ToolHandler = createEditTool("unknown");
