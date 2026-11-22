import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ThreadModelChip: the thread header chip (2026-11-21-model-routing.md §9.1).
// Shows the logical model; appends a quiet `· via host / provider` suffix off
// the preferred route; renders a lock indicator for a hard route pin.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountChip(props: Record<string, unknown>) {
	const ThreadModelChip = (await import("../../components/ThreadModelChip.svelte")).default;
	return dom.mount(ThreadModelChip, props);
}

describe("ThreadModelChip", () => {
	it("shows only the model name on the preferred route", async () => {
		const { target } = await mountChip({ model: "gpt-5.6-sol" });
		expect(target.querySelector(".name")?.textContent).toBe("gpt-5.6-sol");
		expect(target.querySelector(".via")).toBeNull();
	});

	it("appends a via suffix when running off the preferred route", async () => {
		const { target } = await mountChip({
			model: "gpt-5.6-sol",
			viaHost: "MSI",
			viaProvider: "Codex",
		});
		const via = target.querySelector(".via");
		expect(via?.textContent).toContain("MSI / Codex");
	});

	it("renders a lock indicator for a hard route pin", async () => {
		const { target } = await mountChip({ model: "opus-4.8", pinned: true });
		const chip = target.querySelector(".chip") as HTMLElement;
		expect(chip.className).toContain("pinned");
		// The lucide Lock renders an <svg>.
		expect(chip.querySelector("svg")).not.toBeNull();
	});
});
