export class ModelStore {
	private activeModel = "";

	setModel(model: string): void {
		this.activeModel = model;
	}

	getModel(): string {
		return this.activeModel;
	}
}

export const modelStore = new ModelStore();
