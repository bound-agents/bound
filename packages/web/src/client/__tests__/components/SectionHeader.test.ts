import { afterAll, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// SectionHeader: a page header with a title, optional zero-padded number
// kicker, optional subtitle, and an optional actions snippet. These tests
// assert the title always renders, the number is zero-padded, the kicker only
// appears when number or subtitle is present, and the actions snippet renders.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountHeader(props: Record<string, unknown>) {
	const SectionHeader = (await import("../../components/SectionHeader.svelte")).default;
	return dom.mount(SectionHeader, props);
}

describe("SectionHeader", () => {
	it("renders the title and nothing else when only title is given", async () => {
		const { target } = await mountHeader({ title: "Timetable" });
		expect(target.querySelector(".title")?.textContent).toBe("Timetable");
		expect(target.querySelector(".kicker")).toBeNull();
		expect(target.querySelector(".actions")).toBeNull();
	});

	it("zero-pads the number into a Nº kicker", async () => {
		const { target } = await mountHeader({ title: "Lines", number: 3 });
		expect(target.querySelector(".number")?.textContent).toBe("Nº03");
	});

	it("renders a two-digit number without extra padding", async () => {
		const { target } = await mountHeader({ title: "Lines", number: 42 });
		expect(target.querySelector(".number")?.textContent).toBe("Nº42");
	});

	it("renders the subtitle in the kicker", async () => {
		const { target } = await mountHeader({ title: "Lines", subtitle: "network" });
		expect(target.querySelector(".kicker")).not.toBeNull();
		expect(target.querySelector(".subtitle")?.textContent).toBe("network");
		expect(target.querySelector(".number")).toBeNull();
	});

	it("renders the actions snippet", async () => {
		const { target } = await mountHeader({
			title: "Lines",
			actions: createRawSnippet(() => ({ render: () => "<button>Refresh</button>" })),
		});
		const actions = target.querySelector(".actions");
		expect(actions).not.toBeNull();
		expect(actions?.textContent).toContain("Refresh");
	});
});
