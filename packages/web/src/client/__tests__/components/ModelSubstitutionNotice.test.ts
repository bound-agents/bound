import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ModelSubstitutionNotice: the inline notice shown when a refusal substitutes
// another model (2026-11-21-model-routing.md §9.2). It names the category (when
// known), the substitute, and offers a one-click "Try <original> again". A
// non-substitutable refusal carries the category and explanation with no retry.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountNotice(props: Record<string, unknown>) {
	const ModelSubstitutionNotice = (await import("../../components/ModelSubstitutionNotice.svelte"))
		.default;
	return dom.mount(ModelSubstitutionNotice, props);
}

describe("ModelSubstitutionNotice", () => {
	it("names the category, substitute, and a retry action on substitution", async () => {
		let retried = false;
		const { target } = await mountNotice({
			original: "opus-4.8",
			substitute: "gpt-5.6-sol",
			category: "safety",
			onRetry: () => {
				retried = true;
			},
		});
		const text = target.textContent ?? "";
		expect(text).toContain("safety");
		expect(text).toContain("gpt-5.6-sol");
		const retry = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Try opus-4.8 again"),
		);
		expect(retry).toBeDefined();
		retry?.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom.settle();
		expect(retried).toBe(true);
	});

	it("shows the category and explanation with no retry for a non-substitutable refusal", async () => {
		const { target } = await mountNotice({
			original: "opus-4.8",
			substitute: null,
			category: "reasoning_extraction",
			explanation: "The request could not be answered.",
		});
		const text = target.textContent ?? "";
		expect(text).toContain("reasoning_extraction");
		expect(target.querySelector(".explanation")?.textContent).toContain("could not be answered");
		// No substitute → no retry button.
		const retry = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Try"),
		);
		expect(retry).toBeUndefined();
	});
});
