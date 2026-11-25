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
			display_name: "GPT-5.6 Sol",
			route_order: ["site-hub:codex:sol", "site-msi:codex:sol"],
			fallback_policy: { mode: "auto" },
			routes: [
				{
					route_id: "site-hub:codex:sol",
					display_name: "GPT-5.6 Sol",
					site_id: "site-hub",
					host_name: "hub",
					provider: "codex",
					provider_model_id: "sol",
					drained: false,
					health: "healthy",
					next_trial_at: null,
				},
				{
					route_id: "site-msi:codex:sol",
					display_name: "GPT-5.6 Sol",
					site_id: "site-msi",
					host_name: "MSI",
					provider: "codex",
					provider_model_id: "sol",
					drained: true,
					health: "unknown",
					next_trial_at: null,
				},
			],
			stale_routes: [{ route_id: "dead:codex:sol", host_name: "old-host", provider: "codex" }],
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

const click = (el: Element | null | undefined) =>
	el?.dispatchEvent(new (globalThis as typeof window).Event("click", { bubbles: true }));

describe("SettingsModelsView", () => {
	it("lists models by display name with a health dot and route/host counts, never a backend id", async () => {
		const { target } = await mount();
		const item = target.querySelector(".model-item");
		expect(item?.textContent).toContain("GPT-5.6 Sol");
		expect(item?.textContent).toContain("2 routes · 2 hosts");
		expect(item?.querySelector(".health-dot")).not.toBeNull();
	}, 30_000);

	it("sorts case-insensitively across providers and filters by search", async () => {
		const mk = (id: string, name: string) => ({
			...(MODELS.models[0] as RoutingModelsResponse["models"][number]),
			logical_model: id,
			display_name: name,
		});
		const { target } = await mount({
			models: [mk("z", "zeta"), mk("a", "Alpha"), mk("b", "beta")],
		});
		const names = () => [...target.querySelectorAll(".model-item .name")].map((n) => n.textContent);
		expect(names()).toEqual(["Alpha", "beta", "zeta"]);
		const search = target.querySelector(".search") as HTMLInputElement;
		search.value = "ET";
		search.dispatchEvent(new (globalThis as typeof window).Event("input", { bubbles: true }));
		await dom?.settle();
		expect(names()).toEqual(["beta", "zeta"]);
	});

	it("shows routes as provider:model on host with an Enabled toggle mapped to drains", async () => {
		const { target } = await mount();
		(globalThis as unknown as { window: { prompt: () => string } }).window.prompt = () => "";
		const rows = [...target.querySelectorAll(".route-row:not(.stale)")];
		expect(rows[0]?.textContent).toContain("codex:sol");
		expect(rows[0]?.textContent).toContain("on hub");
		expect(rows[0]?.textContent).toContain("Healthy");
		const toggles = rows.map((r) => r.querySelector('input[role="switch"]') as HTMLInputElement);
		expect(toggles.map((t) => t.checked)).toEqual([true, false]);
		let drained = "";
		let undrained = "";
		dom?.route("POST", /\/api\/routing\/routes\/.*\/drain/, (req) => {
			drained = decodeURIComponent(req.url);
			return { ok: true };
		});
		dom?.route("DELETE", /\/api\/routing\/routes\/.*\/drain/, (req) => {
			undrained = decodeURIComponent(req.url);
			return { ok: true };
		});
		(toggles[0] as HTMLInputElement).checked = false;
		toggles[0]?.dispatchEvent(new (globalThis as typeof window).Event("change", { bubbles: true }));
		await dom?.settle();
		expect(drained).toContain("site-hub:codex:sol");
		(toggles[1] as HTMLInputElement).checked = true;
		toggles[1]?.dispatchEvent(new (globalThis as typeof window).Event("change", { bubbles: true }));
		await dom?.settle();
		expect(undrained).toContain("site-msi:codex:sol");
	});

	it("shows backoff read-only as a retry countdown", async () => {
		const m = structuredClone(MODELS);
		const r = m.models[0]?.routes[0];
		if (r) {
			r.health = "backoff";
			r.next_trial_at = Date.now() + 4 * 60_000;
		}
		const { target } = await mount(m);
		expect(target.querySelector(".route-row")?.textContent).toContain(
			"Backing off, retrying in 4m",
		);
	});

	it("surfaces a stale route_order entry with a Remove action", async () => {
		const { target } = await mount();
		const stale = target.querySelector(".route-row.stale");
		expect(stale?.textContent).toContain("old-host / codex");
		expect(stale?.textContent).not.toContain("dead:codex:sol");
		expect(
			[...target.querySelectorAll("button")].some((b) => b.textContent?.includes("Remove")),
		).toBe(true);
	});

	it("reorders routes by sending the new route_order", async () => {
		const { target } = await mount();
		let putBody: unknown = null;
		dom?.route("PUT", /\/api\/routing\/models\/.*\/route-order/, (req) => {
			putBody = req.body;
			return { ok: true };
		});
		click(target.querySelectorAll('button[aria-label="Move up"]')[1]);
		await dom?.settle();
		expect((putBody as { route_order: string[] }).route_order).toEqual([
			"site-msi:codex:sol",
			"site-hub:codex:sol",
		]);
	});

	it("round-trips roles and custom aliases through PUT /cluster-defaults", async () => {
		const { target } = await mount(MODELS, {
			...DEFAULTS,
			roles: { default: "gpt-5.6-sol", coder: "gpt-5.6-sol" },
		});
		const rows = [...target.querySelectorAll(".role-row")];
		expect(
			rows.map((r) => r.querySelector(".role-name, .role-name-input")?.textContent ?? ""),
		).toHaveLength(4);
		expect((rows[3]?.querySelector(".role-name-input") as HTMLInputElement).value).toBe("coder");
		let putBody: unknown = null;
		dom?.route("PUT", "/api/routing/cluster-defaults", (req) => {
			putBody = req.body;
			return { ok: true };
		});
		click([...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save"));
		await dom?.settle();
		expect((putBody as { roles: Record<string, string> }).roles).toEqual({
			default: "gpt-5.6-sol",
			coder: "gpt-5.6-sol",
		});
	});

	it("marks a dangling role unavailable with a Clear action, and saves after clearing", async () => {
		const { target } = await mount(MODELS, { ...DEFAULTS, roles: { ghost: "nope" } });
		let putBody: unknown = null;
		dom?.route("PUT", "/api/routing/cluster-defaults", (req) => {
			putBody = req.body;
			return { ok: true };
		});
		expect(target.querySelector(".roles")?.textContent).toContain("nope (unavailable)");
		click([...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear"));
		await dom?.settle();
		click([...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save"));
		await dom?.settle();
		expect(JSON.stringify(putBody)).not.toContain("nope");
	});

	it("re-reads route health on its refresh tick, not only the countdown clock", async () => {
		const ticks: Array<() => void> = [];
		const realSetInterval = globalThis.setInterval;
		globalThis.setInterval = ((fn: () => void, ms?: number) => {
			if (ms === 30_000) ticks.push(fn);
			return realSetInterval(() => {}, 1 << 30);
		}) as typeof setInterval;
		try {
			const live = structuredClone(MODELS);
			live.models[0].routes[1].drained = false;
			const { target } = await mount(live);
			const msiText = () =>
				[...target.querySelectorAll(".route-row")]
					.find((row) => row.textContent?.includes("on MSI"))
					?.querySelector(".r-health")?.textContent;
			expect(msiText()).toBe("Unknown");
			const recovered = structuredClone(live);
			const msi = recovered.models[0].routes[1];
			msi.health = "healthy";
			msi.health_source = "remote";
			dom?.route("GET", "/api/routing/models", () => recovered);
			expect(ticks.length).toBe(1);
			ticks[0]();
			await dom?.settle();
			expect(msiText()).toBe("Healthy");
		} finally {
			globalThis.setInterval = realSetInterval;
		}
	});

	it("shows an error message when the API fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/routing/models", () => new Response("boom", { status: 500 }));
		dom.route("GET", "/api/routing/cluster-defaults", () => DEFAULTS);
		const SettingsModelsView = (await import("../../views/SettingsModelsView.svelte")).default;
		const { target } = await dom.mount(SettingsModelsView, {});
		await dom.settle();
		expect(target.querySelector("[role=alert]")).not.toBeNull();
	});
});
