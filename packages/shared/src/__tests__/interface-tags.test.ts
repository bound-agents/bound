import { describe, expect, it } from "bun:test";
import {
	CLIENT_TOOL_INTERFACES,
	NON_USER_FACING_INTERFACES,
	isClientToolInterface,
	isUserFacingInterface,
} from "../interface-tags";

describe("isUserFacingInterface", () => {
	it("returns true for user-facing surfaces", () => {
		expect(isUserFacingInterface("web")).toBe(true);
		expect(isUserFacingInterface("boundless")).toBe(true);
		expect(isUserFacingInterface("discord")).toBe(true);
		expect(isUserFacingInterface("discord-interaction")).toBe(true);
	});

	it("returns false for every system-driven tag", () => {
		for (const tag of NON_USER_FACING_INTERFACES) {
			expect(isUserFacingInterface(tag)).toBe(false);
		}
	});

	it("returns false for null, undefined, and empty string", () => {
		expect(isUserFacingInterface(null)).toBe(false);
		expect(isUserFacingInterface(undefined)).toBe(false);
		expect(isUserFacingInterface("")).toBe(false);
	});
});

describe("isClientToolInterface", () => {
	it("returns true only for client-session surfaces", () => {
		for (const tag of CLIENT_TOOL_INTERFACES) {
			expect(isClientToolInterface(tag)).toBe(true);
		}
		expect(isClientToolInterface("boundless")).toBe(true);
	});

	it("returns false for non-client surfaces", () => {
		expect(isClientToolInterface("web")).toBe(false);
		expect(isClientToolInterface("scheduler")).toBe(false);
		expect(isClientToolInterface("webhook")).toBe(false);
		expect(isClientToolInterface("discord")).toBe(false);
	});

	it("returns false for null, undefined, and empty string", () => {
		expect(isClientToolInterface(null)).toBe(false);
		expect(isClientToolInterface(undefined)).toBe(false);
		expect(isClientToolInterface("")).toBe(false);
	});
});
