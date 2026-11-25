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
		provider_model_id?: string | null;
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

const win = () => globalThis as unknown as typeof window;
async function openList(target: Element): Promise<Element[]> {
	(target.querySelector("#model") as HTMLButtonElement).click();
	await dom?.settle();
	return [...target.querySelectorAll('[role="option"]')];
}
function key(target: Element, k: string): void {
	target
		.querySelector("#model")
		?.dispatchEvent(new (win().KeyboardEvent)("keydown", { key: k, bubbles: true }));
}
const selectedValue = (target: Element) =>
	target.querySelector("#model")?.getAttribute("data-value");
const labelText = (o: Element) => o.querySelector(".option-label")?.textContent?.trim();

describe("ModelSelector", () => {
	it("collapses expanded backends on two hosts to one option per logical model, labelled by display name", async () => {
		const { target } = await mount(expanded, "kimi-k3", {}, expandedRouting);
		const options = await openList(target);
		expect(options.map(labelText)).toEqual(["GLM-5.3 Flash", "Kimi K3"]);
		expect(options.map((o) => o.getAttribute("data-value"))).toEqual(["glm-5-3-flash", "kimi-k3"]);
		for (const o of options) expect(backendIds).not.toContain(labelText(o));
	});

	it("falls back to /models display names, deduped by logical model, without the routing API", async () => {
		const { target } = await mount(expanded, "kimi-k3");
		const options = await openList(target);
		expect(options.map(labelText)).toEqual(["GLM-5.3 Flash", "Kimi K3"]);
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
		expect(labelText((await openList(target))[0] as Element)).toBe("gpt-6-1-sol");
	});

	it("maps a backend-id default to its logical option", async () => {
		const { target, modelStore } = await mount(expanded, "zai-glm-5.3-flash", {}, expandedRouting);
		expect(selectedValue(target)).toBe("glm-5-3-flash");
		expect(modelStore.getModel()).toBe("glm-5-3-flash");
	});

	it("honors a backend-id modelHint present at mount time", async () => {
		const { target, modelStore } = await mount(
			expanded,
			"zai-glm-5.3-flash",
			{ modelHint: "opencode-go-kimi-k3" },
			expandedRouting,
		);
		expect(selectedValue(target)).toBe("kimi-k3");
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
		expect(target.querySelectorAll('[role="option"]').length).toBe(0);
		resolveModels?.({ models: expanded, default: "zai-glm-5.3-flash" });
		await dom.settle();
		expect(selectedValue(target)).toBe("kimi-k3");
		expect(modelStore.getModel()).toBe("kimi-k3");
	});

	it("keeps an unknown default in the store", async () => {
		const { modelStore } = await mount([{ id: "opus", host: "alpha" }], "ghost-model");
		expect(modelStore.getModel()).toBe("ghost-model");
	});

	it("selects by click, sends the logical id, and pins a route from the popover", async () => {
		const { target, modelStore } = await mount(expanded, "kimi-k3", {}, expandedRouting);
		const options = await openList(target);
		(options[0] as HTMLElement).click();
		await dom?.settle();
		expect(modelStore.getModel()).toBe("glm-5-3-flash");
		expect(target.querySelector('[role="listbox"]')).toBeNull();
		await openList(target);
		const pins = [...target.querySelectorAll('[aria-label="Route pin"] .pin-choice')];
		expect(pins.map((p) => p.textContent?.trim())).toEqual([
			"Auto",
			"zai:r1 on msi",
			"copilot:r2 on mac",
		]);
		expect(pins[0]?.getAttribute("aria-pressed")).toBe("true");
		(pins[2] as HTMLElement).click();
		await dom?.settle();
		expect(target.querySelector("#model")?.classList.contains("pinned")).toBe(true);
		expect(target.querySelector("#model .pin-badge")).not.toBeNull();
	});

	it("navigates with the keyboard: arrows, Home/End, type-ahead, Enter, Escape", async () => {
		const { target, modelStore } = await mount(
			[...expanded, { id: "a-model", logical_model: "alpha", display_name: "alpha", host: "msi" }],
			"kimi-k3",
		);
		key(target, "ArrowDown");
		await dom?.settle();
		expect(target.querySelector('[role="listbox"]')).not.toBeNull();
		// Case-insensitive alphabetical: alpha, GLM-5.3 Flash, Kimi K3.
		expect([...target.querySelectorAll('[role="option"]')].map(labelText)).toEqual([
			"alpha",
			"GLM-5.3 Flash",
			"Kimi K3",
		]);
		const active = () => target.querySelector(".option.active .option-label")?.textContent?.trim();
		expect(active()).toBe("Kimi K3");
		key(target, "Home");
		await dom?.settle();
		expect(active()).toBe("alpha");
		key(target, "ArrowDown");
		await dom?.settle();
		expect(active()).toBe("GLM-5.3 Flash");
		key(target, "End");
		await dom?.settle();
		expect(active()).toBe("Kimi K3");
		key(target, "a");
		await dom?.settle();
		expect(active()).toBe("alpha");
		key(target, "Enter");
		await dom?.settle();
		expect(modelStore.getModel()).toBe("alpha");
		key(target, "ArrowDown");
		await dom?.settle();
		key(target, "Escape");
		await dom?.settle();
		expect(target.querySelector('[role="listbox"]')).toBeNull();
		expect(modelStore.getModel()).toBe("alpha");
	});

	it("lists a model's routes with health when hovering its health dot", async () => {
		const routing: Routing[] = [
			{
				logical_model: "glm-5-3-flash",
				display_name: "GLM-5.3 Flash",
				routes: [
					{
						...route("site-msi:zai:zai-glm-5.3-flash", "msi", "zai"),
						provider_model_id: "glm-5.3-flash",
					},
					{
						...route("site-mac:copilot:copilot-glm-5.3-flash", "mac", "copilot"),
						health: "backoff",
						drained: true,
					},
				],
			},
		];
		const { target } = await mount(expanded, "kimi-k3", {}, routing);
		const options = await openList(target);
		const dot = options[0]?.querySelector(".dot-wrap") as HTMLElement;
		dot.dispatchEvent(new (win().MouseEvent)("mouseenter"));
		await dom?.settle();
		const lines = [...target.querySelectorAll(".route-tip .route-line")].map((l) =>
			l.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(lines).toEqual([
			"zai:glm-5.3-flash on msi Healthy",
			"copilot:glm-5.3-flash on mac Disabled",
		]);
	});

	it("renders the popover out of flow so opening never resizes the input wrapper", async () => {
		const { target } = await mount(expanded, "kimi-k3", {}, expandedRouting);
		const root = target.querySelector(".model-selector") as HTMLElement;
		const before = root.children.length;
		await openList(target);
		const pop = target.querySelector(".popover") as HTMLElement;
		expect(pop.parentElement).toBe(root);
		expect(root.children.length).toBe(before + 1);
		// The popover is the only added child and is absolutely positioned (CSS).
		expect(root.querySelectorAll(":scope > :not(.popover)").length).toBe(before);
	});
	it("surfaces no options and leaves the store untouched when the API fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/status/models", () => new Response("boom", { status: 500 }));
		const ModelSelector = (await import("../../components/ModelSelector.svelte")).default;
		const { modelStore } = await import("../../lib/modelStore");
		modelStore.setModel("");
		const { target } = await dom.mount(ModelSelector, {});
		await dom.settle();
		expect(target.querySelectorAll('[role="option"]').length).toBe(0);
		expect(modelStore.getModel()).toBe("");
	});
});
