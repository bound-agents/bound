import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// RouteFailoverNotice: the single thread-level notice shown after a route fails
// repeatedly on one thread (2026-11-21-model-routing.md §9.2). Per-turn failover
// stays silent; this notice names the failing route, the failure run, and the
// route now serving.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountNotice(props: Record<string, unknown>) {
	const RouteFailoverNotice = (await import("../../components/RouteFailoverNotice.svelte")).default;
	return dom.mount(RouteFailoverNotice, props);
}

describe("RouteFailoverNotice", () => {
	it("states the failing route, the run, and the serving route", async () => {
		const { target } = await mountNotice({
			failedRoute: "MSI / Codex",
			failedCount: 4,
			windowSize: 5,
			servingRoute: "hub / Bedrock",
		});
		const text = target.querySelector(".text")?.textContent ?? "";
		expect(text).toContain("MSI / Codex failed 4 of the last 5 turns");
		expect(text).toContain("using hub / Bedrock");
	});
});
