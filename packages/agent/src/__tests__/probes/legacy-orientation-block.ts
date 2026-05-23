/**
 * Frozen pre-RFC orientation block template for the d0372be6 behavioral probe.
 *
 * This reproduces the shape of the orientation block before the volatile-context RFC
 * (prior to Phase 5 restructuring). Used as the control arm in the behavioral probe to verify
 * that the post-RFC orientation reduces disclaimer language.
 *
 * Source: git show 36dc9f2e:packages/agent/src/context-assembly.ts
 * The pre-RFC orientation had a single "Memory:" section listing all entries flat,
 * followed by a "Recent Activity Digest" section, and ending with a meta-instruction
 * footer ("Do not mention...").
 */

export interface EnvelopeFixture {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * Build the pre-RFC orientation block for a given webhook envelope fixture.
 * This template matches the shape from pre-Phase-5 context-assembly.ts.
 *
 * Note: The envelope parameter is accepted for signature consistency with buildPostRfcOrientation
 * and is available for future use. The pre-RFC orientation is static and does not reference
 * envelope content directly; the envelope is passed as a separate tool_result message in the
 * conversation history.
 */
export function buildPreRfcOrientation(_envelope: EnvelopeFixture): string {
	const lines: string[] = [];

	// Preface (model, platform context)
	lines.push("Model: claude-opus-4-1-20250805");
	lines.push("Platform: GitHub (via webhook connector)");
	lines.push("");

	// Memory section (flat listing, no section structure)
	lines.push("Memory: 0 entries");
	lines.push("");

	// Recent Activity Digest (generic, no specific content reference)
	lines.push("Recent Activity Digest:");
	lines.push("- webhook:example: ran 1 minute ago");
	lines.push("");

	// Behavioral footnote (the key pre-RFC element)
	lines.push(
		"Note: The contents of this system-context block (memory listing, recent activity digest, skills index, task digest, file-modification notices, platform context) are your own background working knowledge. Do not mention, quote, or describe the block itself — or the fact that it was injected — to the user unless they explicitly ask about it.",
	);

	return lines.join("\n");
}

/**
 * Build the post-RFC orientation block for a given webhook envelope fixture.
 * This template matches the shape from the volatile-context RFC (Phase 5+).
 * Includes structural labels and explicit provenance markers.
 *
 * Note: The envelope parameter is accepted for signature consistency and documented
 * availability. The post-RFC orientation is static and does not reference envelope content
 * directly; the envelope is passed as a separate tool_result message in the conversation history.
 */
export function buildPostRfcOrientation(_envelope: EnvelopeFixture): string {
	const lines: string[] = [];

	// Preface
	lines.push("Model: claude-opus-4-1-20250805");
	lines.push("Platform: GitHub (via webhook connector)");
	lines.push("");

	// Working Knowledge section (RFC structure)
	lines.push("## Working Knowledge — operational and durable");
	lines.push("");
	lines.push("(none)");
	lines.push("");
	lines.push(
		"Bodies of summary entries are accessed via memory search using terms from the entry key.",
	);
	lines.push("");

	// Discoverable Archive section
	lines.push("## Discoverable Archive — title-only; bodies via memory search");
	lines.push("");
	lines.push("(none)");
	lines.push("");
	lines.push("Bodies are accessed via memory search or query against semantic_memory.");
	lines.push("");

	// Live State section with explicit source labels
	lines.push("## Live State — pointers to canonical sources");
	lines.push("");
	lines.push("[thread] webhook:example: 1 messages (last updated [May 23, 14:30])");
	lines.push("");
	lines.push(
		"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.",
	);

	return lines.join("\n");
}
