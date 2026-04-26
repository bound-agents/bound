import { describe, expect, it } from "bun:test";
import { isUserFacingInterface } from "../server";

describe("isUserFacingInterface", () => {
	it("returns true for web", () => {
		expect(isUserFacingInterface("web")).toBe(true);
	});

	it("returns true for boundless", () => {
		expect(isUserFacingInterface("boundless")).toBe(true);
	});

	it("returns true for discord", () => {
		expect(isUserFacingInterface("discord")).toBe(true);
	});

	it("returns true for discord-interaction", () => {
		expect(isUserFacingInterface("discord-interaction")).toBe(true);
	});

	it("returns false for scheduler", () => {
		expect(isUserFacingInterface("scheduler")).toBe(false);
	});

	it("returns false for mcp", () => {
		expect(isUserFacingInterface("mcp")).toBe(false);
	});

	it("returns false for null/undefined/empty", () => {
		expect(isUserFacingInterface(null)).toBe(false);
		expect(isUserFacingInterface(undefined)).toBe(false);
		expect(isUserFacingInterface("")).toBe(false);
	});
});
