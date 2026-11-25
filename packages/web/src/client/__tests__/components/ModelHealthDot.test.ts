import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ModelHealthDot: the three-state route-health dot (2026-11-21-model-routing.md
// §9.1). Green/amber/grey map to healthy/fallback/none; an unobservable remote
// route renders grey with an honest "unknown" label rather than a fake verdict.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountDot(props: Record<string, unknown>) {
	const ModelHealthDot = (await import("../../components/ModelHealthDot.svelte")).default;
	return dom.mount(ModelHealthDot, props);
}

describe("ModelHealthDot", () => {
	it("renders green for a healthy preferred route", async () => {
		const { target } = await mountDot({ state: "healthy" });
		const dot = target.querySelector(".health-dot") as HTMLElement;
		expect(dot.getAttribute("style")).toContain("--dot: var(--ok)");
		expect(dot.getAttribute("aria-label")).toBe("Healthy");
	});

	it("renders amber and pulses for a fallback route", async () => {
		const { target } = await mountDot({ state: "fallback" });
		const dot = target.querySelector(".health-dot") as HTMLElement;
		expect(dot.getAttribute("style")).toContain("--dot: var(--warn)");
		expect(dot.className).toContain("fallback");
	});

	it("renders grey for no eligible route", async () => {
		const { target } = await mountDot({ state: "none" });
		const dot = target.querySelector(".health-dot") as HTMLElement;
		expect(dot.getAttribute("style")).toContain("--dot: var(--idle)");
		expect(dot.getAttribute("aria-label")).toBe("No route available");
	});

	it("defaults to an honest unknown state for an unobservable route", async () => {
		const { target } = await mountDot({});
		const dot = target.querySelector(".health-dot") as HTMLElement;
		expect(dot.getAttribute("style")).toContain("--dot: var(--idle)");
		expect(dot.getAttribute("aria-label")).toBe("Status unknown on this host");
	});

	it("prefers an explicit title over the mapped label", async () => {
		const { target } = await mountDot({ state: "healthy", title: "via hub / Bedrock" });
		const dot = target.querySelector(".health-dot") as HTMLElement;
		expect(dot.getAttribute("title")).toBe("via hub / Bedrock");
	});
});
