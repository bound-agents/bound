import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Encoding marker for the embedded-assets module. The generated
 * `embedded-assets.ts` stores each asset's content gzip-compressed and
 * base64-encoded rather than as a raw source string.
 *
 * Two reasons (see bound_issue devx: embedded-assets-dump-context-on-grep):
 *   1. The generated module is ~11 MB of inlined web-UI text. Compressing it
 *      shrinks the on-disk file and the compiled single binary.
 *   2. Raw inlined source means a `grep` over the repo collides with English
 *      words and identifiers *inside* the asset blob and dumps multi-KB lines
 *      into tooling context. base64-of-gzip is high-entropy, so a search for a
 *      real identifier no longer matches inside the blob.
 */
export const EMBEDDED_ASSETS_ENCODING = "gzip-base64" as const;

export type EmbeddedAssetsEncoding = typeof EMBEDDED_ASSETS_ENCODING;

/** gzip + base64 an asset's UTF-8 text content for embedding. */
export function encodeAssetContent(raw: string): string {
	return gzipSync(Buffer.from(raw, "utf-8")).toString("base64");
}

/** Inverse of {@link encodeAssetContent}: base64-decode then gunzip back to UTF-8. */
export function decodeAssetContent(encoded: string): string {
	return gunzipSync(Buffer.from(encoded, "base64")).toString("utf-8");
}
