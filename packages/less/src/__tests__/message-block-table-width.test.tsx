import { describe, expect, it } from "bun:test";
import { messageFixture, renderMessageBlock } from "./tui-message-fixtures";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR escapes is the point
const stripSgr = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, "");

describe("MessageBlock — markdown tables fit the stripe (#275)", () => {
	it("wraps a wide table inside the agent card instead of overflowing it", () => {
		const content = [
			"| Issue | Summary |",
			"| --- | --- |",
			"| #275 | markdown tables ignore the remaining card width and wrap columns prematurely |",
		].join("\n");
		const message = messageFixture({ id: "m1", role: "assistant", content });
		const { lastFrame } = renderMessageBlock(message, { terminalColumns: 40 });
		const lines = stripSgr(lastFrame() ?? "")
			.split("\n")
			.map((l) => l.replace(/\s+$/, ""));
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(39);
		const joined = lines.join(" ");
		expect(joined).toContain("#275");
		expect(joined).toContain("prematurely");
	});
});
