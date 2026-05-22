import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { tildifyPath, tildifyText } from "../tui/util/path";

const HOME = homedir();

describe("tildifyPath", () => {
	it("replaces $HOME with ~", () => {
		expect(tildifyPath(`${HOME}/Documents/foo`)).toBe("~/Documents/foo");
	});

	it("returns ~ for an exact $HOME match", () => {
		expect(tildifyPath(HOME)).toBe("~");
	});

	it("leaves unrelated absolute paths untouched", () => {
		expect(tildifyPath("/etc/hosts")).toBe("/etc/hosts");
		expect(tildifyPath("/var/log/system.log")).toBe("/var/log/system.log");
	});

	it("does not match when prefix is similar but not followed by /", () => {
		// e.g. /Users/user-other should NOT become ~-other
		const sibling = `${HOME}-other`;
		expect(tildifyPath(sibling)).toBe(sibling);
	});

	it("preserves relative paths", () => {
		expect(tildifyPath("packages/less")).toBe("packages/less");
	});
});

describe("tildifyText", () => {
	it("replaces every $HOME/ inside freeform text", () => {
		const input = `Wrote 1234 bytes to ${HOME}/foo.ts and ${HOME}/bar.ts`;
		expect(tildifyText(input)).toBe("Wrote 1234 bytes to ~/foo.ts and ~/bar.ts");
	});

	it("leaves text without $HOME/ untouched", () => {
		expect(tildifyText("hello world")).toBe("hello world");
		expect(tildifyText("Error: ENOENT: /tmp/missing")).toBe("Error: ENOENT: /tmp/missing");
	});

	it("does not mangle look-alike substrings (no trailing slash)", () => {
		// Must not produce ~-other or ~Extra from these.
		const input = `${HOME}-other and ${HOME}Extra and ${HOME}`;
		expect(tildifyText(input)).toBe(input);
	});

	it("handles repeated occurrences", () => {
		const input = `a ${HOME}/x b ${HOME}/y c ${HOME}/z`;
		expect(tildifyText(input)).toBe("a ~/x b ~/y c ~/z");
	});

	it("returns the original string when no replacement is needed (fast path)", () => {
		const input = "no home prefix here";
		expect(tildifyText(input)).toBe(input);
	});
});
