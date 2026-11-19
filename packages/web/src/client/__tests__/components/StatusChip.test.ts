import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// StatusChip: a status dot + label. The label and dot color come from a status
// map, `label` overrides the mapped text, and the pulse animation is gated on
// both `animate` and the status's own `pulse` flag. These tests assert the
// rendered label, the --dot-color / --dot-size style vars, and the `animate`
// class.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountChip(props: Record<string, unknown>) {
	const StatusChip = (await import("../../components/StatusChip.svelte")).default;
	return dom.mount(StatusChip, props);
}

describe("StatusChip", () => {
	it("renders the mapped label and color for a known status", async () => {
		const { target } = await mountChip({ status: "running" });
		const chip = target.querySelector(".status-chip") as HTMLElement;
		expect(chip.querySelector(".label")?.textContent).toBe("Running");
		const style = chip.getAttribute("style") ?? "";
		expect(style).toContain("--dot-color: var(--ok)");
	});

	it("prefers an explicit label over the mapped one", async () => {
		const { target } = await mountChip({ status: "completed", label: "All done" });
		expect(target.querySelector(".label")?.textContent).toBe("All done");
	});

	it("falls back to the raw status string for an unknown status", async () => {
		const { target } = await mountChip({ status: "weird-state" });
		const chip = target.querySelector(".status-chip") as HTMLElement;
		expect(chip.querySelector(".label")?.textContent).toBe("weird-state");
		expect(chip.getAttribute("style")).toContain("--dot-color: var(--idle)");
	});

	it("applies the animate class only when animate and the status pulses", async () => {
		const pulsing = await mountChip({ status: "active", animate: true });
		expect((pulsing.target.querySelector(".status-chip") as HTMLElement).classList).toContain(
			"animate",
		);

		const suppressed = await mountChip({ status: "active", animate: false });
		expect(
			(suppressed.target.querySelector(".status-chip") as HTMLElement).classList,
		).not.toContain("animate");

		// A non-pulsing status never animates even with animate=true.
		const nonPulse = await mountChip({ status: "completed", animate: true });
		expect((nonPulse.target.querySelector(".status-chip") as HTMLElement).classList).not.toContain(
			"animate",
		);
	});

	it("scales the dot size for the large variant", async () => {
		const sm = await mountChip({ status: "idle", size: "sm" });
		expect(
			(sm.target.querySelector(".status-chip") as HTMLElement).getAttribute("style"),
		).toContain("--dot-size: 7px");
		const lg = await mountChip({ status: "idle", size: "lg" });
		expect(
			(lg.target.querySelector(".status-chip") as HTMLElement).getAttribute("style"),
		).toContain("--dot-size: 8px");
	});
});
