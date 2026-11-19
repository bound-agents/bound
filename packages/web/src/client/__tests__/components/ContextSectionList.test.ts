import { afterAll, describe, expect, it } from "bun:test";
import ContextSectionList from "../../components/ContextSectionList.svelte";
import { installDom } from "../harness/dom";

// One shared dom for the whole file (ThreadList-style). Re-running installDom()
// per test leaves the previously torn-down jsdom window's prototypes dangling
// in the cached svelte module, which crashes a later dynamic mount inside an
// InfoPopover child with `get_descriptors(proto)` null. A single long-lived
// window sidesteps that; each mount gets its own fresh target element.
const dom = installDom();
afterAll(() => dom.teardown());

type Section = { name: string; tokens: number; children?: Array<{ name: string; tokens: number }> };

async function mount(props: {
	sections: Section[];
	contextWindow: number;
	actualTotalTokens?: number;
}) {
	const mounted = await dom.mount(ContextSectionList, props);
	await dom.settle();
	return mounted;
}

describe("ContextSectionList", () => {
	it("renders one row per section with token count and percentage", async () => {
		const { target } = await mount({
			sections: [
				{ name: "system", tokens: 50_000 },
				{ name: "history", tokens: 50_000 },
			],
			contextWindow: 200_000,
		});
		const rows = [...target.querySelectorAll(".section-row")];
		// 2 section rows + a free-space row (free = 100k).
		const names = rows.map((r) => r.querySelector(".name")?.textContent).filter(Boolean);
		expect(names).toContain("system");
		expect(names).toContain("history");
		const tokens = [...target.querySelectorAll(".tokens")].map((t) => t.textContent);
		expect(tokens).toContain("50,000");
		// 50k / 200k = 25.0%
		const pcts = [...target.querySelectorAll(".pct")].map((p) => p.textContent);
		expect(pcts).toContain("25.0%");
	});

	it("renders a free-space row for the unused budget", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 100_000,
		});
		const names = [...target.querySelectorAll(".name")].map((n) => n.textContent);
		expect(names).toContain("free space");
		// free = 60k → 60.0%
		expect([...target.querySelectorAll(".pct")].map((p) => p.textContent)).toContain("60.0%");
	});

	it("marks sections with children expandable and toggles child rows on click", async () => {
		const { target } = await mount({
			sections: [
				{
					name: "custom-group",
					tokens: 30_000,
					children: [
						{ name: "user", tokens: 10_000 },
						{ name: "assistant", tokens: 20_000 },
					],
				},
			],
			contextWindow: 100_000,
		});
		const lead = target.querySelector(".section-lead.clickable") as HTMLElement;
		expect(lead).not.toBeNull();
		// Collapsed initially: no child rows.
		expect(target.querySelector(".section-row.child")).toBeNull();
		await dom?.fire(lead, "click");
		const childNames = [...target.querySelectorAll(".section-row.child .name")].map(
			(n) => n.textContent,
		);
		expect(childNames).toContain("user");
		expect(childNames).toContain("assistant");
		// Chevron is marked expanded.
		expect(target.querySelector(".chevron.expanded")).not.toBeNull();
		// Toggle back collapses them.
		await dom?.fire(lead, "click");
		expect(target.querySelector(".section-row.child")).toBeNull();
	});

	it("expands via Enter and Space keys", async () => {
		const { target } = await mount({
			sections: [{ name: "history", tokens: 30_000, children: [{ name: "user", tokens: 10_000 }] }],
			contextWindow: 100_000,
		});
		const lead = target.querySelector(".section-lead.clickable") as HTMLElement;
		await dom?.fire(lead, "keydown", { key: "Enter" });
		expect(target.querySelector(".section-row.child")).not.toBeNull();
		await dom?.fire(lead, "keydown", { key: " " });
		expect(target.querySelector(".section-row.child")).toBeNull();
	});

	it("ignores keys other than Enter/Space on an expandable row", async () => {
		const { target } = await mount({
			sections: [{ name: "history", tokens: 30_000, children: [{ name: "user", tokens: 10_000 }] }],
			contextWindow: 100_000,
		});
		const lead = target.querySelector(".section-lead.clickable") as HTMLElement;
		await dom?.fire(lead, "keydown", { key: "x" });
		expect(target.querySelector(".section-row.child")).toBeNull();
	});

	it("non-expandable sections are not clickable", async () => {
		const { target } = await mount({
			sections: [{ name: "tools", tokens: 5000 }],
			contextWindow: 100_000,
		});
		expect(target.querySelector(".section-lead.clickable")).toBeNull();
	});

	it("renders an estimator-drift row when actualTotalTokens exceeds the estimate", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			actualTotalTokens: 60_000,
		});
		const names = [...target.querySelectorAll(".name")].map((n) => n.textContent);
		expect(names).toContain("estimator drift");
		// drift = 60k - 40k = 20k → 10.0% of 200k
		expect(target.querySelector(".drift-dot")).not.toBeNull();
	});

	it("drives free space from the actual total when provided (no drift when estimate runs high)", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 80_000 }],
			contextWindow: 100_000,
			actualTotalTokens: 50_000,
		});
		// used = actual 50k, free = 50k → 50.0%; no drift row (actual < estimate).
		const names = [...target.querySelectorAll(".name")].map((n) => n.textContent);
		expect(names).not.toContain("estimator drift");
		expect(names).toContain("free space");
		expect([...target.querySelectorAll(".pct")].map((p) => p.textContent)).toContain("50.0%");
	});

	it("handles a zero context window without dividing by zero", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 100 }],
			contextWindow: 0,
		});
		// pct math guards contextWindow > 0 → 0.0%; no free-space row (free = 0).
		expect([...target.querySelectorAll(".pct")].map((p) => p.textContent)).toContain("0.0%");
	});

	it("surfaces a known section's info popover trigger", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 100_000,
		});
		// `system` has a SECTION_INFO entry → rendered inside an InfoPopover trigger.
		const systemName = [...target.querySelectorAll(".name")].find(
			(n) => n.textContent === "system",
		);
		expect(systemName).not.toBeUndefined();
	});
});
