/**
 * Provider image-cap guard (Stage 5b substitution).
 *
 * Anthropic rejects the WHOLE request when any single image's base64 payload
 * exceeds 5 MB (5,242,880 bytes, measured on the encoded string). A live
 * incident (2026-07-18, thread bf3894b1): a pasted 3200×2080 screenshot
 * persisted as a 5,417,600-char base64 file row, and every subsequent turn
 * on the thread re-hydrated it and died at the same validation. The guard
 * degrades oversized images to a labeled text placeholder instead.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import { PROVIDER_IMAGE_BASE64_MAX_BYTES } from "@bound/llm";
import { substituteUnsupportedBlocks } from "../substitute";

const VISION: BackendCapabilities = { vision: true } as BackendCapabilities;

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function insertFile(db: Database, fileId: string, content: string) {
	db.run(
		"INSERT INTO files (id, path, size_bytes, is_binary, content, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			fileId,
			`/file/${fileId}`,
			content.length,
			1,
			content,
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		],
	);
}

describe("oversized-image provider cap guard", () => {
	it("degrades a file_ref image whose base64 exceeds the provider cap to a placeholder", () => {
		const db = freshDb();
		const oversized = "a".repeat(PROVIDER_IMAGE_BASE64_MAX_BYTES + 1);
		insertFile(db, "big-img", oversized);
		const msg: LLMMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{
					type: "image",
					source: { type: "file_ref", file_id: "big-img", media_type: "image/png" },
					description: "pasted image 3200×2080 · pv:76ef31d4",
				},
			] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({ msg, targetCapabilities: VISION, db });
		const blocks = out.content as Array<{ type: string; text?: string }>;
		expect(blocks[0]).toEqual({ type: "text", text: "look at this" });
		expect(blocks[1].type).toBe("text");
		expect(blocks[1].text).toContain("[Image omitted:");
		expect(blocks[1].text).toContain("pasted image 3200×2080");
		expect(blocks[1].text).toContain(`${oversized.length} bytes`);
		expect(blocks[1].text).toContain("5 MB");
		db.close();
	});

	it("hydrates a file_ref image at exactly the cap (boundary: not over)", () => {
		const db = freshDb();
		const atCap = "b".repeat(PROVIDER_IMAGE_BASE64_MAX_BYTES);
		insertFile(db, "cap-img", atCap);
		const msg: LLMMessage = {
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "file_ref", file_id: "cap-img", media_type: "image/png" },
				},
			] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({ msg, targetCapabilities: VISION, db });
		const blocks = out.content as Array<{
			type: string;
			source?: { type: string; data?: string };
		}>;
		expect(blocks[0].type).toBe("image");
		expect(blocks[0].source?.type).toBe("base64");
		expect(blocks[0].source?.data).toBe(atCap);
		db.close();
	});

	it("degrades an oversized INLINE base64 image (legacy rows predating file_ref rewrite)", () => {
		const db = freshDb();
		const oversized = "c".repeat(PROVIDER_IMAGE_BASE64_MAX_BYTES + 1);
		const msg: LLMMessage = {
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: oversized },
				},
			] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({ msg, targetCapabilities: VISION, db });
		const blocks = out.content as Array<{ type: string; text?: string }>;
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toContain("[Image omitted:");
		db.close();
	});

	it("small file_ref images hydrate unchanged (guard is inert under the cap)", () => {
		const db = freshDb();
		insertFile(db, "small-img", "aGVsbG8=");
		const msg: LLMMessage = {
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "file_ref", file_id: "small-img", media_type: "image/png" },
				},
			] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({ msg, targetCapabilities: VISION, db });
		const blocks = out.content as Array<{
			type: string;
			source?: { type: string; data?: string };
		}>;
		expect(blocks[0].type).toBe("image");
		expect(blocks[0].source?.data).toBe("aGVsbG8=");
		db.close();
	});
});
