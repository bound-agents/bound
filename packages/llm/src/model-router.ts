import { AnthropicDriver } from "./anthropic-driver";
import { BedrockDriver } from "./bedrock-driver";
import { OllamaDriver } from "./ollama-driver";
import { OpenAICompatibleDriver } from "./openai-driver";
import type {
	BackendCapabilities,
	BackendConfig,
	CapabilityRequirements,
	LLMBackend,
	ModelBackendsConfig,
} from "./types";
import { LLMError } from "./types";

export interface BackendInfo {
	id: string;
	capabilities: BackendCapabilities;
}

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;
	private effectiveCaps: Map<string, BackendCapabilities>;
	private rateLimits: Map<string, number>; // backendId → expiry timestamp (ms)

	constructor(
		backends: Map<string, LLMBackend>,
		defaultId: string,
		effectiveCaps: Map<string, BackendCapabilities>,
	) {
		this.backends = backends;
		this.defaultId = defaultId;
		this.effectiveCaps = effectiveCaps;
		this.rateLimits = new Map();
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

	/** Returns BackendInfo list with EFFECTIVE capabilities (driver baseline merged with config overrides). */
	listBackends(): BackendInfo[] {
		return Array.from(this.backends.keys()).map((id) => ({
			id,
			capabilities: this.effectiveCaps.get(id) ?? this.backends.get(id)!.capabilities(),
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

	/**
	 * Returns the effective capabilities for a backend (driver baseline merged with config override).
	 * Returns null if the backend ID is not registered.
	 */
	getEffectiveCapabilities(id: string): BackendCapabilities | null {
		return this.effectiveCaps.get(id) ?? null;
	}

	/**
	 * Returns all backends that are not rate-limited and satisfy the given capability requirements.
	 * Sorted by backend registration order (Map iteration order).
	 *
	 * @param requirements - Optional capability requirements to filter by. If omitted, only rate-limited
	 *   backends are excluded (text-only requests with no special requirements).
	 */
	listEligible(requirements?: CapabilityRequirements): BackendInfo[] {
		return Array.from(this.backends.keys())
			.filter((id) => !this.isRateLimited(id))
			.filter((id) => {
				if (!requirements) return true;
				const caps = this.effectiveCaps.get(id);
				if (!caps) return false;
				if (requirements.vision && !caps.vision) return false;
				if (requirements.tool_use && !caps.tool_use) return false;
				if (requirements.system_prompt && !caps.system_prompt) return false;
				if (requirements.prompt_caching && !caps.prompt_caching) return false;
				return true;
			})
			.map((id) => ({
				id,
				capabilities: this.effectiveCaps.get(id)!,
			}));
	}

	/**
	 * Marks a backend as rate-limited for the given duration.
	 * The backend will be excluded from `listEligible()` for `retryAfterMs` milliseconds.
	 *
	 * @param id - Backend ID to mark rate-limited
	 * @param retryAfterMs - Duration in milliseconds (use 60_000 as default if Retry-After header is absent)
	 */
	markRateLimited(id: string, retryAfterMs: number): void {
		this.rateLimits.set(id, Date.now() + retryAfterMs);
	}

	/**
	 * Returns true if the backend is currently rate-limited.
	 * Automatically cleans up expired entries.
	 */
	isRateLimited(id: string): boolean {
		const expiry = this.rateLimits.get(id);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.rateLimits.delete(id); // Clean up expired entry
			return false;
		}
		return true;
	}
}

function createBackendFromConfig(config: BackendConfig): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "anthropic": {
			const apiKey = config.apiKey as string | undefined;
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
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = config.profile as string | undefined;
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
			const apiKey = config.apiKey as string | undefined;
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
	const effectiveCaps = new Map<string, BackendCapabilities>();

	for (const backendConfig of config.backends) {
		const backend = createBackendFromConfig(backendConfig);
		backends.set(backendConfig.id, backend);

		// Compute effective capabilities: driver baseline merged with config override.
		// The config override (from capabilities field added in Phase 1) allows operators
		// to add or suppress capabilities on a per-backend basis.
		const baseline = backend.capabilities();
		const override =
			(backendConfig.capabilities as Partial<BackendCapabilities> | undefined) ?? {};
		effectiveCaps.set(backendConfig.id, { ...baseline, ...override });
	}

	// Verify default backend exists
	const defaultExists = backends.has(config.default);
	if (!defaultExists) {
		throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
	}

	return new ModelRouter(backends, config.default, effectiveCaps);
}
