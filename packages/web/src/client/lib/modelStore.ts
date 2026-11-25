type Subscriber = (model: string) => void;

/**
 * The model the operator selected in the picker. Implements the Svelte store
 * contract (`subscribe` returns an unsubscribe), so components can react to a
 * switch immediately via `$modelStore` or an explicit subscription.
 */
export class ModelStore {
	private activeModel = "";
	private subscribers = new Set<Subscriber>();

	setModel(model: string): void {
		if (model === this.activeModel) return;
		this.activeModel = model;
		for (const fn of this.subscribers) fn(model);
	}

	getModel(): string {
		return this.activeModel;
	}

	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);
		fn(this.activeModel);
		return () => {
			this.subscribers.delete(fn);
		};
	}
}

export const modelStore = new ModelStore();
