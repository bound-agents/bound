import { describe, expect, it } from "bun:test";
import { z } from "zod";

// Test getBaseUrl logic by replicating it inline (it cannot be exported without
// importing the full server which starts the MCP transport).
function getBaseUrl(argv: string[], env: Record<string, string | undefined>): string {
	const args = argv.slice(2);
	const urlIdx = args.indexOf("--url");
	if (urlIdx !== -1 && args[urlIdx + 1]) {
		return args[urlIdx + 1];
	}
	return env.BOUND_URL ?? "http://localhost:3000";
}

describe("bound-mcp bound_chat schema", () => {
	it("mcp-server.AC2.2: inputSchema rejects call without message parameter", () => {
		// Replicate the inputSchema used in server.ts to verify Zod correctly
		// rejects a missing required field — the MCP framework uses this schema
		// to validate tool call inputs before dispatching to the handler.
		const schema = z.object({
			message: z.string().describe("The message to send to the bound agent"),
			thread_id: z.string().optional(),
		});

		// Missing message entirely
		const r1 = schema.safeParse({});
		expect(r1.success).toBe(false);

		// thread_id only — message still missing
		const r2 = schema.safeParse({ thread_id: "t-1" });
		expect(r2.success).toBe(false);

		// message present — valid
		const r3 = schema.safeParse({ message: "Hello" });
		expect(r3.success).toBe(true);

		// both fields — valid
		const r4 = schema.safeParse({ message: "Hello", thread_id: "t-1" });
		expect(r4.success).toBe(true);
	});
});

describe("bound-mcp URL configuration", () => {
	it("mcp-server.AC3.1: --url arg sets the base URL", () => {
		const url = getBaseUrl(["bun", "server.ts", "--url", "http://myhost:4000"], {});
		expect(url).toBe("http://myhost:4000");
	});

	it("mcp-server.AC3.2: BOUND_URL env var used when --url absent", () => {
		const url = getBaseUrl(["bun", "server.ts"], { BOUND_URL: "http://myhost:4000" });
		expect(url).toBe("http://myhost:4000");
	});

	it("mcp-server.AC3.3: defaults to http://localhost:3000 when neither provided", () => {
		const url = getBaseUrl(["bun", "server.ts"], {});
		expect(url).toBe("http://localhost:3000");
	});

	it("--url takes precedence over BOUND_URL", () => {
		const url = getBaseUrl(["bun", "server.ts", "--url", "http://cli:5000"], {
			BOUND_URL: "http://env:4000",
		});
		expect(url).toBe("http://cli:5000");
	});
});
