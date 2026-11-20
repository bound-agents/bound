import { describe, expect, it } from "bun:test";
import { formatMcpProvenance, formatProvenance } from "../tools/provenance";

describe("provenance formatting", () => {
	it("formatProvenance returns a text ContentBlock with correct format", () => {
		const hostname = "localhost";
		const cwd = "/home/user";
		const toolName = "boundless_read";

		const result = formatProvenance(hostname, cwd, toolName);

		expect(result).toEqual({
			type: "text",
			text: "[boundless] host=localhost cwd=/home/user tool=boundless_read",
		});
	});

	it("formatMcpProvenance returns a text ContentBlock with correct format", () => {
		const hostname = "myhost";
		const serverName = "github";
		const toolName = "list_repos";

		const result = formatMcpProvenance(hostname, serverName, toolName);

		expect(result).toEqual({
			type: "text",
			text: "[boundless:mcp] host=myhost server=github tool=list_repos",
		});
	});
});
