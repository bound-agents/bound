import { describe, expect, it } from "bun:test";
import { buildOffloadMessage } from "../offload";

describe("buildOffloadMessage", () => {
	it("names the tool, the original length, and the destination path", () => {
		const msg = buildOffloadMessage("/tmp/offload-abc.txt", 73_212, "boundless_bash");
		expect(msg).toContain('[Tool result offloaded: 73212 characters from "boundless_bash"]');
		expect(msg).toContain("saved to: /tmp/offload-abc.txt");
	});

	it("includes actionable read/filter hints referencing the same path", () => {
		const path = "/vfs/results/run-9.log";
		const msg = buildOffloadMessage(path, 100_000, "query");
		expect(msg).toContain(`cat ${path} | head -100`);
		expect(msg).toContain(`cat ${path} | grep "pattern"`);
		expect(msg).toContain(`wc -l ${path}`);
	});

	it("renders the length verbatim without separators", () => {
		const msg = buildOffloadMessage("/tmp/x", 1_000_000, "read");
		expect(msg).toContain("1000000 characters");
	});
});
