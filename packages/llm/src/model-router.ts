import { OllamaDriver } from "./ollama-driver";
import type { BackendCapabilities, BackendConfig, LLMBackend, ModelBackendsConfig } from "./types";
import { LLMError } from "./types";

export interface BackendInfo {
	id: string;
	capabilities: BackendCapabilities;
}

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;

	constructor(backends: Map<string, LLMBackend>, defaultId: string) {
		this.backends = backends;
		this.defaultId = defaultId;
	}

	getBackend(modelId?: string): LLMBackend {
		const id = modelId ?? this.defaultId;
		const backend = this.backends.get(id);
		if (!backend) {
			throw new Error(`Unknown backend ID: ${id}`);
		}
		return backend;
	}

	getDefault(): LLMBackend {
		const backend = this.backends.get(this.defaultId);
		if (!backend) {
			throw new Error(`Default backend not found: ${this.defaultId}`);
		}
		return backend;
	}

	listBackends(): BackendInfo[] {
		return Array.from(this.backends.entries()).map(([id, backend]) => ({
			id,
			capabilities: backend.capabilities(),
		}));
	}
}

function createBackendFromConfig(config: BackendConfig): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "ollama": {
			const baseUrl = config.baseUrl ?? "http://localhost:11434";
			const contextWindow = config.contextWindow ?? 4096;
			return new OllamaDriver({
				baseUrl,
				model: config.model,
				contextWindow,
			});
		}

		default:
			throw new Error(`Provider not yet implemented: ${config.provider}`);
	}
}

export function createModelRouter(config: ModelBackendsConfig): ModelRouter {
	const backends = new Map<string, LLMBackend>();

	for (const backendConfig of config.backends) {
		const backend = createBackendFromConfig(backendConfig);
		backends.set(backendConfig.id, backend);
	}

	// Verify default backend exists
	const defaultExists = backends.has(config.default);
	if (!defaultExists) {
		throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
	}

	return new ModelRouter(backends, config.default);
}
