/**
 * Bedrock namespace lineup filter (2026-11-21-model-catalog.md §2.1). Pure over the two parsed control-plane fixtures: given the foundation
 * models + inference profiles a region publishes (via `discoverModels()`) and the
 * operator's `cross_region` preference, decide which models the namespace entry
 * for this (profile, region) exposes, the callable id each uses, the wire
 * protocol, and whether prompt caching is advertised.
 *
 * Every decision traces to a published control-plane field — never a model-ID
 * string (R-MC1): modality lists, `modelLifecycle.status`,
 * `inferenceTypesSupported`, the undocumented-but-live `inferenceAPIsSupported`,
 * `explicitPromptCaching.isSupported`, and the
 * SYSTEM_DEFINED inference profiles' covered ARNs.
 */

import type { DiscoveredModel } from "./discovery";

/** The wire protocol a lineup model is served over. */
export type BedrockProtocol = "responses" | "converse";

/** One model the namespace entry exposes, with its callable id and protocol. */
export interface BedrockLineupEntry {
	/** The bare foundation-model id (used for grouping + models.dev + overrides). */
	providerModelId: string;
	/**
	 * What to pass to the driver's `chat()` as the model id: the bare model id when
	 * the model is callable ON_DEMAND, else the chosen SYSTEM_DEFINED inference
	 * profile id (region-prefixed, e.g. `global.openai.gpt-6.1-sol`).
	 */
	callableId: string;
	/** Responses on bedrock-runtime vs Converse, from `inferenceAPIsSupported`. */
	protocol: BedrockProtocol;
	/** `explicitPromptCaching.isSupported` — the provider-layer caching capability (R-MC7). */
	promptCaching: boolean;
}

/** Operator preferences the filter reads. */
export interface BedrockLineupOptions {
	/** The region this (profile, region) namespace entry serves. */
	region: string;
	/**
	 * Preferred cross-region inference-profile scope prefix for an
	 * INFERENCE_PROFILE-only model (`global`, `us`, `eu`, …). Defaults to
	 * `global`; when no profile with that prefix covers the model's ARN, the
	 * filter falls back to any covering SYSTEM_DEFINED profile (the geo profile).
	 */
	crossRegion?: string;
}

const DEFAULT_CROSS_REGION = "global";

/**
 * A SYSTEM_DEFINED inference profile's covered model ARNs, normalized so a
 * region-qualified ARN and the region-stripped bare ARN compare equal. A
 * `global.`/`us.` profile lists both `arn:aws:bedrock:::foundation-model/{id}`
 * and `arn:aws:bedrock:{region}::foundation-model/{id}`; matching strips the
 * region segment so either form resolves the same foundation model.
 */
function normalizeArn(arn: string): string {
	// arn:aws:bedrock:{region}::foundation-model/{id} → arn:aws:bedrock::foundation-model/{id}
	return arn.replace(/^(arn:aws:bedrock:)[^:]*(::foundation-model\/)/, "$1$2");
}

/**
 * The wire protocol from `inferenceAPIsSupported` only: Responses wins when
 * advertised, else Converse when streaming is advertised, else none (excluded).
 */
function protocolFor(b: DiscoveredModel["bedrock"]): BedrockProtocol | undefined {
	if (b?.openAiResponses === true) return "responses";
	if (b?.converseStreaming === true) return "converse";
	return undefined;
}

/** The scope prefix of a profile id (`global.openai.gpt-6.1-sol` → `global`). */
function profilePrefix(profileId: string): string | undefined {
	const dot = profileId.indexOf(".");
	return dot > 0 ? profileId.slice(0, dot) : undefined;
}

/**
 * Select the namespace lineup for one (profile, region). Pure: no I/O, no clock.
 * Excludes any model that is not ACTIVE, not text-in/text-only-out, not callable
 * in this region (no ON_DEMAND and no covering SYSTEM_DEFINED profile), or has no
 * usable wire protocol.
 */
export function selectBedrockLineup(
	discovery: readonly DiscoveredModel[],
	options: BedrockLineupOptions,
): BedrockLineupEntry[] {
	const preferredScope = options.crossRegion ?? DEFAULT_CROSS_REGION;

	// Index the SYSTEM_DEFINED profiles by each normalized covered ARN so an
	// INFERENCE_PROFILE-only model can find a covering profile. One ARN may be
	// covered by several profiles (global. and us.); keep them all.
	const profilesByArn = new Map<string, DiscoveredModel[]>();
	for (const row of discovery) {
		const b = row.bedrock;
		if (!b || b.profileType !== "SYSTEM_DEFINED" || b.profileStatus !== "ACTIVE") continue;
		for (const arn of b.profileModelArns ?? []) {
			const key = normalizeArn(arn);
			const list = profilesByArn.get(key) ?? [];
			list.push(row);
			profilesByArn.set(key, list);
		}
	}

	const out: BedrockLineupEntry[] = [];
	for (const model of discovery) {
		const b = model.bedrock;
		// A foundation-model row carries a modelArn + lifecycle; a profile row does
		// not. Skip profile rows here (they are the index above).
		if (!b || b.modelArn === undefined) continue;
		if (b.lifecycleStatus !== "ACTIVE") continue;
		if (b.inputText !== true || b.outputTextOnly !== true) continue;

		const protocol = protocolFor(b);
		if (!protocol) continue;

		// Callability: a bare model id when ON_DEMAND, else a SYSTEM_DEFINED profile
		// covering this region's foundation-model ARN (preferring the operator's
		// cross_region scope, default global, falling back to the geo profile).
		const onDemand = (b.inferenceTypes ?? []).includes("ON_DEMAND");
		let callableId: string | undefined;
		if (onDemand) {
			callableId = model.providerModelId;
		} else {
			const covering = profilesByArn.get(normalizeArn(b.modelArn)) ?? [];
			const preferred = covering.find((p) => profilePrefix(p.providerModelId) === preferredScope);
			callableId = (preferred ?? covering[0])?.providerModelId;
		}
		if (!callableId) continue;

		out.push({
			providerModelId: model.providerModelId,
			callableId,
			protocol,
			promptCaching: b.explicitPromptCaching === true,
		});
	}
	return out;
}

/**
 * Select the Mantle namespace lineup for one (profile, region).
 * Mantle's `GET /v1/models` returns bare vendor-prefixed ids (`openai.gpt-5.6-sol`,
 * `zai.glm-4.6`); the protocol signal lives on the SAME control plane's
 * `ListFoundationModels` join. A Mantle id is included only when it exactly joins
 * a foundation-model id (the documented relationship — the Mantle id IS the
 * foundation-model id) AND that model advertises a usable wire protocol; its
 * callable id on Mantle is the bare model id. A Mantle id with no foundation-model
 * join (versioned snapshots like `openai.gpt-5.5-2026-04-23`, Anthropic Messages
 * ids with no `openAiResponses`/`converse` flag) is returned in `excluded` and
 * never guessed.
 */
export function selectMantleLineupWithExclusions(
	mantleModels: readonly DiscoveredModel[],
	foundationModels: readonly DiscoveredModel[],
): { lineup: BedrockLineupEntry[]; excluded: string[] } {
	const byId = new Map<string, DiscoveredModel>();
	for (const fm of foundationModels) {
		if (fm.bedrock?.modelArn !== undefined) byId.set(fm.providerModelId, fm);
	}
	const lineup: BedrockLineupEntry[] = [];
	const excluded: string[] = [];
	for (const model of mantleModels) {
		const joined = byId.get(model.providerModelId)?.bedrock;
		const protocol = protocolFor(joined);
		if (!protocol) {
			excluded.push(model.providerModelId);
			continue;
		}
		lineup.push({
			providerModelId: model.providerModelId,
			callableId: model.providerModelId,
			protocol,
			promptCaching: joined?.explicitPromptCaching === true,
		});
	}
	return { lineup, excluded };
}
