import { AnthropicDriver } from "./anthropic-driver";
import { BedrockDriver } from "./bedrock-driver";
import { OllamaDriver } from "./ollama-driver";
import { OpenAICompatibleDriver } from "./openai-driver";
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
			const available = Array.from(this.backends.keys()).join(", ");
			throw new Error(`Unknown backend ID: ${id}. Available backends: ${available}`);
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

	/** Returns the default backend ID. */
	getDefaultId(): string {
		return this.defaultId;
	}

	/** Returns the backend for modelId, or null if not found (non-throwing). */
	tryGetBackend(modelId: string): LLMBackend | null {
		return this.backends.get(modelId) ?? null;
	}
}

function createBackendFromConfig(config: BackendConfig): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "anthropic": {
			const apiKey = (config as any).apiKey;
			if (!apiKey) {
				throw new Error("Anthropic driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 200000;
			return new AnthropicDriver({
				apiKey,
				model: config.model,
				contextWindow,
			});
		}

		case "bedrock": {
			const region = (config as any).region;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = (config as any).profile as string | undefined;
			const contextWindow = config.contextWindow ?? 200000;
			return new BedrockDriver({
				region,
				model: config.model,
				contextWindow,
				profile,
			});
		}

		case "openai-compatible": {
			const baseUrl = config.baseUrl ?? "http://localhost:8000";
			const apiKey = (config as any).apiKey;
			if (!apiKey) {
				throw new Error("OpenAI-compatible driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 8192;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
			});
		}

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
