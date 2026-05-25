/**
 * Stage 5b CONTENT_SUBSTITUTION — rewrite image / document
 * content blocks for backends that lack vision or document support.
 *
 * Three substitution branches:
 *
 *   1. Image + no vision: replace with text annotation
 *      `[Image: <description>]`.
 *   2. Document (always): pass base64 inline as-is, OR resolve
 *      file_ref via DB lookup and inline as base64, OR fall back
 *      to `text_representation` (or `[Document: content unavailable]`
 *      stub when no text rep).
 *   3. Image + vision: resolve file_ref via DB lookup and inline
 *      as base64, with media_type derived from the file_ref hint
 *      (jpeg/png/gif/webp) — falling back to image/jpeg for
 *      legacy file_refs that pre-date the media_type field.
 *
 * **Never modifies the database.** Substitution is in-memory only.
 *
 * Properties pinned by `__tests__/substitute.property.test.ts`:
 *
 *   S1 Plain-text passthrough — messages whose content is not a
 *      ContentBlock[] JSON array pass through unchanged.
 *   S2 No-op when no image/document blocks present.
 *   S3 Image substitution under no-vision: every image block is
 *      replaced with a text annotation.
 *   S4 Document base64 passthrough — base64-source documents are
 *      preserved verbatim.
 *   S5 Document file_ref unavailable → text_representation
 *      fallback (or stub when no text rep).
 *   S6 Determinism: same `(msg, capabilities, db)` produces the
 *      same output across calls.
 *   S7 The function is total over arbitrary block types — unknown
 *      block types pass through unchanged.
 */

export {
	substituteUnsupportedBlocks,
	type SubstituteUnsupportedBlocksParams,
} from "./substitute";
