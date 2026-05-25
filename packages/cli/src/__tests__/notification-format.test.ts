import { describe, expect, it } from "bun:test";
import { formatNotification } from "../commands/start/server";

describe("formatNotification", () => {
	it("formats proactive notifications from background tasks", () => {
		const result = formatNotification({
			type: "proactive",
			source_thread: "thread-123",
			content: "goose deep read completed",
		});
		// Per F2c (notification provenance): proactive payloads carry
		// agent-authored free-text from a sibling thread. The render
		// prefix must include a "background task" framing AND a
		// provenance marker that flags the content as unverified, so
		// the receiving agent doesn't read its sibling's narrative as
		// authoritative system state.
		expect(result).toContain("[notification from background task");
		expect(result).toContain("goose deep read completed");
		// Provenance signal — see notification-provenance.test.ts for
		// the full assertion against the marker set.
		expect(result.toLowerCase()).toContain("unverified");
	});

	it("handles proactive notification with empty content", () => {
		const result = formatNotification({
			type: "proactive",
			source_thread: "thread-123",
		});
		// Even with empty content, the provenance-marked prefix renders.
		// Just trim trailing whitespace from the empty content tail.
		expect(result).toContain("[notification from background task");
		expect(result).toContain("unverified");
	});

	it("formats task_complete notifications", () => {
		const result = formatNotification({
			type: "task_complete",
			task_name: "daily-summary",
			result: "3 items processed",
		});
		expect(result).toContain("daily-summary");
		expect(result).toContain("3 items processed");
	});

	it("formats introspect notifications with source thread", () => {
		const result = formatNotification({
			type: "introspect",
			source_thread: "thread-abc",
			content: "What do you think?",
		});
		// Same provenance contract as proactive — introspect content
		// is also agent-authored from a sibling thread.
		expect(result).toContain("[introspect request from thread thread-abc");
		expect(result).toContain("What do you think?");
		expect(result.toLowerCase()).toContain("unverified");
	});

	it("formats unknown notification types as JSON", () => {
		const result = formatNotification({
			type: "custom_thing",
			data: "hello",
		});
		expect(result).toContain("[notification]");
		expect(result).toContain("custom_thing");
	});
});
