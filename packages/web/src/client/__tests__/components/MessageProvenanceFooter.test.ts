import { afterAll, describe, expect, it } from "bun:test";
import type { TurnProvenanceInfo } from "@bound/client";
import { installDom } from "../harness/dom";

// MessageProvenanceFooter: the per-turn footer (2026-11-21-model-routing.md
// §9.1). Collapsed, it names the serving model and route. Expanded (only when a
// turn ran more than one attempt), it lists every attempt with cost — including
// discarded refusals and failed route trials.

const dom = installDom();
afterAll(() => dom.teardown());

async function mountFooter(turn: TurnProvenanceInfo) {
	const MessageProvenanceFooter = (await import("../../components/MessageProvenanceFooter.svelte"))
		.default;
	return dom.mount(MessageProvenanceFooter, { turn });
}

function makeTurn(over: Partial<TurnProvenanceInfo> = {}): TurnProvenanceInfo {
	return {
		id: "t1",
		created_at: "2026-01-01T00:00:00.000Z",
		model_id: "gpt-5.6-sol",
		route_id: "site-hub:codex:sol",
		substituted_from: null,
		status: "ok",
		cost_usd: 0.5,
		attempts: null,
		...over,
	};
}

describe("MessageProvenanceFooter", () => {
	it("names the serving model and its route when collapsed", async () => {
		const { target } = await mountFooter(makeTurn());
		expect(target.querySelector(".model")?.textContent).toBe("gpt-5.6-sol");
		expect(target.querySelector(".route")?.textContent).toContain("codex / sol");
	});

	it("shows a substitution marker when the turn substituted a model", async () => {
		const { target } = await mountFooter(makeTurn({ substituted_from: "opus-4.8" }));
		expect(target.querySelector(".subst")?.textContent).toContain("opus-4.8");
	});

	it("does not render an attempts list for a single-attempt turn", async () => {
		const { target } = await mountFooter(makeTurn({ attempts: null }));
		expect(target.querySelector(".attempts")).toBeNull();
		expect(target.querySelector(".caret")).toBeNull();
	});

	it("expands to list every attempt, including a discarded refusal", async () => {
		const { target } = await mountFooter(
			makeTurn({
				model_id: "gpt-5.6-sol",
				substituted_from: "opus-4.8",
				attempts: [
					{
						model_id: "opus-4.8",
						route_id: "site-hub:anthropic:opus",
						outcome: "refusal",
						refusal_category: "safety",
						credit_redeemed: false,
						cost_usd: 0.01,
					},
					{
						model_id: "gpt-5.6-sol",
						route_id: "site-hub:codex:sol",
						outcome: "ok",
						refusal_category: null,
						credit_redeemed: false,
						cost_usd: 0.4,
					},
				],
			}),
		);
		const summary = target.querySelector(".summary") as HTMLButtonElement;
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		summary.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom.settle();
		const attempts = [...target.querySelectorAll(".attempt")];
		expect(attempts).toHaveLength(2);
		// The refused attempt is present and labeled.
		const refused = attempts.find((a) => a.className.includes("refused"));
		expect(refused?.textContent).toContain("safety");
		expect(refused?.textContent).toContain("refused");
	});
});
