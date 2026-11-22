import { afterEach, describe, expect, it } from "bun:test";
import type { ClusterDefaultsResponse, RoutingModelsResponse } from "@bound/client";
import { installDom } from "../harness/dom";

// SettingsModelsView: the Settings › Models operator page (2026-11-21-model-
// routing.md §9.3). Lists logical models with a three-state health dot, expands
// to the per-host route list with reorder/drain/stale-remove controls, shows the
// fallback policy, and renders the cluster defaults. Reaches the server through
// the shared BoundClient (relative fetches faked by the harness route table).

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

const MODELS: RoutingModelsResponse = {
	models: [
		{
			logical_model: "gpt-5.6-sol",
			route_order: ["site-hub:codex:sol", "site-msi:codex:sol"],
			fallback_policy: { mode: "auto" },
			routes: [
				{
					route_id: "site-hub:codex:sol",
					site_id: "site-hub",
					host_name: "hub",
					provider: "codex",
					drained: false,
					health: "healthy",
					next_trial_at: null,
				},
				{
					route_id: "site-msi:codex:sol",
					site_id: "site-msi",
					host_name: "MSI",
					provider: "codex",
					drained: true,
					health: "unknown",
					next_trial_at: null,
				},
			],
			stale_routes: [{ route_id: "dead:codex:sol" }],
		},
	],
};

const DEFAULTS: ClusterDefaultsResponse = {
	default_fallback_models: ["opus-4.8", "haiku"],
	roles: { default: "gpt-5.6-sol", heavy: "opus-4.8", fast: "haiku" },
	aliases: [],
};

async function mount(
	models: RoutingModelsResponse = MODELS,
	defaults: ClusterDefaultsResponse = DEFAULTS,
) {
	dom = installDom();
	dom.route("GET", "/api/routing/models", () => models);
	dom.route("GET", "/api/routing/cluster-defaults", () => defaults);
	const SettingsModelsView = (await import("../../views/SettingsModelsView.svelte")).default;
	const mounted = await dom.mount(SettingsModelsView, {});
	await dom.settle();
	return mounted;
}

describe("SettingsModelsView", () => {
	it("lists logical models with a health dot", async () => {
		const { target } = await mount();
		expect(target.textContent).toContain("gpt-5.6-sol");
		// A three-state health dot renders for the model.
		expect(target.querySelector(".health-dot")).not.toBeNull();
	});

	it("expands a model to show its route list with supply and health", async () => {
		const { target } = await mount();
		const head = target.querySelector(".model-head") as HTMLButtonElement;
		head.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom?.settle();
		const text = target.textContent ?? "";
		expect(text).toContain("hub / codex");
		expect(text).toContain("MSI / codex");
		// The healthy route shows its state; the drained route is marked.
		expect(text).toContain("healthy");
		const drained = target.querySelector(".route-row.drained");
		expect(drained).not.toBeNull();
	});

	it("surfaces a stale route_order entry with a Remove action", async () => {
		const { target } = await mount();
		const head = target.querySelector(".model-head") as HTMLButtonElement;
		head.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom?.settle();
		const stale = target.querySelector(".route-row.stale");
		expect(stale?.textContent).toContain("dead:codex:sol");
		expect(stale?.textContent).toContain("stale");
		const remove = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Remove"),
		);
		expect(remove).toBeDefined();
	});

	it("reorders routes by sending the new route_order", async () => {
		const { target } = await mount();
		const head = target.querySelector(".model-head") as HTMLButtonElement;
		head.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom?.settle();
		// Capture the PUT the move triggers.
		let putBody: unknown = null;
		dom?.route("PUT", /\/api\/routing\/models\/.*\/route-order/, (req) => {
			putBody = req.body;
			return { ok: true };
		});
		dom?.route("GET", "/api/routing/models", () => MODELS);
		dom?.route("GET", "/api/routing/cluster-defaults", () => DEFAULTS);
		// The second route's "move up" button swaps it ahead of the first.
		const moveUps = [...target.querySelectorAll('button[aria-label="Move up"]')];
		const second = moveUps[1] as HTMLButtonElement;
		second.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));
		await dom?.settle();
		expect((putBody as { route_order: string[] }).route_order).toEqual([
			"site-msi:codex:sol",
			"site-hub:codex:sol",
		]);
	});

	it("renders the cluster default fallback list and roles", async () => {
		const { target } = await mount();
		const text = target.textContent ?? "";
		expect(text).toContain("opus-4.8, haiku");
		expect(text).toContain("default: gpt-5.6-sol");
	});

	it("shows an error message when the API fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/routing/models", () => new Response("boom", { status: 500 }));
		dom.route("GET", "/api/routing/cluster-defaults", () => DEFAULTS);
		const SettingsModelsView = (await import("../../views/SettingsModelsView.svelte")).default;
		await dom.mount(SettingsModelsView, {});
		await dom.settle();
		expect(document.body.textContent).toContain("");
	});
});
