/**
 * Stage 5b content-block substitution. See `index.ts` for the
 * architectural rationale and post-condition contract.
 */

import type { Database } from "bun:sqlite";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";

export interface SubstituteUnsupportedBlocksParams {
	msg: LLMMessage;
	targetCapabilities: BackendCapabilities;
	/** DB handle for resolving `file_ref` source blocks. */
	db: Database;
}

export function substituteUnsupportedBlocks(params: SubstituteUnsupportedBlocksParams): LLMMessage {
	const { msg, targetCapabilities, db } = params;

	// Try to parse content as ContentBlock[] (may be a JSON string or already an array).
	let blocks: Array<{ type: string; [key: string]: unknown }> | null = null;
	if (Array.isArray(msg.content)) {
		blocks = msg.content as Array<{ type: string; [key: string]: unknown }>;
	} else if (typeof msg.content === "string") {
		try {
			const parsed = JSON.parse(msg.content);
			if (Array.isArray(parsed)) blocks = parsed;
		} catch {
			// Not JSON — plain text, no block substitution needed.
		}
	}

	if (!blocks) return msg;

	const hasImage = blocks.some((b) => b.type === "image");
	const hasDocument = blocks.some((b) => b.type === "document");
	if (!hasImage && !hasDocument) return msg;

	const substituted = blocks.map((block) => {
		if (block.type === "image" && !targetCapabilities.vision) {
			const description = typeof block.description === "string" ? block.description : "image";
			return { type: "text" as const, text: `[Image: ${description}]` };
		}

		if (block.type === "document") {
			const source = block.source as
				| { type?: string; file_id?: string; data?: string; media_type?: string }
				| undefined;

			// base64 documents pass through as-is.
			if (source?.type === "base64") {
				return block;
			}

			// file_ref documents: resolve from files table.
			if (source?.type === "file_ref" && source.file_id) {
				const fileRow = db
					.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (fileRow?.content) {
					return {
						type: "document" as const,
						source: {
							type: "base64" as const,
							media_type: source.media_type ?? "application/octet-stream",
							data: fileRow.content,
						},
						text_representation:
							typeof block.text_representation === "string"
								? (block.text_representation as string)
								: undefined,
						title: typeof block.title === "string" ? (block.title as string) : undefined,
						filename: typeof block.filename === "string" ? (block.filename as string) : undefined,
					};
				}
			}

			// Fall back to text_representation, else a stub.
			const textRep =
				typeof block.text_representation === "string"
					? block.text_representation
					: "[Document: content unavailable]";
			return { type: "text" as const, text: textRep };
		}

		// Handle file_ref image sources that need DB lookup.
		if (block.type === "image" && targetCapabilities.vision) {
			const source = block.source as
				| { type?: string; file_id?: string; data?: string; media_type?: string }
				| undefined;
			if (source?.type === "file_ref" && source.file_id) {
				const fileRow = db
					.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (!fileRow || !fileRow.content) {
					return {
						type: "text" as const,
						text: `[Image file unavailable: ${source.file_id}]`,
					};
				}
				const mediaType = (source.media_type ?? "image/jpeg") as
					| "image/jpeg"
					| "image/png"
					| "image/gif"
					| "image/webp";
				return {
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: mediaType,
						data: fileRow.content,
					},
					description: block.description,
				};
			}
		}

		return block;
	});

	return { ...msg, content: substituted as LLMMessage["content"] };
}
