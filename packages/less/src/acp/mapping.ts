/**
 * Mapping functions between bound's wire types and ACP schema types.
 *
 * Most of these are deliberately side-effect free so the translation logic can
 * be unit- and property-tested in isolation from the WebSocket transport and
 * the ACP connection. The one exception is `toolCallLocations`, which reads the
 * target file to compute an edit's follow-along line (see its doc comment); it
 * degrades to path-only on any read failure. See `packages/less/src/acp/session.ts`
 * for the stateful multiplexer that consumes them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
	ContentBlock as AcpContentBlock,
	PermissionOption,
	SessionUpdate,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type { ContentBlock as LlmContentBlock } from "@bound/llm";
import type { Message, WsStreamChunk } from "@bound/shared";
import { findStringOccurrences } from "../tools/match";

/**
 * The four permission options offered to the client for every gated tool call.
 * `allow_always` / `reject_always` outcomes are remembered per-tool-name for
 * the lifetime of the session (see PermissionMemory in session.ts); the
 * `*_once` variants apply only to the single call.
 */
export const PERMISSION_OPTIONS: PermissionOption[] = [
	{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/**
 * Maps a boundless client tool name (or a daemon-side native tool name) to the
 * ACP ToolKind hint, which clients use to pick icons and UI treatment. Unknown
 * names fall back to "other".
 *
 * The boundless shell tool is named dynamically (`resolveShell().toolName`,
 * e.g. `boundless_bash` / `boundless_pwsh`), so we match by suffix rather than
 * an exact name. MCP tools carry the `boundless_mcp_` prefix and are treated as
 * generic "other" since their behavior is opaque.
 */
export function toolNameToKind(toolName: string): ToolKind {
	if (toolName === "boundless_read") return "read";
	if (toolName === "boundless_write" || toolName === "boundless_edit") return "edit";
	if (toolName === "boundless_copy") return "move";
	// Shell tool: resolveShell names it boundless_bash / boundless_sh / boundless_pwsh / boundless_cmd.
	if (isShellToolName(toolName)) return "execute";
	if (toolName.startsWith("boundless_mcp_")) return "other";
	return "other";
}

export function isShellToolName(toolName: string): boolean {
	return /^boundless_(bash|sh|zsh|pwsh|powershell|cmd)$/.test(toolName);
}

export function toolCallTitle(toolName: string, args: Record<string, unknown>): string {
	const command = typeof args.command === "string" ? args.command.trim() : "";
	if (isShellToolName(toolName) && command) {
		return command;
	}

	const filePath = typeof args.file_path === "string" ? args.file_path : "";
	if (toolName === "boundless_read" && filePath) return `Read ${filePath}`;
	if (toolName === "boundless_write" && filePath) return `Write ${filePath}`;
	if (toolName === "boundless_edit" && filePath) return `Edit ${filePath}`;

	if (toolName === "boundless_copy") {
		const sourcePath = typeof args.source_path === "string" ? args.source_path : "";
		const targetPath = typeof args.target_path === "string" ? args.target_path : "";
		if (sourcePath && targetPath) return `Copy ${sourcePath} to ${targetPath}`;
	}

	if (toolName.startsWith("boundless_mcp_")) {
		return toolName.replace(/^boundless_mcp_/, "").replace(/_/g, ".");
	}

	return toolName;
}

function absolutePath(cwd: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function writePathsForTool(toolName: string, args: Record<string, unknown>, cwd: string): string[] {
	if (toolName === "boundless_write" || toolName === "boundless_edit") {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		return filePath ? [absolutePath(cwd, filePath)] : [];
	}

	if (toolName === "boundless_copy" && args.target === "host") {
		const targetPath = typeof args.target_path === "string" ? args.target_path : "";
		return targetPath ? [absolutePath(cwd, targetPath)] : [];
	}

	return [];
}

/**
 * Best-effort follow-along line for a host filesystem tool, or `undefined`.
 *
 * - `boundless_read`: the 1-based `offset` is the line, passed through verbatim
 *   (matching the Claude Code shim: Read "from line 200" -> `{ line: 200 }`).
 * - `boundless_edit`: the line where `old_string` first matches in the file's
 *   current (pre-edit) contents — this runs before the edit applies. Reads the
 *   file; any failure (missing file, unreadable, no match) degrades to no line.
 * - `boundless_write`: a write carries no line in its args and the target may
 *   not exist yet, so there is nothing to follow.
 */
function followAlongLine(
	toolName: string,
	args: Record<string, unknown>,
	cwd: string,
): number | undefined {
	if (toolName === "boundless_read") {
		const offset = args.offset;
		return typeof offset === "number" && Number.isInteger(offset) && offset > 0
			? offset
			: undefined;
	}

	if (toolName === "boundless_edit") {
		const filePath = args.file_path;
		const oldString = args.old_string;
		if (typeof filePath !== "string" || typeof oldString !== "string" || oldString.length === 0) {
			return undefined;
		}
		try {
			const content = readFileSync(absolutePath(cwd, filePath), "utf-8");
			return findStringOccurrences(content, oldString).occurrences[0]?.line;
		} catch {
			return undefined;
		}
	}

	return undefined;
}

export function toolCallLocations(
	toolName: string,
	args: Record<string, unknown>,
	cwd: string,
): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const pushHostPath = (value: unknown, line?: number) => {
		if (typeof value === "string" && value.length > 0) {
			locations.push(
				line === undefined
					? { path: absolutePath(cwd, value) }
					: { path: absolutePath(cwd, value), line },
			);
		}
	};

	if (
		toolName === "boundless_read" ||
		toolName === "boundless_write" ||
		toolName === "boundless_edit"
	) {
		pushHostPath(args.file_path, followAlongLine(toolName, args, cwd));
	} else if (toolName === "boundless_copy") {
		if (args.source === "host") pushHostPath(args.source_path);
		if (args.target === "host") pushHostPath(args.target_path);
	}

	return locations;
}

export function toolCallContent(
	toolName: string,
	args: Record<string, unknown>,
	cwd: string,
	toolCallId?: string,
): ToolCallContent[] {
	const command = typeof args.command === "string" ? args.command.trim() : "";
	if (isShellToolName(toolName) && command) {
		if (toolCallId) {
			return [{ type: "terminal", terminalId: toolCallId }];
		}
		return [
			{
				type: "content",
				content: {
					type: "text",
					text: `current_directory\n\n${cwd}`,
				},
			},
		];
	}

	if (toolName === "boundless_edit") {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		const oldText = typeof args.old_string === "string" ? args.old_string : undefined;
		const newText = typeof args.new_string === "string" ? args.new_string : undefined;
		if (filePath && oldText !== undefined && newText !== undefined) {
			return [
				{
					type: "diff",
					path: absolutePath(cwd, filePath),
					oldText,
					newText,
				},
			];
		}
	}

	if (toolName === "boundless_write") {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		const newText = typeof args.content === "string" ? args.content : undefined;
		if (filePath && newText !== undefined) {
			const absPath = absolutePath(cwd, filePath);
			// oldText is the file's *actual* prior state so the editor can render a
			// real before/after on an overwrite. A missing file is the only case
			// where there is no prior state: oldText: null renders as all-additions,
			// which is the truth for a brand-new file (and previews what's created).
			let oldText: string | null = null;
			try {
				oldText = readFileSync(absPath, "utf-8");
			} catch {
				oldText = null;
			}
			return [{ type: "diff", path: absPath, oldText, newText }];
		}
	}

	return [];
}

export function toolCallMeta(
	toolName: string,
	cwd: string,
	toolCallId: string,
	args: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
	const meta: Record<string, unknown> = {
		tool_name: toolName,
	};
	if (isShellToolName(toolName)) {
		meta.terminal_info = {
			terminal_id: toolCallId,
			cwd,
		};
	}

	const writePaths = writePathsForTool(toolName, args, cwd);
	if (writePaths.length > 0) {
		meta.sandbox_authorization = {
			write_paths: writePaths,
		};
	}

	return meta;
}

/**
 * Flattens an ACP prompt (ContentBlock[]) into the single string that bound's
 * message API accepts. Text blocks contribute their text; resource links and
 * embedded resources contribute a readable reference plus any inlined text so
 * the agent can act on @-mentioned files. Image/audio blocks are not forwarded
 * in v1 (the agent advertises image/audio prompt capabilities as false) and are
 * noted as a placeholder so the agent knows content was elided.
 *
 * Never throws: unknown block shapes are skipped.
 */
export function promptToText(blocks: AcpContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;
			case "resource_link":
				parts.push(`[resource: ${block.name} (${block.uri})]`);
				break;
			case "resource": {
				const res = block.resource;
				if (res && "text" in res && typeof res.text === "string") {
					const uri = "uri" in res ? res.uri : "embedded";
					parts.push(`[resource ${uri}]\n${res.text}`);
				} else if (res && "uri" in res) {
					parts.push(`[resource: ${res.uri}]`);
				}
				break;
			}
			case "image":
				parts.push("[image content omitted — boundless ACP mode does not forward images]");
				break;
			case "audio":
				parts.push("[audio content omitted — boundless ACP mode does not forward audio]");
				break;
			default:
				// Unknown / future block type — skip rather than throw.
				break;
		}
	}
	return parts.join("\n\n");
}

/**
 * Translates a single bound stream chunk into the ACP SessionUpdate it should
 * surface as, or null when the chunk carries no client-visible content.
 *
 * - `text` → agent_message_chunk (assistant prose)
 * - `thinking` → agent_thought_chunk (extended-thinking trace)
 * - `tool_use_*` and `done` → null here; tool-call lifecycle and turn
 *   completion are handled statefully in session.ts (a tool_use needs an
 *   accumulated args buffer and the client/daemon-tool distinction, and `done`
 *   is a per-inference marker, not the turn boundary — `thread:status`
 *   active:false is).
 * - `error` → null here; surfaced by session.ts as the turn's stop reason.
 */
export function streamChunkToSessionUpdate(chunk: WsStreamChunk): SessionUpdate | null {
	switch (chunk.type) {
		case "text":
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: chunk.content },
			};
		case "thinking":
			return {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: chunk.content },
			};
		default:
			return null;
	}
}

/**
 * Translates a persisted bound Message into the SessionUpdate used to replay
 * history during session/load. tool_call/tool_result rows reference the bound
 * tool-call id via `tool_name` (a boundless quirk preserved from attach.ts).
 * Returns null for roles that have no client-visible replay representation
 * (system/developer/alert/purge are internal context plumbing).
 */
export function messageToSessionUpdate(message: Message): SessionUpdate | null {
	switch (message.role) {
		case "user":
			return {
				sessionUpdate: "user_message_chunk",
				content: { type: "text", text: message.content },
			};
		case "assistant":
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: message.content },
			};
		case "tool_call":
			return {
				sessionUpdate: "tool_call",
				toolCallId: message.tool_name ?? message.id,
				title: message.tool_name ?? "tool call",
				kind: message.tool_name ? toolNameToKind(message.tool_name) : "other",
				status: "completed",
			};
		case "tool_result":
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: message.tool_name ?? message.id,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: message.content } }],
			};
		default:
			return null;
	}
}

/**
 * Converts a boundless tool result's content (bound LlmContentBlock[] or a
 * plain string) into ACP ToolCallContent[] for a tool_call_update. Only text
 * blocks carry across; non-text blocks are rendered as a short placeholder so
 * the tool result is never silently empty.
 */
export function toolResultToAcpContent(
	content: string | LlmContentBlock[],
): Array<{ type: "content"; content: { type: "text"; text: string } }> {
	if (typeof content === "string") {
		return [{ type: "content", content: { type: "text", text: content } }];
	}
	const out: Array<{ type: "content"; content: { type: "text"; text: string } }> = [];
	for (const block of content) {
		if (block.type === "text") {
			out.push({ type: "content", content: { type: "text", text: block.text } });
		} else {
			out.push({
				type: "content",
				content: { type: "text", text: `[${block.type} content]` },
			});
		}
	}
	return out;
}
