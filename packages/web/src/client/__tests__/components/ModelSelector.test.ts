import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

type Model = {
	id: string;
	logical_model?: string;
	display_name?: string;
	host: string;
	via?: string;
	status?: string;
};

type Routing = {
	logical_model: string;
	display_name: string | null;
	routes: Array<{
		route_id: string;
		host_name: string;
		provider: string | null;
		health: string;
		drained: boolean;
	}>;
};

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

async function mount(
	models: Model[],
	defaultModel: string,
	props: Record<string, unknown> = {},
	routing: Routing[] = [],
) {
	dom = installDom();
	dom.route("GET", "/api/status/models", () => ({ models, default: defaultModel }));
	dom.route("GET", "/api/routing/models", () => ({ models: routing }));
	const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
	const { modelStore } = await import("../../lib/modelStore");
	const mounted = await dom.mount(ModelSelector, props);
	await dom.settle();
	return { ...mounted, modelStore };
}

const route = (id: string, host: string, provider: string) => ({
	route_id: id,
	host_name: host,
	provider,
	health: "healthy",
	drained: false,
});

// Two hosts expose the same logical model through different expanded backends.
const expanded: Model[] = [
	{
		id: "zai-glm-5.3-flash",
		logical_model: "glm-5-3-flash",
		display_name: "GLM-5.3 Flash",
		host: "msi",
	},
	{
		id: "copilot-glm-5.3-flash",
		logical_model: "glm-5-3-flash",
		display_name: "GLM-5.3 Flash",
		host: "mac",
	},
	{ id: "opencode-go-kimi-k3", logical_model: "kimi-k3", display_name: "Kimi K3", host: "msi" },
];
const expandedRouting: Routing[] = [
	{
		logical_model: "glm-5-3-flash",
		display_name: "GLM-5.3 Flash",
		routes: [route("r1", "msi", "zai"), route("r2", "mac", "copilot")],
	},
	{
		logical_model: "kimi-k3",
		display_name: "Kimi K3",
		routes: [route("r3", "msi", "opencode-go")],
	},
];
const backendIds = expanded.map((m) => m.id);

describe("ModelSelector", () => {
	it("collapses expanded backends on two hosts to one option per logical model, labelled by display name", async () => {
		const { target } = await mount(expanded, "kimi-k3", {}, expandedRouting);
		const options = [...target.querySelectorAll("#model option")];
		expect(options.map((o) => o.textContent?.trim())).toEqual(["GLM-5.3 Flash", "Kimi K3"]);
		expect(options.map((o) => o.getAttribute("value"))).toEqual(["glm-5-3-flash", "kimi-k3"]);
		for (const o of options) expect(backendIds).not.toContain(o.textContent?.trim());
	});

	it("falls back to /models display names, deduped by logical model, without the routing API", async () => {
		const { target } = await mount(expanded, "kimi-k3");
		const options = [...target.querySelectorAll("#model option")];
		expect(options.map((o) => o.textContent?.trim())).toEqual(["GLM-5.3 Flash", "Kimi K3"]);
	});

	it("never labels an option with a backend id when no display name exists", async () => {
		const { target } = await mount(
			[
				{
					id: "bedrock-main-openai.gpt-6.1-sol",
					logical_model: "gpt-6-1-sol",
					display_name: "bedrock-main-openai.gpt-6.1-sol",
					host: "a",
				},
			],
			"",
		);
		expect(target.querySelector("#model option")?.textContent?.trim()).toBe("gpt-6-1-sol");
	});

	it("maps a backend-id default to its logical option", async () => {
		const { target, modelStore } = await mount(expanded, "zai-glm-5.3-flash", {}, expandedRouting);
		const select = target.querySelector("#model") as HTMLSelectElement;
		expect(select.value).toBe("glm-5-3-flash");
		expect(modelStore.getModel()).toBe("glm-5-3-flash");
	});

	it("honors a backend-id modelHint present at mount time", async () => {
		const { target, modelStore } = await mount(
			expanded,
			"zai-glm-5.3-flash",
			{ modelHint: "opencode-go-kimi-k3" },
			expandedRouting,
		);
		expect((target.querySelector("#model") as HTMLSelectElement).value).toBe("kimi-k3");
		expect(modelStore.getModel()).toBe("kimi-k3");
	});

	it("applies a modelHint once models finish loading (late-model path)", async () => {
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
		dom.route("GET", "/api/routing/models", () => ({ models: [] }));
		const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
		const { modelStore } = await import("../../lib/modelStore");
		modelStore.setModel("");
		const { target } = await dom.mount(ModelSelector, { modelHint: "kimi-k3" });
		expect(target.querySelectorAll("option").length).toBe(0);
		resolveModels?.({ models: expanded, default: "zai-glm-5.3-flash" });
		await dom.settle();
		expect((target.querySelector("#model") as HTMLSelectElement).value).toBe("kimi-k3");
		expect(modelStore.getModel()).toBe("kimi-k3");
	});

	it("keeps an unknown default in the store", async () => {
		const { modelStore } = await mount([{ id: "opus", host: "alpha" }], "ghost-model");
		expect(modelStore.getModel()).toBe("ghost-model");
	});

	it("sends the logical id on manual change and lists that model's routes under Advanced", async () => {
		const { target, modelStore } = await mount(expanded, "kimi-k3", {}, expandedRouting);
		const select = target.querySelector("#model") as HTMLSelectElement;
		select.value = "glm-5-3-flash";
		select.dispatchEvent(new (globalThis as typeof window).Event("change", { bubbles: true }));
		await dom?.settle();
		expect(modelStore.getModel()).toBe("glm-5-3-flash");
		const pins = [...target.querySelectorAll('select[aria-label="Hard route pin"] option')].map(
			(o) => o.textContent?.trim(),
		);
		expect(pins).toEqual(["Auto (no pin)", "msi / zai", "mac / copilot"]);
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
