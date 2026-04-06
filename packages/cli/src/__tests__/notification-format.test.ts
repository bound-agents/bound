import { describe, expect, it } from "bun:test";
import { formatNotification } from "../commands/start/server";

describe("formatNotification", () => {
	it("formats proactive notifications from background tasks", () => {
		const result = formatNotification({
			type: "proactive",
			source_thread: "thread-123",
			content: "goose deep read completed",
		});
		expect(result).toBe("[notification from background task] goose deep read completed");
	});

	it("handles proactive notification with empty content", () => {
		const result = formatNotification({
			type: "proactive",
			source_thread: "thread-123",
		});
		expect(result).toBe("[notification from background task]");
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

	it("formats unknown notification types as JSON", () => {
		const result = formatNotification({
			type: "custom_thing",
			data: "hello",
		});
		expect(result).toContain("[notification]");
		expect(result).toContain("custom_thing");
	});
});
