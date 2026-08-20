import { describe, expect, it } from "bun:test";

import { waitFor } from "./wait-helpers.js";

describe("waitFor", () => {
	it("reports the last observed state when the condition times out", async () => {
		await expect(
			waitFor({
				description: "a completed row pull",
				timeoutMs: 5,
				observe: () => ({ received: 1, complete: false }),
				isReady: () => false,
			}),
		).rejects.toThrow(
			'Timed out waiting for a completed row pull after 5ms; observed: {"received":1,"complete":false}',
		);
	});
});
