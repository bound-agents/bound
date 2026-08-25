import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { tildifyPath, tildifyPathFrom, tildifyText, tildifyTextFrom } from "../tui/util/path";

const HOME = homedir();
const WIN_HOME = "C:\\Users\\alice";

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

describe("tildifyPathFrom (Windows-style paths)", () => {
	it("collapses a backslash-separated home prefix", () => {
		expect(tildifyPathFrom(WIN_HOME, "C:\\Users\\alice\\Documents\\foo")).toBe("~\\Documents\\foo");
	});

	it("returns ~ for an exact Windows home match", () => {
		expect(tildifyPathFrom(WIN_HOME, WIN_HOME)).toBe("~");
	});

	it("leaves unrelated Windows absolute paths untouched", () => {
		expect(tildifyPathFrom(WIN_HOME, "C:\\Windows\\System32")).toBe("C:\\Windows\\System32");
		expect(tildifyPathFrom(WIN_HOME, "D:\\data\\log.txt")).toBe("D:\\data\\log.txt");
	});

	it("does not match a sibling whose name extends the home dir", () => {
		expect(tildifyPathFrom(WIN_HOME, "C:\\Users\\alice-other\\x")).toBe(
			"C:\\Users\\alice-other\\x",
		);
		expect(tildifyPathFrom(WIN_HOME, "C:\\Users\\aliceExtra")).toBe("C:\\Users\\aliceExtra");
	});

	it("still works when a Windows host emits forward slashes", () => {
		expect(tildifyPathFrom(WIN_HOME, "C:\\Users\\alice/Documents/foo")).toBe("~/Documents/foo");
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

describe("tildifyTextFrom (Windows-style paths)", () => {
	it("replaces every backslash-separated home prefix", () => {
		const input = "Wrote 1234 bytes to C:\\Users\\alice\\foo.ts and C:\\Users\\alice\\bar.ts";
		expect(tildifyTextFrom(WIN_HOME, input)).toBe("Wrote 1234 bytes to ~\\foo.ts and ~\\bar.ts");
	});

	it("does not mangle look-alike substrings (no trailing separator)", () => {
		const input = `${WIN_HOME}-other and ${WIN_HOME}Extra and ${WIN_HOME}`;
		expect(tildifyTextFrom(WIN_HOME, input)).toBe(input);
	});

	it("handles forward slashes emitted on a Windows host", () => {
		const input = "see C:\\Users\\alice/Documents/foo for details";
		expect(tildifyTextFrom(WIN_HOME, input)).toBe("see ~/Documents/foo for details");
	});

	it("does not treat regex metacharacters in the home dir as a pattern", () => {
		// A drive-letter home is full of regex-significant chars (`\`, and the
		// path itself); escaping must be literal.
		expect(tildifyTextFrom(WIN_HOME, "x C:\\Users\\alice\\y z")).toBe("x ~\\y z");
	});
});
