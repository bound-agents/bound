/**
 * Property tests for Stage 5b content-block substitution.
 *
 * Properties:
 *
 *   S1 Plain-text passthrough — non-array content unchanged.
 *   S2 No-op when no image/document blocks present.
 *   S3 Image substitution under no-vision: every image block
 *      replaced with text annotation.
 *   S4 Document base64 passthrough.
 *   S5 Document file_ref unavailable → text_representation
 *      fallback (or stub when no text rep).
 *   S6 Determinism.
 *   S7 Total over arbitrary block types — unknown blocks pass
 *      through unchanged.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { substituteUnsupportedBlocks } from "../substitute";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

const NO_VISION: BackendCapabilities = { vision: false } as BackendCapabilities;
const VISION: BackendCapabilities = { vision: true } as BackendCapabilities;

describe("substituteUnsupportedBlocks — property tests", () => {
	it("S1: plain-text content passes through unchanged", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 0, maxLength: 200 }).filter((s) => {
					// Reject anything that LOOKS like a JSON array — those
					// would be re-parsed as ContentBlock[] and routed to
					// substitution.
					try {
						const parsed = JSON.parse(s);
						return !Array.isArray(parsed);
					} catch {
						return true; // not JSON, definitely passthrough
					}
				}),
				(content) => {
					const db = freshDb();
					const msg: LLMMessage = { role: "user", content };
					const out = substituteUnsupportedBlocks({
						msg,
						targetCapabilities: NO_VISION,
						db,
					});
					db.close();
					return out === msg; // strict identity — passthrough returns the same object
				},
			),
			{ numRuns: 100 },
		);
	});

	it("S2: no-op when no image/document blocks in array", () => {
		const db = freshDb();
		const blocks = [{ type: "text", text: "hello" }];
		const msg: LLMMessage = {
			role: "user",
			content: blocks as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: NO_VISION,
			db,
		});
		expect(out).toBe(msg);
		db.close();
	});

	it("S3: image substitution under no-vision", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						description: fc
							.string({ minLength: 0, maxLength: 30 })
							.filter((s) => !/[\n\r]/.test(s)),
					}),
					{ minLength: 1, maxLength: 5 },
				),
				(images) => {
					const db = freshDb();
					const blocks = images.map((img) => ({
						type: "image",
						source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" },
						description: img.description,
					}));
					const msg: LLMMessage = {
						role: "user",
						content: blocks as unknown as LLMMessage["content"],
					};
					const out = substituteUnsupportedBlocks({
						msg,
						targetCapabilities: NO_VISION,
						db,
					});
					db.close();
					if (!Array.isArray(out.content)) return false;
					return out.content.every(
						(b) =>
							(b as { type: string }).type === "text" &&
							(b as { text: string }).text.startsWith("[Image:"),
					);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("S4: document base64 passthrough", () => {
		const db = freshDb();
		const block = {
			type: "document",
			source: { type: "base64", data: "ZG9j", media_type: "application/pdf" },
		};
		const msg: LLMMessage = {
			role: "user",
			content: [block] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: NO_VISION,
			db,
		});
		const outBlock = (out.content as Array<{ type: string }>)[0];
		expect(outBlock).toBe(block);
		db.close();
	});

	it("S5: document file_ref unavailable → text_representation fallback", () => {
		const db = freshDb();
		// No row inserted into files; file_ref will fail to resolve.
		const block = {
			type: "document",
			source: { type: "file_ref", file_id: "missing-id" },
			text_representation: "this is the text rep",
		};
		const msg: LLMMessage = {
			role: "user",
			content: [block] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: NO_VISION,
			db,
		});
		const outBlock = (out.content as Array<{ type: string; text?: string }>)[0];
		expect(outBlock.type).toBe("text");
		expect(outBlock.text).toBe("this is the text rep");
		db.close();
	});

	it("S5b: document file_ref unavailable + no text_rep → stub", () => {
		const db = freshDb();
		const block = {
			type: "document",
			source: { type: "file_ref", file_id: "missing-id" },
		};
		const msg: LLMMessage = {
			role: "user",
			content: [block] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: NO_VISION,
			db,
		});
		const outBlock = (out.content as Array<{ type: string; text?: string }>)[0];
		expect(outBlock.type).toBe("text");
		expect(outBlock.text).toBe("[Document: content unavailable]");
		db.close();
	});

	it("S6: determinism — same input produces same output", () => {
		const db = freshDb();
		const blocks = [
			{ type: "text", text: "hi" },
			{ type: "image", description: "an image", source: { type: "base64", data: "x" } },
		];
		const msg: LLMMessage = {
			role: "user",
			content: blocks as unknown as LLMMessage["content"],
		};
		const a = JSON.stringify(
			substituteUnsupportedBlocks({ msg, targetCapabilities: NO_VISION, db }),
		);
		const b = JSON.stringify(
			substituteUnsupportedBlocks({ msg, targetCapabilities: NO_VISION, db }),
		);
		expect(a).toBe(b);
		db.close();
	});

	it("S7: unknown block types pass through unchanged", () => {
		const db = freshDb();
		const block = { type: "future-extension", foo: "bar" };
		const msg: LLMMessage = {
			role: "user",
			content: [block] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: NO_VISION,
			db,
		});
		const outBlock = (out.content as Array<{ type: string }>)[0];
		expect(outBlock).toBe(block);
		db.close();
	});

	it("S-vision-passthrough: image base64 with vision-capable backend passes through", () => {
		const db = freshDb();
		const block = {
			type: "image",
			source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" },
			description: "test",
		};
		const msg: LLMMessage = {
			role: "user",
			content: [block] as unknown as LLMMessage["content"],
		};
		const out = substituteUnsupportedBlocks({
			msg,
			targetCapabilities: VISION,
			db,
		});
		// With vision support and base64 source, the block should pass
		// through without alteration.
		const outBlock = (out.content as Array<{ type: string }>)[0];
		expect(outBlock).toBe(block);
		db.close();
	});
});
