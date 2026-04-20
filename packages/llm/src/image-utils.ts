type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Sniff the actual image format from magic bytes.
 *
 * Upstream sources (Discord, MCP servers) sometimes declare a MIME type that
 * doesn't match the actual payload — e.g., a copy-pasted webp URL whose bytes
 * are really PNG.  Bedrock and Anthropic both validate bytes vs declared type
 * and reject mismatches, so we sniff here as a last-resort safety net.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
	if (bytes.length < 12) return null;
	// PNG: \x89PNG\r\n\x1a\n
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	// JPEG: \xFF\xD8\xFF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	// GIF: GIF87a or GIF89a
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return "image/gif";
	}
	// WebP: RIFF....WEBP
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

/**
 * Decode enough of a base64 string to sniff the image format, then return
 * the corrected media type (or the declared one if sniffing fails).
 */
export function correctMediaType(base64Data: string, declaredType: string): string {
	try {
		// Only decode enough bytes for magic number detection (16 bytes = ~24 base64 chars)
		const slice = base64Data.slice(0, 24);
		const bytes = Uint8Array.from(atob(slice), (c) => c.charCodeAt(0));
		return sniffImageMediaType(bytes) ?? declaredType;
	} catch {
		return declaredType;
	}
}
