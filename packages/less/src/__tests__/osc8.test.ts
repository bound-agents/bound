import { describe, expect, it } from "bun:test";
import { linkifyPath, osc8Link, pathToFileUri, resolveFileHref } from "../tui/util/osc8";

const ESC = "\u001B";
const BEL = "\u0007";

describe("osc8Link", () => {
	it("wraps a label in the OSC 8 hyperlink envelope", () => {
		expect(osc8Link("file:///x/y.ts", "y.ts")).toBe(
			`${ESC}]8;;file:///x/y.ts${BEL}y.ts${ESC}]8;;${BEL}`,
		);
	});

	it("strips control bytes from the href so a malformed URI can't break out", () => {
		// A smuggled BEL/ESC would otherwise terminate the OSC string early and
		// leak the rest as live terminal control.
		const linked = osc8Link(`file:///x${BEL}${ESC}]0;pwned`, "y.ts");
		// Exactly two BELs (the two envelope terminators), no interior one.
		expect(linked.split(BEL).length - 1).toBe(2);
		expect(linked).not.toContain(`x${BEL}`);
	});

	it("leaves the visible label untouched", () => {
		// The label is what string-width measures; it must survive verbatim.
		const linked = osc8Link("file:///a", "packages/less/x.ts");
		expect(linked).toContain("packages/less/x.ts");
	});
});

describe("pathToFileUri", () => {
	it("builds a file:// URI from an absolute path", () => {
		expect(pathToFileUri("/Users/me/x.ts")).toBe("file:///Users/me/x.ts");
	});

	it("percent-encodes reserved characters per segment, keeping separators literal", () => {
		expect(pathToFileUri("/Users/me/my notes.md")).toBe("file:///Users/me/my%20notes.md");
	});

	it("returns null for a non-absolute path (no anchor)", () => {
		expect(pathToFileUri("packages/x.ts")).toBeNull();
	});
});

describe("resolveFileHref", () => {
	it("passes absolute paths straight through", () => {
		expect(resolveFileHref("/a/b.ts")).toBe("file:///a/b.ts");
	});

	it("joins a relative path onto cwd", () => {
		expect(resolveFileHref("packages/less/x.ts", "/repo")).toBe("file:///repo/packages/less/x.ts");
	});

	it("tolerates a trailing slash on cwd", () => {
		expect(resolveFileHref("x.ts", "/repo/")).toBe("file:///repo/x.ts");
	});

	it("returns null for a relative path with no usable cwd", () => {
		expect(resolveFileHref("x.ts")).toBeNull();
		expect(resolveFileHref("x.ts", "relative-cwd")).toBeNull();
	});
});

describe("linkifyPath", () => {
	it("linkifies a resolvable path with the label as the visible text", () => {
		const out = linkifyPath("~/x.ts", "/Users/me/x.ts");
		expect(out).toBe(osc8Link("file:///Users/me/x.ts", "~/x.ts"));
	});

	it("returns the plain label when no absolute path can be formed", () => {
		expect(linkifyPath("x.ts", "x.ts")).toBe("x.ts");
		expect(linkifyPath("x.ts", null)).toBe("x.ts");
		expect(linkifyPath("x.ts", undefined)).toBe("x.ts");
	});
});
