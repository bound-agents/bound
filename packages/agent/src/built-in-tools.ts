import type { ContentBlock, ToolDefinition } from "@bound/llm";
import type { IFileSystem } from "just-bash";

export type BuiltInToolResult = string | ContentBlock[];

export interface BuiltInTool {
	toolDefinition: ToolDefinition;
	execute: (input: Record<string, unknown>) => Promise<BuiltInToolResult>;
}

const MAX_LINES = 2000;
const MAX_BYTES = 50_000;
const BINARY_CHECK_BYTES = 8192;

// ─── Input validation ───────────────────────────────────────────────

/**
 * Validate that required parameters are present and non-undefined.
 * Returns an error string if validation fails, or null if all required params exist.
 */
function validateRequired(
	input: Record<string, unknown>,
	required: string[],
	toolName: string,
): string | null {
	const missing = required.filter((key) => input[key] === undefined || input[key] === null);
	if (missing.length > 0) {
		return `Error: missing required parameter${missing.length > 1 ? "s" : ""} for "${toolName}": ${missing.join(", ")}. This may indicate the tool call was truncated by the output token limit.`;
	}
	return null;
}

// ─── Error classification ───────────────────────────────────────────

function isExpectedFsError(err: unknown, code: string): err is Error & { code?: string } {
	if (!(err instanceof Error)) return false;
	const e = err as Error & { code?: string };
	return e.code === code || e.message.startsWith(`${code}:`);
}

// ─── Unified diff ───────────────────────────────────────────────────

function unifiedDiff(path: string, oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	const hunks: string[] = [];
	hunks.push(`--- ${path}`);
	hunks.push(`+++ ${path}`);

	// Simple LCS-based diff with context
	const CONTEXT = 3;

	// Build edit script via Myers-like approach (simplified O(n*m))
	type Change = { type: "keep" | "del" | "add"; line: string };
	const changes: Change[] = [];

	// LCS table
	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	let i = 0;
	let j = 0;
	while (i < m || j < n) {
		if (i < m && j < n && oldLines[i] === newLines[j]) {
			changes.push({ type: "keep", line: oldLines[i] });
			i++;
			j++;
		} else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
			changes.push({ type: "add", line: newLines[j] });
			j++;
		} else {
			changes.push({ type: "del", line: oldLines[i] });
			i++;
		}
	}

	// Group changes into hunks with context
	let ci = 0;
	while (ci < changes.length) {
		// Find next changed line
		while (ci < changes.length && changes[ci].type === "keep") ci++;
		if (ci >= changes.length) break;

		const hunkStart = Math.max(0, ci - CONTEXT);
		// Find end of this change group (include context between nearby changes)
		let hunkEnd = ci;
		while (hunkEnd < changes.length) {
			if (changes[hunkEnd].type !== "keep") {
				hunkEnd++;
				continue;
			}
			// Check if there's another change within context distance
			let nextChange = hunkEnd;
			while (nextChange < changes.length && changes[nextChange].type === "keep") nextChange++;
			if (nextChange < changes.length && nextChange - hunkEnd <= CONTEXT * 2) {
				hunkEnd = nextChange + 1;
			} else {
				break;
			}
		}
		hunkEnd = Math.min(changes.length, hunkEnd + CONTEXT);

		// Compute line numbers
		let oldStart = 1;
		let newStart = 1;
		for (let k = 0; k < hunkStart; k++) {
			if (changes[k].type === "keep" || changes[k].type === "del") oldStart++;
			if (changes[k].type === "keep" || changes[k].type === "add") newStart++;
		}

		let oldCount = 0;
		let newCount = 0;
		const hunkLines: string[] = [];
		for (let k = hunkStart; k < hunkEnd; k++) {
			const c = changes[k];
			if (c.type === "keep") {
				hunkLines.push(` ${c.line}`);
				oldCount++;
				newCount++;
			} else if (c.type === "del") {
				hunkLines.push(`-${c.line}`);
				oldCount++;
			} else {
				hunkLines.push(`+${c.line}`);
				newCount++;
			}
		}

		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		hunks.push(...hunkLines);
		ci = hunkEnd;
	}

	return hunks.join("\n");
}

// ─── Image detection ────────────────────────────────────────────────

/**
 * Detect image type from magic bytes in a binary string.
 * Returns the media type if recognized, undefined otherwise.
 */
function detectImageMagicBytes(raw: string): string | undefined {
	if (raw.length < 4) return undefined;

	const b0 = raw.charCodeAt(0);
	const b1 = raw.charCodeAt(1);
	const b2 = raw.charCodeAt(2);
	const b3 = raw.charCodeAt(3);

	// PNG: 89 50 4E 47
	if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "image/png";
	// JPEG: FF D8 FF
	if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "image/jpeg";
	// GIF: 47 49 46 38
	if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return "image/gif";
	// WebP: RIFF....WEBP
	if (
		raw.length >= 12 &&
		b0 === 0x52 &&
		b1 === 0x49 &&
		b2 === 0x46 &&
		b3 === 0x46 &&
		raw.charCodeAt(8) === 0x57 &&
		raw.charCodeAt(9) === 0x45 &&
		raw.charCodeAt(10) === 0x42 &&
		raw.charCodeAt(11) === 0x50
	) {
		return "image/webp";
	}

	return undefined;
}

// ─── Tool implementations ───────────────────────────────────────────

function createReadTool(fs: IFileSystem): BuiltInTool {
	const toolDefinition: ToolDefinition = {
		type: "function",
		function: {
			name: "read",
			description:
				"Read a file from the sandbox filesystem. Returns the file's text content. " +
				"Output is head-truncated to 2000 lines or 50,000 bytes (whichever is smaller); " +
				"use offset and limit to page through larger files.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Absolute VFS path to read." },
					offset: {
						type: "integer",
						description: "1-based line number to start reading from. Defaults to 1.",
					},
					limit: {
						type: "integer",
						description: "Maximum number of lines to return. Defaults to 2000.",
					},
				},
				required: ["path"],
			},
		},
	};

	return {
		toolDefinition,
		async execute(input) {
			const validationError = validateRequired(input, ["path"], "read");
			if (validationError) return validationError;

			const path = input.path as string;
			const offset = (input.offset as number | undefined) ?? 1;
			const limit = (input.limit as number | undefined) ?? MAX_LINES;

			if (offset < 1 || limit < 1 || limit > MAX_LINES) {
				return "Error: invalid offset/limit";
			}

			let raw: string;
			try {
				raw = await fs.readFile(path);
			} catch (err) {
				if (isExpectedFsError(err, "ENOENT")) {
					return `Error: file not found: ${path}`;
				}
				if (isExpectedFsError(err, "EISDIR")) {
					return `Error: path is a directory: ${path}`;
				}
				return `Error: ${(err as Error).message}`;
			}

			// Binary detection: check first 8KB for NUL byte
			const checkSlice = raw.slice(0, BINARY_CHECK_BYTES);
			if (checkSlice.includes("\0")) {
				// Check if this is an image file before rejecting as binary
				const imageType = detectImageMagicBytes(raw);
				if (imageType) {
					const base64Data = Buffer.from(raw, "binary").toString("base64");
					return [
						{ type: "text" as const, text: `Image file: ${path}` },
						{
							type: "image" as const,
							source: {
								type: "base64" as const,
								media_type: imageType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
								data: base64Data,
							},
						},
					];
				}
				return "Error: binary content not supported by read tool; use bash with appropriate tooling";
			}

			// Normalize CRLF for line counting only
			const normalized = raw.replace(/\r\n/g, "\n");
			const allLines = normalized.split("\n");
			// Remove trailing empty line from trailing newline
			if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
				allLines.pop();
			}

			// Apply offset/limit (1-based)
			const startIdx = offset - 1;
			const sliced = allLines.slice(startIdx, startIdx + limit);

			// Format with line numbers (6-col padded)
			const formatted = sliced.map((line, i) => {
				const lineNum = (startIdx + i + 1).toString().padStart(6, " ");
				return `${lineNum}\t${line}`;
			});

			// Byte-size trimming: trim trailing lines until <= MAX_BYTES
			while (formatted.length > 1) {
				const totalBytes = Buffer.byteLength(formatted.join("\n"), "utf8");
				if (totalBytes <= MAX_BYTES) break;
				formatted.pop();
			}

			const hasMore = startIdx + formatted.length < allLines.length;
			if (hasMore) {
				const nextLine = startIdx + formatted.length + 1;
				formatted.push(`[Use offset=${nextLine} to continue]`);
			}

			return formatted.join("\n");
		},
	};
}

function createWriteTool(fs: IFileSystem): BuiltInTool {
	const toolDefinition: ToolDefinition = {
		type: "function",
		function: {
			name: "write",
			description:
				"Write (or overwrite) a file in the sandbox filesystem. Parent directories are created " +
				"automatically. Content is stored as UTF-8 text.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Absolute VFS path to write." },
					content: { type: "string", description: "File content, UTF-8 text." },
				},
				required: ["path", "content"],
			},
		},
	};

	return {
		toolDefinition,
		async execute(input) {
			const validationError = validateRequired(input, ["path", "content"], "write");
			if (validationError) return validationError;

			const path = input.path as string;
			const content = input.content as string;

			try {
				await fs.writeFile(path, content);
			} catch (err) {
				if (isExpectedFsError(err, "EISDIR")) {
					return `Error: path is a directory: ${path}`;
				}
				return `Error: ${(err as Error).message}`;
			}

			const bytes = Buffer.byteLength(content, "utf8");
			return `Wrote ${bytes} bytes to ${path}`;
		},
	};
}

function createEditTool(fs: IFileSystem): BuiltInTool {
	const toolDefinition: ToolDefinition = {
		type: "function",
		function: {
			name: "edit",
			description:
				"Apply one or more search-and-replace edits to an existing file. Each edit's old_text " +
				"must match the ORIGINAL file content exactly once. All edits are validated against the " +
				"pre-edit content; if any edit's match is missing or ambiguous, no changes are written. " +
				"Returns a unified diff on success.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Absolute VFS path to edit." },
					edits: {
						type: "array",
						description: "Ordered list of edits to apply.",
						items: {
							type: "object",
							properties: {
								old_text: { type: "string" },
								new_text: { type: "string" },
							},
							required: ["old_text", "new_text"],
						},
					},
				},
				required: ["path", "edits"],
			},
		},
	};

	return {
		toolDefinition,
		async execute(input) {
			const validationError = validateRequired(input, ["path", "edits"], "edit");
			if (validationError) return validationError;

			const path = input.path as string;
			const edits = input.edits as Array<{ old_text: string; new_text: string }>;

			// Read file
			let raw: string;
			try {
				raw = await fs.readFile(path);
			} catch (err) {
				if (isExpectedFsError(err, "ENOENT")) {
					return `Error: file not found: ${path}`;
				}
				if (isExpectedFsError(err, "EISDIR")) {
					return `Error: path is a directory: ${path}`;
				}
				return `Error: ${(err as Error).message}`;
			}

			// Handle BOM
			const hasBom = raw.charCodeAt(0) === 0xfeff;
			const withoutBom = hasBom ? raw.slice(1) : raw;

			// Detect line endings
			const originalEol = withoutBom.includes("\r\n") ? "\r\n" : "\n";
			const normalized = withoutBom.replace(/\r\n/g, "\n");

			// Validate all edits against pre-edit content
			interface ValidatedEdit {
				index: number; // position in normalized string
				oldText: string; // normalized
				newText: string; // normalized
				editIdx: number; // 1-based edit number
			}
			const validated: ValidatedEdit[] = [];

			for (let ei = 0; ei < edits.length; ei++) {
				const edit = edits[ei];
				const oldNorm = edit.old_text.replace(/\r\n/g, "\n");
				const newNorm = edit.new_text.replace(/\r\n/g, "\n");

				// Count occurrences
				let count = 0;
				let pos = 0;
				let foundAt = -1;
				while (true) {
					const idx = normalized.indexOf(oldNorm, pos);
					if (idx === -1) break;
					count++;
					foundAt = idx;
					pos = idx + 1;
				}

				if (count === 0) {
					return `Error: edit ${ei + 1} old_text not found`;
				}
				if (count > 1) {
					return `Error: edit ${ei + 1} old_text matches ${count} times (must be unique)`;
				}

				validated.push({
					index: foundAt,
					oldText: oldNorm,
					newText: newNorm,
					editIdx: ei + 1,
				});
			}

			// Sort by position and check for overlaps
			validated.sort((a, b) => a.index - b.index);
			for (let vi = 1; vi < validated.length; vi++) {
				const prev = validated[vi - 1];
				const curr = validated[vi];
				if (curr.index < prev.index + prev.oldText.length) {
					return `Error: edits ${prev.editIdx} and ${curr.editIdx} overlap in source content`;
				}
			}

			// Apply replacements left-to-right
			let result = "";
			let cursor = 0;
			for (const v of validated) {
				result += normalized.slice(cursor, v.index);
				result += v.newText;
				cursor = v.index + v.oldText.length;
			}
			result += normalized.slice(cursor);

			// Restore original EOL
			let finalContent = result;
			if (originalEol === "\r\n") {
				finalContent = result.replace(/\n/g, "\r\n");
			}

			// Restore BOM
			if (hasBom) {
				finalContent = `\uFEFF${finalContent}`;
			}

			// Write
			try {
				await fs.writeFile(path, finalContent);
			} catch (err) {
				return `Error: ${(err as Error).message}`;
			}

			return unifiedDiff(path, normalized, result);
		},
	};
}

// ─── retrieve_task ──────────────────────────────────────────────────
//
// Zero-argument tool that exists primarily to absorb the model's reflex
// call on scheduled task wake-up. The scheduler (packages/agent/src/
// scheduler.ts) delivers task payloads as a synthetic tool_call +
// tool_result pair using the name "retrieve_task" — models pattern-match
// off that injected history and sometimes emit their own retrieve_task({})
// call mid-session. Before this tool existed, those reflex calls fell
// through to the bash fallback and returned "unknown tool" errors; pre
// 2026-04-26 they also tripped the empty-args truncation bug and caused
// runaway retry loops (see bound_issue:agent-loop:empty-args-false-
// truncation and the 2026-04-24 repo_watch incident).
//
// The tool intentionally returns a short, stable message telling the
// model the payload is already in conversation history and that it
// should proceed. It does NOT re-fetch the payload — that would require
// plumbing thread/task context into the built-in interface, and the
// payload is already above in history in every realistic case.
function createRetrieveTaskTool(): BuiltInTool {
	const toolDefinition: ToolDefinition = {
		type: "function",
		function: {
			name: "retrieve_task",
			description:
				"Acknowledge the current task's instructions. The scheduler delivers " +
				"task payloads automatically on wake-up via a synthetic tool_result " +
				"earlier in this conversation, so you normally do not need to call " +
				"this tool. If you do call it, it returns a reminder to proceed with " +
				"the instructions you have already received. Takes no arguments.",
			parameters: {
				type: "object",
				properties: {},
			},
		},
	};

	return {
		toolDefinition,
		async execute(_input) {
			return (
				"The current task's payload was delivered at wake-up and appears " +
				"earlier in this conversation (the tool_result immediately after the " +
				"`[Task wakeup]` developer notice). Proceed with those instructions; " +
				"no separate retrieval step is required. If you cannot locate the " +
				"payload (e.g. it was summarized out of the current window), query " +
				"the tasks table directly: " +
				"`query \"SELECT payload FROM tasks WHERE id = '<task_id>'\"`."
			);
		},
	};
}

// ─── Public API ─────────────────────────────────────────────────────

export function createBuiltInTools(fs: IFileSystem): Map<string, BuiltInTool> {
	const map = new Map<string, BuiltInTool>();
	map.set("read", createReadTool(fs));
	map.set("write", createWriteTool(fs));
	map.set("edit", createEditTool(fs));
	map.set("retrieve_task", createRetrieveTaskTool());
	return map;
}
