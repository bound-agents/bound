import { describe, expect, it } from "bun:test";
import { shouldClearWaiting } from "../client/utils/waiting";

describe("shouldClearWaiting", () => {
	it("clears waiting when an assistant message arrives", () => {
		expect(shouldClearWaiting("assistant")).toBe(true);
	});

	it("clears waiting when an alert message arrives", () => {
		expect(shouldClearWaiting("alert")).toBe(true);
	});

	it("does not clear waiting for user messages", () => {
		expect(shouldClearWaiting("user")).toBe(false);
	});

	it("does not clear waiting for tool messages", () => {
		expect(shouldClearWaiting("tool")).toBe(false);
	});
});
