import type { Logger } from "@bound/shared";
import type { DiscoveredModel } from "../catalog/discovery";
import type {
	BackendCapabilities,
	BackendConfig,
	BackendReadiness,
	LLMBackend,
	ModelDescriptor,
	ModelRegistrar,
} from "../types";

/** Retry/backoff caps for the background namespace lineup fetch. */
export const LINEUP_RETRY_BASE_MS = 1000;
export const LINEUP_RETRY_MAX_MS = 60_000;

/** Per-model override entry (camelCase, from `toRouterConfig`). */
export type NamespaceModelOverride = NonNullable<BackendConfig["modelOverrides"]>[string];

/** One routable model a namespace lineup fetch produced. */
export interface NamespaceLineupEntry {
	/** Raw provider model id; expanded backend ids are `${namespaceId}-${id}`. */
	id: string;
	/** Discovery row for this model, preserved on the expanded descriptor. */
	discovered: DiscoveredModel;
}

export interface NamespaceLineupReadinessDeps<E extends NamespaceLineupEntry> {
	/** Provider tag used in log lines (`${providerName} lineup ready`). */
	providerName: string;
	/** Namespace config id; expanded ids are `${namespaceId}-${providerModelId}`. */
	namespaceId: string;
	/** Fetch the lineup, or throw. An empty (post-`include`) result retries. */
	loadLineup: (signal: AbortSignal) => Promise<E[]>;
	/** Keep only routable entries; the rest are dropped before the empty check. */
	include?: (entry: E) => boolean;
	/** Registrar provider key. Defaults to `namespaceId`. */
	registrationKey?: string;
	/** Replaces {@link buildNamespaceDescriptor} for providers with their own capability rules. */
	buildDescriptor?: (entry: E) => ModelDescriptor;
	/** Build the concrete per-model backend; `contextWindow` is 0 when unresolved. */
	buildPerModelBackend: (entry: E, contextWindow: number) => LLMBackend;
	/** Per-model overrides keyed by provider model id. */
	modelOverrides?: Record<string, NamespaceModelOverride>;
	/** `prompt_caching` when no override sets it. Defaults to false. */
	defaultPromptCaching?: boolean;
	logger?: Logger;
	/** First retry delay; doubles per attempt up to `retryMaxMs`. */
	retryBaseMs?: number;
	retryMaxMs?: number;
}

/**
 * Build the registrar descriptor for one expanded namespace model. Context
 * window and prompt caching honor the per-model override first; vision,
 * reasoning, and max context come from the discovery row.
 */
export function buildNamespaceDescriptor(params: {
	namespaceId: string;
	entry: NamespaceLineupEntry;
	override?: NamespaceModelOverride;
	defaultPromptCaching?: boolean;
}): ModelDescriptor {
	const { namespaceId, entry, override } = params;
	const discovered = entry.discovered;
	const caps = discovered.capabilities;
	const maxContext = override?.contextWindow ?? caps?.max_context;
	const capabilities: BackendCapabilities = {
		streaming: true,
		tool_use: caps?.tool_use ?? true,
		system_prompt: true,
		prompt_caching: override?.promptCaching ?? params.defaultPromptCaching ?? false,
		vision: caps?.vision ?? false,
		extended_thinking: caps?.reasoning?.supported ?? false,
		...(maxContext !== undefined && { max_context: maxContext }),
	};
	const maxOutputTokens = override?.maxOutputTokens ?? discovered.maxOutputTokens;
	return {
		id: `${namespaceId}-${entry.id}`,
		providerModelId: entry.id,
		discovered,
		capabilities,
		...(override?.logicalModel !== undefined && { logicalModel: override.logicalModel }),
		...(maxOutputTokens !== undefined && { maxOutputTokens }),
	};
}

/**
 * Readiness handle for a self-configuring namespace (catalog §2.1). Fetches the
 * provider lineup and registers one concrete backend per model. A failed or
 * empty fetch retries with capped exponential backoff; `dispose()` aborts the
 * in-flight fetch and turns any later result into a no-op.
 */
export class NamespaceLineupReadiness<E extends NamespaceLineupEntry> implements BackendReadiness {
	private ready = false;
	private disposed = false;
	private pendingRetry?: ReturnType<typeof setTimeout>;
	private readonly controller = new AbortController();
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;

	constructor(private readonly deps: NamespaceLineupReadinessDeps<E>) {
		this.retryBaseMs = deps.retryBaseMs ?? LINEUP_RETRY_BASE_MS;
		this.retryMaxMs = deps.retryMaxMs ?? LINEUP_RETRY_MAX_MS;
	}

	isReady(): boolean {
		return this.ready;
	}

	dispose(): void {
		this.disposed = true;
		if (this.pendingRetry !== undefined) clearTimeout(this.pendingRetry);
		this.pendingRetry = undefined;
		this.controller.abort();
	}

	start(registrar: ModelRegistrar): void {
		void this.runFetchLoop(registrar);
	}

	private async runFetchLoop(registrar: ModelRegistrar): Promise<void> {
		const name = this.deps.providerName;
		let attempt = 0;
		while (!this.disposed) {
			let entries: E[] = [];
			try {
				entries = await this.deps.loadLineup(this.controller.signal);
				const include = this.deps.include;
				if (include) entries = entries.filter((entry) => include(entry));
			} catch (error) {
				if (this.disposed) return;
				this.deps.logger?.warn?.(`${name} lineup fetch failed; retrying`, {
					error: error instanceof Error ? error.message : String(error),
				});
				entries = [];
			}
			if (this.disposed) return;

			if (entries.length > 0) {
				const models = this.buildEntries(entries);
				if (this.disposed) return; // re-check just before the live-router write
				this.ready = true;
				registrar.register(this.deps.registrationKey ?? this.deps.namespaceId, models);
				this.deps.logger?.info?.(`${name} lineup ready`, { models: models.length });
				return;
			}

			attempt++;
			const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
			this.deps.logger?.warn?.(`${name} lineup empty; retrying`, { attempt, delayMs: delay });
			await new Promise<void>((resolve) => {
				this.pendingRetry = setTimeout(resolve, delay);
			});
			this.pendingRetry = undefined;
		}
	}

	private buildEntries(entries: E[]): Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> {
		return entries.map((entry) => {
			const descriptor =
				this.deps.buildDescriptor?.(entry) ??
				buildNamespaceDescriptor({
					namespaceId: this.deps.namespaceId,
					entry,
					override: this.deps.modelOverrides?.[entry.id],
					...(this.deps.defaultPromptCaching !== undefined && {
						defaultPromptCaching: this.deps.defaultPromptCaching,
					}),
				});
			return {
				descriptor,
				backend: this.deps.buildPerModelBackend(entry, descriptor.capabilities.max_context ?? 0),
			};
		});
	}
}

/** Wrap a discovery list as lineup entries keyed by provider model id. */
export function lineupFromDiscovered(models: DiscoveredModel[]): NamespaceLineupEntry[] {
	return models
		.filter((m) => m.providerModelId.length > 0)
		.map((m) => ({ id: m.providerModelId, discovered: m }));
}
