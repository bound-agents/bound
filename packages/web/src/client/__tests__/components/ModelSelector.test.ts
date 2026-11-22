import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

type Model = { id: string; host: string; via?: string; status?: string };

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

async function mount(models: Model[], defaultModel: string, props: Record<string, unknown> = {}) {
	dom = installDom();
	dom.route("GET", "/api/status/models", () => ({ models, default: defaultModel }));
	// Routing health is a separate best-effort fetch; default to empty so the
	// existing cases exercise the graceful-degrade path (every dot grey).
	if (!dom.requests.some((r) => r.path === "/api/routing/models")) {
		dom.route("GET", "/api/routing/models", () => ({ models: [] }));
	}
	const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
	const { modelStore } = await import("../../lib/modelStore");
	const mounted = await dom.mount(ModelSelector, props);
	await dom.settle();
	return { ...mounted, modelStore };
}

describe("ModelSelector", () => {
	it("loads models from the API and renders one option per model", async () => {
		const { target } = await mount(
			[
				{ id: "opus", host: "alpha" },
				{ id: "haiku", host: "beta" },
			],
			"opus",
		);
		expect(dom?.requests.some((r) => r.method === "GET" && r.path === "/api/status/models")).toBe(
			true,
		);
		const options = [...target.querySelectorAll("option")];
		expect(options.map((o) => o.textContent?.trim())).toEqual(["opus", "haiku"]);
		expect(options[0].getAttribute("value")).toBe("opus@alpha");
		expect(options[1].getAttribute("value")).toBe("haiku@beta");
	});

	it("selects the cluster default when no hint is given and sets the store", async () => {
		const { target, modelStore } = await mount(
			[
				{ id: "opus", host: "alpha" },
				{ id: "haiku", host: "beta" },
			],
			"haiku",
		);
		const select = target.querySelector("select") as HTMLSelectElement;
		expect(select.value).toBe("haiku@beta");
		expect(modelStore.getModel()).toBe("haiku");
	});

	it("honors a modelHint present at mount time", async () => {
		const { target, modelStore } = await mount(
			[
				{ id: "opus", host: "alpha" },
				{ id: "haiku", host: "beta" },
			],
			"opus",
			{ modelHint: "haiku" },
		);
		const select = target.querySelector("select") as HTMLSelectElement;
		expect(select.value).toBe("haiku@beta");
		expect(modelStore.getModel()).toBe("haiku");
	});

	it("applies a modelHint once models finish loading (late-model path)", async () => {
		// onMount sets `models` reactively after the component is already mounted
		// with the hint. The $effect that re-checks the hint against the freshly
		// loaded models is the path under test here (hint present, models arrive).
		dom = installDom();
		let resolveModels: ((v: unknown) => void) | null = null;
		dom.route(
			"GET",
			"/api/status/models",
			() =>
				new Promise((resolve) => {
					resolveModels = resolve;
				}),
		);
		const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
		const { modelStore } = await import("../../lib/modelStore");
		modelStore.setModel("");
		const { target } = await dom.mount(ModelSelector, { modelHint: "haiku" });
		// Models have not resolved yet: no options rendered, store untouched.
		expect(target.querySelectorAll("option").length).toBe(0);
		// Now the API resolves, populating `models` reactively.
		resolveModels?.({
			models: [
				{ id: "opus", host: "alpha" },
				{ id: "haiku", host: "beta" },
			],
			default: "opus",
		});
		await dom.settle();
		const select = target.querySelector("select") as HTMLSelectElement;
		expect(select.value).toBe("haiku@beta");
		expect(modelStore.getModel()).toBe("haiku");
	});

	it("falls back to the default label when the default has no matching entry", async () => {
		const { target, modelStore } = await mount([{ id: "opus", host: "alpha" }], "ghost-model");
		const select = target.querySelector("select") as HTMLSelectElement;
		// No option matches, so the select shows nothing selected, but the store
		// still carries the resolved id.
		expect(modelStore.getModel()).toBe("ghost-model");
		expect(select.querySelector("option")?.getAttribute("value")).toBe("opus@alpha");
	});

	it("marks relay models and shows an offline annotation", async () => {
		const { target } = await mount(
			[
				{ id: "opus", host: "alpha", via: "relay", status: "online" },
				{ id: "sol", host: "gamma", via: "relay", status: "offline?" },
			],
			"opus",
		);
		const options = [...target.querySelectorAll("option")];
		const relay = options.find((o) => o.textContent?.includes("via relay"));
		expect(relay?.textContent).toContain("alpha");
		expect(relay?.className).toContain("relay");
		const offline = options.find((o) => o.textContent?.includes("offline?"));
		expect(offline?.textContent).toContain("gamma");
		expect(offline?.className).toContain("stale");
	});

	it("updates the store on manual change and strips the @host suffix", async () => {
		const { target, modelStore } = await mount(
			[
				{ id: "opus", host: "alpha" },
				{ id: "haiku", host: "beta" },
			],
			"opus",
		);
		const select = target.querySelector("select") as HTMLSelectElement;
		select.value = "haiku@beta";
		select.dispatchEvent(new (globalThis as typeof window).Event("change", { bubbles: true }));
		await dom?.settle();
		expect(modelStore.getModel()).toBe("haiku");
	});

	it("surfaces no options and leaves the store untouched when the API fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/status/models", () => new Response("boom", { status: 500 }));
		const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
		const { modelStore } = await import("../../lib/modelStore");
		modelStore.setModel("");
		const { target } = await dom.mount(ModelSelector, {});
		await dom.settle();
		expect(target.querySelectorAll("option").length).toBe(0);
		expect(modelStore.getModel()).toBe("");
	});
});
