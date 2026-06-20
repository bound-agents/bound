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
import type { ImageMediaType, ContentBlock as LlmContentBlock } from "@bound/llm";
import type { Message, WsStreamChunk } from "@bound/shared";
import { parseContentBlocks } from "../session/tool-call-pairing";
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

	// "satellite" is the #180 name for the real host disk; "host" is the legacy
	// spelling that may still appear in replayed history from older threads.
	if (toolName === "boundless_copy" && (args.target === "satellite" || args.target === "host")) {
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
 * - `boundless_edit`: the line where the replacement first *diverges* from
 *   `old_string`, computed against the file's current (pre-edit) contents — this
 *   runs before the edit applies. Edits are routinely anchored with leading
 *   unchanged context lines, so the raw match-start sits above the real change;
 *   we advance past the shared `old_string`/`new_string` line-prefix to land on
 *   it. With no `new_string` arg, falls back to the match start. Reads the file;
 *   any failure (missing file, unreadable, no match) degrades to no line.
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
			const matchLine = findStringOccurrences(content, oldString).occurrences[0]?.line;
			if (matchLine === undefined) {
				return undefined;
			}
			const newString = args.new_string;
			if (typeof newString !== "string") {
				return matchLine;
			}
			// Advance past the shared leading lines so the follow line lands on the
			// first line the edit actually changes rather than on unchanged context.
			const oldLines = oldString.split("\n");
			const newLines = newString.split("\n");
			let shared = 0;
			while (
				shared < oldLines.length &&
				shared < newLines.length &&
				oldLines[shared] === newLines[shared]
			) {
				shared++;
			}
			return matchLine + shared;
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
		// Accept both the #180 "satellite" name and the legacy "host" spelling.
		if (args.source === "satellite" || args.source === "host") pushHostPath(args.source_path);
		if (args.target === "satellite" || args.target === "host") pushHostPath(args.target_path);
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
 * The four image IANA types bound can represent as an image content block
 * (the AI-SDK-supported set; see ImageMediaType in @bound/llm). Image blocks
 * with any other media type can't round-trip as images and are elided.
 */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set<string>([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

function isSupportedImageMediaType(mime: string): mime is ImageMediaType {
	return SUPPORTED_IMAGE_MEDIA_TYPES.has(mime);
}

/**
 * Maps a single ACP block to its bound text representation, or null when the
 * block contributes no text. Shared by promptToText and promptToContent so the
 * text/resource handling can't drift between the two. Image/audio map to
 * elision placeholders here; promptToContent overrides the image case to
 * forward the actual bytes.
 */
function acpBlockToText(block: AcpContentBlock): string | null {
	switch (block.type) {
		case "text":
			return block.text;
		case "resource_link": {
			// A resource_link is a pointer, not content — the agent reads the URI
			// to act on it. Carry the editor-provided mimeType/title/description
			// when present so the model sees the same framing the editor showed
			// the user, instead of just name + URI.
			const label =
				block.title && block.title !== block.name ? `${block.name} — ${block.title}` : block.name;
			const mime = block.mimeType ? ` ${block.mimeType}` : "";
			const desc = block.description ? `: ${block.description}` : "";
			return `[resource: ${label} (${block.uri})${mime}${desc}]`;
		}
		case "resource": {
			const res = block.resource;
			// TextResourceContents: uri + text are both required on the SDK type;
			// mimeType is optional. Carry the mimeType as a language/type hint.
			if (res && "text" in res && typeof res.text === "string") {
				const mime = res.mimeType ? ` ${res.mimeType}` : "";
				return `[resource: ${res.uri}${mime}]\n${res.text}`;
			}
			// BlobResourceContents: binary; can't inline as text, but note it
			// (with uri + mimeType) rather than dropping it silently.
			if (res && "blob" in res) {
				const mime = res.mimeType ? ` ${res.mimeType}` : "";
				return `[resource: ${res.uri}${mime} — binary content omitted]`;
			}
			// Unknown resource shape: surface the uri if we have one rather than
			// vanishing the block.
			if (res && "uri" in res && typeof res.uri === "string") {
				return `[resource: ${res.uri}]`;
			}
			return null;
		}
		case "image":
			return "[image content omitted — boundless ACP mode does not forward images]";
		case "audio":
			return "[audio content omitted — boundless ACP mode does not forward audio]";
		default:
			// Unknown / future block type — skip rather than throw.
			return null;
	}
}

/**
 * Flattens an ACP prompt (ContentBlock[]) into the single string that bound's
 * message API accepts. Text blocks contribute their text; resource links and
 * embedded resources contribute a readable reference plus any inlined text so
 * the agent can act on @-mentioned files. Image/audio blocks are noted as a
 * placeholder so the agent knows content was elided — see promptToContent for
 * the image-forwarding path.
 *
 * Never throws: unknown block shapes are skipped.
 */
export function promptToText(blocks: AcpContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const text = acpBlockToText(block);
		if (text !== null) {
			parts.push(text);
		}
	}
	return parts.join("\n\n");
}

/**
 * Maps an ACP prompt into the content bound's message API accepts. When the
 * prompt carries no image, returns the flat string form (identical to
 * promptToText) so text-only turns stay on the cheap string path. When an
 * image is present, returns a bound ContentBlock[]: text / resource blocks
 * fold into text blocks and each image block carries its base64 inline as a
 * bound image source.
 *
 * The bytes ride inline only as far as the web intake handler, which rewrites
 * each base64 image source to a file_ref on persist (keeping messages.content
 * light); the agent-loop readback seam (parseContentBlocks) resolves the
 * file_ref back to bytes at driver time. Audio has no bound content path and
 * stays elided as a text placeholder.
 *
 * Never throws: unknown block shapes are skipped.
 */
export function promptToContent(blocks: AcpContentBlock[]): string | LlmContentBlock[] {
	if (!blocks.some((block) => block.type === "image")) {
		return promptToText(blocks);
	}
	const out: LlmContentBlock[] = [];
	for (const block of blocks) {
		if (block.type === "image") {
			if (isSupportedImageMediaType(block.mimeType)) {
				out.push({
					type: "image",
					source: { type: "base64", media_type: block.mimeType, data: block.data },
				});
			} else {
				// bound's image content path supports only the four AI-SDK image
				// IANA types; anything else (e.g. image/svg+xml) can't be a real
				// image block, so note it rather than coerce the source type.
				out.push({
					type: "text",
					text: `[image content omitted — unsupported media type ${block.mimeType}]`,
				});
			}
		} else {
			const text = acpBlockToText(block);
			if (text !== null && text.length > 0) {
				out.push({ type: "text", text });
			}
		}
	}
	return out;
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
			// An empty text chunk has no display value and would break the open
			// agent_message run in stampMessageId for nothing. Suppress it.
			if (!chunk.content) return null;
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: chunk.content },
			};
		case "thinking":
			// bedrock-mantle emits a content:"" thinking chunk per reasoning-end
			// solely to ferry reasoning_encrypted_content for replay (persisted
			// daemon-side, independent of this display mapping). Mapping it to an
			// agent_thought_chunk breaks the open agent_message run — GPT-5.x
			// interleaves reasoning between text items, so the empty thought chunk
			// fragments visible prose mid-line (kaomoji split across lines).
			// Suppress empty thought chunks; they carry no display content.
			if (!chunk.content) return null;
			return {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: chunk.content },
			};
		default:
			return null;
	}
}

/**
 * Best-effort parse of a persisted `Message.content` string into the
 * LlmContentBlock[] it was serialized from. Assistant / tool_call rows persist
 * their content as a JSON array of blocks (thinking / text / tool_use / …);
 * plain user and string-content rows are not JSON arrays. Returns null when the
 * content is not a block array so callers can fall back to treating it as text.
 */
/**
 * Translates a persisted bound Message into the SessionUpdates used to replay
 * history during session/load, mirroring the sequence the live path emits for
 * the same turn (see handleToolCall / handleStreamChunk in session.ts).
 *
 * The tool-call linkage is NOT carried by the `tool_name` column the way the
 * old comment claimed — that's only true for `tool_result` rows, where
 * `tool_name` holds the originating tool-use id. On `tool_call` rows the
 * `tool_name` column is empty; the real call id and tool name live in the
 * `tool_use` block(s) of the persisted LlmContentBlock[] content. A single
 * `tool_call` row can carry multiple tool_use blocks (parallel calls), so this
 * returns an array: any visible text replays as an agent_message_chunk, then
 * one `tool_call` per tool_use keyed by its own id so the matching
 * `tool_result` update pairs correctly.
 *
 * Returns [] for roles that have no client-visible replay representation
 * (system/developer/alert/purge are internal context plumbing).
 *
 * `resolvedToolCallIds`, when provided, is the set of tool-use ids that have a
 * matching `tool_result` row in the transcript. A `tool_use` whose id is absent
 * from the set was dispatched but never completed (an interrupted turn), so it
 * replays as `failed` rather than falsely as `completed`. Omitting the set
 * preserves the optimistic `completed` default.
 *
 * `toolRoundSalt`, when provided, namespaces every emitted `toolCallId` as
 * `${rawId}-r${salt}`. The Responses API (GPT-5.x) numbers tool calls per
 * request (`call_1`, `call_2`, …) and resets per turn, so on resume the whole
 * transcript replays in one pass and two `call_1` rows from different turns read
 * as one call in the editor (the second is treated as an update to the first).
 * The caller passes a salt that increments per tool round so distinct calls get
 * distinct ids; the paired `tool_result` row must be replayed with the SAME salt
 * as its `tool_call` so the pairing survives. The `-r` marker is disjoint from
 * the live path's `-t` suffix (see {@link AcpSession.acpToolCallId}) so a resume
 * followed by live turns cannot collide. Globally-unique ids (Anthropic
 * `toolu_<random>`) don't need it, but salting them is harmless. Omitting the
 * salt leaves ids raw — the default replay behavior.
 */
export function messageToSessionUpdate(
	message: Message,
	resolvedToolCallIds?: ReadonlySet<string>,
	toolRoundSalt?: number,
): SessionUpdate[] {
	const acpId = (rawId: string): string =>
		toolRoundSalt === undefined ? rawId : `${rawId}-r${toolRoundSalt}`;
	switch (message.role) {
		case "user":
			return [
				{
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: message.content },
					messageId: message.id,
				},
			];
		case "assistant":
			return [
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.content },
					messageId: message.id,
				},
			];
		case "tool_call": {
			const blocks = parseContentBlocks(message.content);
			if (!blocks) {
				// No structured content to mine; announce a single generic call keyed
				// by the row id so a paired tool_result still has something to attach
				// to. Title falls back to the legacy placeholder.
				return [
					{
						sessionUpdate: "tool_call",
						toolCallId: acpId(message.tool_name ?? message.id),
						title: message.tool_name ?? "tool call",
						kind: message.tool_name ? toolNameToKind(message.tool_name) : "other",
						status: "completed",
					},
				];
			}
			const updates: SessionUpdate[] = [];
			for (const block of blocks) {
				if (block.type === "text") {
					if (block.text) {
						updates.push({
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: block.text },
							messageId: message.id,
						});
					}
				} else if (block.type === "tool_use") {
					const completed = resolvedToolCallIds ? resolvedToolCallIds.has(block.id) : true;
					updates.push({
						sessionUpdate: "tool_call",
						toolCallId: acpId(block.id),
						title: toolCallTitle(block.name, block.input),
						kind: toolNameToKind(block.name),
						status: completed ? "completed" : "failed",
						rawInput: block.input,
					});
				}
			}
			return updates;
		}
		case "tool_result":
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: acpId(message.tool_name ?? message.id),
					status: "completed",
					content: toolResultToAcpContent(parseContentBlocks(message.content) ?? message.content),
				},
			];
		default:
			return [];
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
