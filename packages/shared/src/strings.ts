/**
 * Format a file attachment reference for inclusion in a user message.
 * All attachment types (text, binary) get the same compact format
 * that points to where the file is stored in the VFS.
 */
export function formatFileAttachment(name: string, path: string, sizeBytes: number): string {
	return `[Attached file: ${name} — saved to ${path} (${sizeBytes} bytes)]`;
}

/**
 * Universal cap on tool result content size, in bytes.
 *
 * Applied at two boundaries to prevent any single tool result from blowing up
 * context: (1) the agent-loop dispatch boundary for native/builtin/sandbox/
 * platform tools, and (2) the WebSocket `tool:result` ingestion path for
 * client-deferred tool results.
 *
 * Per-tool caps (read tool's MAX_BYTES, query tool's MAX_OUTPUT_BYTES,
 * boundless_bash's HALF_OUTPUT_BYTES) still run first inside their respective
 * tools and produce more informative truncation. This cap is a final backstop
 * for tools that don't enforce their own — most notably the native bash
 * tool's stdout/stderr passthrough and any uncapped MCP-bridged tool result.
 */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;

/**
 * Apply the universal tool-result byte cap to a string. Truncates from the
 * middle, keeping `MAX_TOOL_RESULT_BYTES / 2` bytes of head and tail with a
 * single-line marker between. Middle truncation preserves the tail of the
 * output (errors, exit codes, summaries) which often appears at the end.
 *
 * Returns the input unchanged when within budget. Operates on UTF-8 byte
 * length to match how the result is ultimately serialized over the wire and
 * persisted in the messages table.
 *
 * Idempotent on already-capped input: a string at or below the cap is
 * returned by reference.
 */
export function capToolResultContent(content: string): string {
	const totalBytes = Buffer.byteLength(content, "utf8");
	if (totalBytes <= MAX_TOOL_RESULT_BYTES) return content;

	// Compute the marker first using an upper-bound dropped-byte count so we
	// can subtract its size from the half-budgets. Using `totalBytes` as the
	// upper bound makes the rendered marker the same width or wider than the
	// real one, so the final result always fits within MAX_TOOL_RESULT_BYTES.
	const buildMarker = (droppedBytes: number): string =>
		`\n... [truncated ${droppedBytes} bytes from middle; tool result exceeded ${MAX_TOOL_RESULT_BYTES}-byte cap — re-run with a narrower scope or pipe through head/grep] ...\n`;
	const markerUpperBound = Buffer.byteLength(buildMarker(totalBytes), "utf8");

	const usableBytes = MAX_TOOL_RESULT_BYTES - markerUpperBound;
	if (usableBytes <= 0) {
		// Pathological: cap is smaller than the marker itself. Return just the
		// marker with the actual dropped count (= entire input).
		return buildMarker(totalBytes);
	}
	const halfBytes = Math.floor(usableBytes / 2);

	// Walk from the start until adding the next char would exceed halfBytes.
	let headEnd = 0;
	let headBytes = 0;
	while (headEnd < content.length) {
		const charBytes = Buffer.byteLength(content[headEnd] ?? "", "utf8");
		if (headBytes + charBytes > halfBytes) break;
		headBytes += charBytes;
		headEnd++;
	}

	// Walk from the end until adding the next char would exceed halfBytes.
	let tailStart = content.length;
	let tailBytes = 0;
	while (tailStart > headEnd) {
		const charBytes = Buffer.byteLength(content[tailStart - 1] ?? "", "utf8");
		if (tailBytes + charBytes > halfBytes) break;
		tailBytes += charBytes;
		tailStart--;
	}

	const head = content.slice(0, headEnd);
	const tail = content.slice(tailStart);
	const droppedBytes = totalBytes - headBytes - tailBytes;
	return `${head}${buildMarker(droppedBytes)}${tail}`;
}

/**
 * Append a `[duration: N.NNNs]` suffix to a tool result string. The shape
 * of the returned content matches the input shape:
 *
 * - Plain string content → suffix is appended as `\n\n[duration: N.NNNs]`.
 * - JSON-serialized `ContentBlock[]` content → an additional `text`
 *   ContentBlock is appended to the array.
 *
 * Negative `elapsedMs` returns the input unchanged (defensive against
 * clock skew on the WS-deferred client tool path where elapsed is derived
 * from `now - dispatch_queue.created_at` across hosts).
 *
 * Call BEFORE `capToolResultContent` so the universal 256 KiB cap honors
 * the total budget; the middle-cut marker preserves the suffix in the tail.
 *
 * See bound-agents/bound#77.
 */
export function appendToolDuration(content: string, elapsedMs: number): string {
	if (elapsedMs < 0) return content;

	const seconds = (elapsedMs / 1000).toFixed(3);
	const suffix = `[duration: ${seconds}s]`;

	if (content.length > 0 && content[0] === "[") {
		try {
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				parsed.push({ type: "text", text: suffix });
				return JSON.stringify(parsed);
			}
		} catch {
			// Fall through — plain string starting with '[' but not valid JSON.
		}
	}

	return `${content}\n\n${suffix}`;
}

/**
 * Slice a string at a code-unit boundary without splitting surrogate pairs.
 * JavaScript strings are UTF-16; characters outside the BMP (emoji, CJK
 * Extension B, etc.) are stored as two code units (a surrogate pair).
 * A naive `.slice(0, n)` can cut between them, producing an orphaned
 * high surrogate that is invalid UTF-8 and therefore invalid JSON.
 */
export function safeSlice(str: string, start: number, end: number): string {
	// Clamp end to string length
	let clampedEnd = end > str.length ? str.length : end;

	// If the character just before `clampedEnd` is a high surrogate (U+D800–U+DBFF),
	// the character at `clampedEnd` would be its low surrogate — step back to keep
	// the pair intact (by excluding it) rather than splitting it.
	if (
		clampedEnd > start &&
		clampedEnd < str.length &&
		str.charCodeAt(clampedEnd - 1) >= 0xd800 &&
		str.charCodeAt(clampedEnd - 1) <= 0xdbff
	) {
		clampedEnd--;
	}

	return str.slice(start, clampedEnd);
}
