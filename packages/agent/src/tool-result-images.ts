/**
 * Tool-result image handling: keep heavy base64 image data out of
 * `messages.content`.
 *
 * A tool can return an `image` ContentBlock with an inline base64 source
 * (the `read` tool reading a PNG, an MCP tool returning a screenshot). A
 * single image is commonly 200KB-1MB of base64 — far past the 50KB offload
 * threshold and the 256KiB universal cap. Persisting it inline either
 * offloads the whole tool result to a file (losing the image) or middle-cuts
 * the base64 (corrupting it). Either way the model never sees a valid image.
 *
 * The fix mirrors the prompt-image path (see websocket.ts message:send): the
 * bytes are written to the `files` table and the block's source is rewritten
 * to a `file_ref`, so `messages.content` carries only a light pointer. Stage
 * 5b content substitution (`content-substitution/substitute.ts`) resolves the
 * file_ref back to inline base64 at inference time for vision-capable
 * backends — exactly as it already does for prompt-image and MCP-document
 * file_refs.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { ContentBlock } from "@bound/llm";

/**
 * Persist binary (base64) resource bytes to the `files` table via the
 * change-log outbox, returning the new file id for a `file_ref` source.
 *
 * Shared by the MCP bridge (document/image results) and the agent-loop
 * dispatch return (any tool returning an inline-base64 image block).
 */
export function persistBinaryResource(
	db: Database,
	siteId: string,
	base64Data: string,
	uri?: string,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	// Path is informational — we use a stable mcp-resource/ prefix plus the
	// id so the row is easy to identify in the files table without colliding
	// with user paths. URI hint goes in a comment-style suffix when present.
	const path = uri ? `mcp-resource/${id}#${uri.slice(0, 200)}` : `mcp-resource/${id}`;
	insertRow(
		db,
		"files",
		{
			id,
			path,
			content: base64Data,
			is_binary: 1,
			size_bytes: base64Data.length,
			created_at: now,
			modified_at: now,
			deleted: 0,
			// MCP tool output isn't user-authored, leave creator unset.
			created_by: null,
			host_origin: siteId,
		},
		siteId,
	);
	return id;
}

/**
 * Walk a tool result's ContentBlock[] and rewrite any inline-base64 `image`
 * block to a `file_ref`, persisting the bytes to the `files` table. Returns
 * the original array reference when nothing changed (no image blocks, or all
 * images already file_ref), so callers can cheaply detect a no-op.
 *
 * Idempotent: a block whose source is already `file_ref` passes through
 * untouched. Non-image blocks pass through untouched.
 */
export function persistImageBlocksAsFileRefs(
	blocks: ContentBlock[],
	db: Database,
	siteId: string,
): ContentBlock[] {
	let changed = false;
	const out = blocks.map((block) => {
		if (block.type !== "image") return block;
		const source = block.source as
			| { type?: string; data?: string; media_type?: string }
			| undefined;
		if (source?.type !== "base64" || !source.data) return block;
		const fileId = persistBinaryResource(db, siteId, source.data);
		changed = true;
		return {
			...block,
			source: {
				type: "file_ref" as const,
				file_id: fileId,
				// Carry the media_type hint so substitution re-emits the right
				// image/* type; files has no media_type column to fall back on.
				media_type: source.media_type as
					| "image/jpeg"
					| "image/png"
					| "image/gif"
					| "image/webp"
					| undefined,
			},
		};
	});
	return changed ? out : blocks;
}
