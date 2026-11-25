import { describe, expect, it } from "bun:test";
import { ModelStore, modelStore } from "../modelStore";

describe("ModelStore", () => {
	it("starts with an empty active model", () => {
		expect(new ModelStore().getModel()).toBe("");
	});

	it("round-trips the model set through setModel", () => {
		const store = new ModelStore();
		store.setModel("opus-4.8");
		expect(store.getModel()).toBe("opus-4.8");
	});

	it("overwrites a previously set model", () => {
		const store = new ModelStore();
		store.setModel("gpt-5.5");
		store.setModel("glm-5");
		expect(store.getModel()).toBe("glm-5");
	});

	it("exposes a shared singleton instance", () => {
		expect(modelStore).toBeInstanceOf(ModelStore);
		// Record and restore so the shared singleton isn't left mutated for
		// any other test that reads it.
		const prior = modelStore.getModel();
		try {
			modelStore.setModel("kimi-k3.1");
			expect(modelStore.getModel()).toBe("kimi-k3.1");
		} finally {
			modelStore.setModel(prior);
		}
	});

	it("notifies subscribers immediately and on every change until unsubscribed", () => {
		const store = new ModelStore();
		const seen: string[] = [];
		const off = store.subscribe((m) => seen.push(m));
		store.setModel("gpt-6-astra");
		store.setModel("gpt-6-astra");
		off();
		store.setModel("glm-5");
		expect(seen).toEqual(["", "gpt-6-astra"]);
	});
});
