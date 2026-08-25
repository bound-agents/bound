import { describe, expect, it } from "bun:test";
import { acquireSummaryBackendWithFallback } from "../agent-loop-utils";

describe("summary backend fallback (#204)", () => {
	it("tries the turn model before default and remaining models", () => {
		const attempts: string[] = [];
		const backend = {} as never;
		expect(
			acquireSummaryBackendWithFallback("turn", "default", ["other"], (id) => {
				attempts.push(id);
				return id === "turn" ? backend : null;
			}),
		).toBe(backend);
		expect(attempts).toEqual(["turn"]);
	});
});
