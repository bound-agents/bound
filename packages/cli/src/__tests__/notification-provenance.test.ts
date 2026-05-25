/**
 * Cross-thread notification provenance marker (Class D, sub-mechanism F2c).
 *
 * The `notify` and introspect-style tools accept agent-authored
 * free-text content from a sibling thread. `enqueueNotification`
 * persists the payload into `dispatch_queue`; on dispatch claim,
 * `resolveDelegationMessageId` calls `formatNotification` to render
 * the payload as a `role='developer'` message that gets inserted
 * into the target thread's history. The bridge then wraps developer
 * messages in `<system-context>...</system-context>`, so the agent
 * on the receiving thread reads the agent-authored text as
 * authoritative system context.
 *
 * Live evidence (`_feedback:correction:misdiagnosis_from_secondary_summary_20260517`):
 * the agent saw a system-context summary with the phrase "byte-
 * different content + 1 notify fallback" and built a full dedup
 * fix in commit ae81ff1 (dispatch_queue dedup_key + 14 tests)
 * BEFORE Kara said "that wasn't the problem at all" — at which
 * point checking the source thread immediately revealed the real
 * failure was in `ai-sdk-bridge.ts toModelMessages` dev-flush
 * logic, fully unrelated to dedup. The agent's filing explicitly
 * says: "Apply pinned _feedback:correction:compaction_summary_not_ground_truth
 * to error-context summaries too — not just compaction summaries."
 *
 * The fix shape is the same as D2 (purge-summary provenance): the
 * rendered notification text must flag the content as agent-
 * authored from a sibling thread so the receiving agent reads it
 * as a past assertion to verify against ground truth (source
 * thread's tool_result rows / messages table) rather than as
 * authoritative system state.
 *
 * The test asserts on the presence of provenance signals; the
 * exact wording is left open so future tuning of the prefix
 * doesn't have to break the test.
 */
import { describe, expect, it } from "bun:test";
import { formatNotification } from "../commands/start/server";

describe("notification provenance marker", () => {
	it("flags proactive notification content as agent-authored on render", () => {
		// A confabulated agent-authored cross-thread summary, mirroring
		// the d0372be6 / 2026-05-17 "byte-different content + 1 notify
		// fallback" framing that primed the wrong fix shape.
		const payload = {
			type: "proactive",
			source_thread: "abc-123",
			content:
				"three semantically-identical fix-up requests; no dedup. byte-different content + 1 notify fallback observed.",
		};
		const text = formatNotification(payload);

		// Sanity: original content still surfaces — context isn't lost.
		expect(text).toContain("byte-different content");

		// The F2c invariant: rendered notification carries a provenance
		// signal that flags the content as agent-authored / unverified
		// so the receiving agent reads it as a past assertion to verify
		// rather than as authoritative system state. Today this fails
		// because the prefix is just "[notification from background task]"
		// with no agent-authored / verify framing.
		const provenanceMarkers = ["agent-authored", "your prior", "unverified", "verify"];
		const lower = text.toLowerCase();
		const hasProvenance = provenanceMarkers.some((m) => lower.includes(m.toLowerCase()));
		expect(hasProvenance).toBe(true);
	});

	it("flags introspect request content as agent-authored on render", () => {
		// Introspect requests follow the same shape — a sibling thread's
		// agent dictates free-text content that lands as system-context
		// on the receiving thread.
		const payload = {
			type: "introspect",
			source_thread: "xyz-456",
			content: "Diff has 295 files; this looks like a runaway commit",
		};
		const text = formatNotification(payload);

		expect(text).toContain("295 files");

		const provenanceMarkers = ["agent-authored", "your prior", "unverified", "verify"];
		const lower = text.toLowerCase();
		const hasProvenance = provenanceMarkers.some((m) => lower.includes(m.toLowerCase()));
		expect(hasProvenance).toBe(true);
	});
});
