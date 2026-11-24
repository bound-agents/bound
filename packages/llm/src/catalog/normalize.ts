/**
 * Structural model-ID normalization (slice 6, R-MC8, 2026-11-21-model-catalog.md
 * §5.2 + §6.1).
 *
 * ONE shared rule set drives both `models.dev` matching (§5.2) and logical-model
 * grouping (§6.1 step 3). It derives a canonical key from provider naming
 * PATTERNS — never from an enumerated list of model names (R-MC1). A brand-new
 * model that follows the region/vendor/revision/version conventions normalizes
 * correctly with zero code change; `normalize.test.ts` pins this against
 * synthetic future IDs.
 *
 * The structural rules (§6.1 step 3), applied in order:
 *   1. strip region/routing prefixes   (`us.`, `eu.`, `ap.`, `global.`)
 *   2. strip provider/vendor prefixes:
 *        - dashed vendor prefixes (`copilot-`, `bedrock-`);
 *        - a Bedrock-style dotted `<vendor>.<model>` segment detected
 *          STRUCTURALLY (any vendor head with no digit that is not itself a
 *          model-family root) inside the Bedrock namespaces, so
 *          `moonshotai.`, `zai.`, `deepseek.`, `anthropic.`, `amazon.`, … all
 *          collapse to the same family key as the direct provider — never from
 *          an enumerated vendor list (R-MC1/R-MC8);
 *   3. strip deployment revision suffixes (`-vN:0`, `:0`, dated snapshots when a
 *                                        family key remains)
 *   4. canonicalize version separators   (`.` vs `-` in version numbers)
 *
 * A provider-local pseudo-model (a provider's own session-router token, e.g.
 * GitHub Copilot `auto`) is NOT a model: it is scoped to a provider-qualified
 * key (`${provider}:${token}`) and reported as an unrecognized namespace so it
 * never cross-provider-pools nor auto-groups (§6.1, R-MC9).
 *
 * Normalization is intentionally lossy and NOT an identity map on raw IDs: two
 * different raw IDs that denote the same model collapse to the same canonical
 * key. It never produces the empty string (a degenerate ID is returned as-is).
 */

/** Leading dotted routing/region segments stripped in rule 1. */
const REGION_PREFIXES = ["us", "eu", "ap", "global"];

/**
 * Dotted vendor prefixes stripped in rule 2 outside Bedrock namespaces (direct
 * vendor APIs and `openai`/`anthropic` models.dev namespaces that publish
 * `<vendor>.<model>` ids). Inside a Bedrock-style namespace the strip is
 * STRUCTURAL (see `BEDROCK_STYLE_NAMESPACES`), so this list is not consulted
 * there and never needs to enumerate every Bedrock vendor.
 */
const DOTTED_VENDOR_PREFIXES = ["anthropic", "openai", "google", "amazon", "meta", "mistral"];

/** Dashed vendor prefixes stripped in rule 2. */
const DASHED_VENDOR_PREFIXES = ["copilot", "bedrock"];

/**
 * Namespaces that address models with a Bedrock-style `<vendor>.<model>` dotted
 * prefix: Bound's `bedrock` / `bedrock-mantle` providers and the models.dev
 * `amazon-bedrock` namespace they map to (§5.2). Inside these, rule 2 strips the
 * leading dotted vendor segment STRUCTURALLY so a brand-new Bedrock vendor
 * (`deepseek.`, `qwen.`, `minimax.`, `writer.`, …) collapses to the same family
 * key as the direct provider with zero code change. The strip is scoped to
 * these namespaces so an arbitrary `openai-compatible` gateway tag that merely
 * looks like `<word>.<model>` is never silently re-homed.
 */
const BEDROCK_STYLE_NAMESPACES = new Set(["bedrock", "bedrock-mantle", "amazon-bedrock"]);

/**
 * Provider-local pseudo-models: a provider's own session-router token that is
 * NOT a model (e.g. GitHub Copilot `auto`, which makes Copilot pick a concrete
 * model per session). A bare canonical key would pool it across providers, so
 * it is scoped to a provider-qualified key and reported as an unrecognized
 * namespace (never auto-grouped). Keyed by Bound provider → set of pseudo-model
 * tokens.
 */
const PROVIDER_LOCAL_PSEUDO_MODELS: Record<string, ReadonlySet<string>> = {
	"github-copilot": new Set(["auto"]),
};

/**
 * Recognized vendor family roots. A canonical key beginning with one of these
 * is treated as a recognized model family even under an `openai-compatible`
 * shim, which the confidence predicate (§6.2 condition 1) needs to distinguish
 * a vendor-qualified family from an arbitrary local/gateway tag.
 */
const VENDOR_FAMILY_ROOTS = [
	"gpt",
	"claude",
	"llama",
	"gemini",
	"mistral",
	"qwen",
	"deepseek",
	"grok",
	"kimi",
	"glm",
	"nova",
	"opus",
	"sonnet",
	"haiku",
	"fable",
];

/**
 * Provider namespaces that publish a hosted/discovered model lineup. A backend
 * on one of these is in a "recognized provider namespace" (§6.2 condition 1)
 * unconditionally. `openai-compatible` is deliberately ABSENT: it is a shim that
 * can front either a real vendor family or an arbitrary local tag, so its
 * recognition is decided by the normalized family root instead.
 */
const HOSTED_PROVIDER_NAMESPACES = new Set([
	"anthropic",
	"bedrock",
	"bedrock-mantle",
	"chatgpt-oauth",
	"github-copilot",
	"umans",
	"opencode-go",
	"ollama",
]);

/**
 * Map a Bound provider to its `models.dev` provider namespace for
 * provider-scoped lookup (§5.2). `models.dev` is keyed by its own upstream
 * namespaces, which do not match Bound's provider names one-to-one: Bedrock and
 * Bedrock Mantle both front `amazon-bedrock`, and ChatGPT OAuth fronts
 * `openai`. A provider absent from this map has no namespace-scoped entry and
 * falls through to the cross-provider canonical index.
 *
 * This mapping is used ONLY to scope the `models.dev` lookup; it never changes
 * the canonical grouping key (which `normalizeModelKey` derives structurally),
 * so logical-model pooling is unaffected.
 */
const MODELS_DEV_NAMESPACE_BY_PROVIDER: Record<string, string> = {
	bedrock: "amazon-bedrock",
	"bedrock-mantle": "amazon-bedrock",
	"github-copilot": "github-copilot",
	anthropic: "anthropic",
	cerebras: "cerebras",
	"chatgpt-oauth": "openai",
	"opencode-go": "opencode-go",
	zai: "zai",
};

/**
 * The `models.dev` provider namespace for a Bound provider, or `undefined` when
 * none is known (the lookup then uses only the cross-provider canonical index).
 */
export function modelsDevNamespaceFor(provider: string): string | undefined {
	return MODELS_DEV_NAMESPACE_BY_PROVIDER[provider];
}

export interface NormalizedModelKey {
	/**
	 * The canonical structural key. Equal keys mean two raw provider model IDs
	 * normalize to the same logical model / `models.dev` entry.
	 */
	key: string;
	/**
	 * True when the backend belongs to a recognized hosted/discovered provider
	 * namespace OR its normalized key begins with a known vendor family root.
	 * Feeds §6.2 confidence condition 1: an unrecognized namespace is never
	 * auto-grouped.
	 */
	recognizedNamespace: boolean;
}

/** Strip a leading dotted region/routing segment (rule 1). */
function stripRegionPrefix(id: string): string {
	const dot = id.indexOf(".");
	if (dot <= 0) return id;
	const head = id.slice(0, dot);
	if (REGION_PREFIXES.includes(head)) return id.slice(dot + 1);
	return id;
}

/**
 * Strip a leading dashed vendor prefix (rule 2): `copilot-`, `bedrock-`.
 */
function stripDashedVendorPrefix(id: string): string {
	const dash = id.indexOf("-");
	if (dash > 0 && DASHED_VENDOR_PREFIXES.includes(id.slice(0, dash))) {
		return id.slice(dash + 1);
	}
	return id;
}

/**
 * Strip a leading dotted vendor prefix (rule 2). Outside a Bedrock-style
 * namespace only the enumerated `DOTTED_VENDOR_PREFIXES` are stripped (direct
 * `anthropic`/`openai`/… vendor ids). Inside a Bedrock-style namespace the
 * strip is STRUCTURAL: a leading dotted segment is a vendor segment iff its head
 * carries NO digit, with a non-empty model body following. That collapses
 * `moonshotai.`, `zai.`, `deepseek.`, `amazon.`, `openai.`, … to the same family
 * key as the direct provider without an enumerated list (R-MC1/R-MC8), while
 * leaving a family-version head intact (`gpt-5.4`, `glm-5.2`, `kimi-k2.5` — the
 * head carries a digit, so it is never a vendor segment).
 */
function stripDottedVendorPrefix(id: string, namespace: string): string {
	const dot = id.indexOf(".");
	if (dot <= 0) return id;
	const head = id.slice(0, dot);

	if (BEDROCK_STYLE_NAMESPACES.has(namespace)) {
		const body = id.slice(dot + 1);
		if (body.length === 0) return id;
		// A family-version head (`gpt-5`, `glm-5`, `kimi-k2`, `qwen3`) is NOT a
		// vendor: it carries a digit. Never strip it. A digit-free head is a bare
		// vendor segment (`moonshotai`, `zai`, `deepseek`, `amazon`, …) — strip it,
		// even when the vendor name coincides with a family root (`deepseek.v4-pro`
		// → `v4-pro`): a bare vendor head is always followed by a model body here.
		if (/\d/.test(head)) return id;
		return body;
	}

	if (DOTTED_VENDOR_PREFIXES.includes(head)) return id.slice(dot + 1);
	return id;
}

/**
 * Strip deployment revision + dated snapshot suffixes (rule 3), but never down
 * to the empty string — if removing a token would leave nothing, keep it.
 */
function stripRevisionSuffix(id: string): string {
	let out = id;
	// `-vN:0` / `-vN` / trailing `:0` Bedrock deployment revision.
	out = out.replace(/-v\d+(?::\d+)?$/i, "");
	out = out.replace(/:\d+$/, "");
	// 8-digit dated snapshot suffix (`-20250101`), only when a family remains.
	const deDated = out.replace(/-\d{8}$/, "");
	if (deDated.length > 0) out = deDated;
	return out.length > 0 ? out : id;
}

/**
 * Canonicalize version separators (rule 4): a `.` sitting between two digits is
 * a version dot (`6.2` ≡ `6-2`) and becomes a `-`. A `.` not flanked by digits
 * is a namespace separator and is already handled by the prefix rules.
 */
function canonicalizeSeparators(id: string): string {
	return id.replace(/(\d)\.(\d)/g, "$1-$2").toLowerCase();
}

/** Does this canonical key begin with a recognized vendor family root? */
function startsWithVendorFamily(key: string): boolean {
	return VENDOR_FAMILY_ROOTS.some(
		(root) => key === root || key.startsWith(`${root}-`) || key.startsWith(`${root}.`),
	);
}

/**
 * Normalize `(provider, providerModelId)` to a canonical structural key and
 * report whether the namespace is recognized for automatic grouping.
 */
export function normalizeModelKey(provider: string, providerModelId: string): NormalizedModelKey {
	const raw = providerModelId.trim();

	// A provider-local pseudo-model (e.g. github-copilot `auto`) is not a model.
	// Scope it to a provider-qualified key so it never cross-provider-pools, and
	// report it as an unrecognized namespace so grouping never auto-attaches it.
	if (PROVIDER_LOCAL_PSEUDO_MODELS[provider]?.has(raw)) {
		return { key: `${provider}:${raw}`, recognizedNamespace: false };
	}

	let id = raw;
	id = stripRegionPrefix(id);
	id = stripDottedVendorPrefix(id, provider);
	id = stripDashedVendorPrefix(id);
	// A dashed-vendor strip (copilot-/bedrock-) can expose a dotted vendor
	// segment underneath; run the prefix passes once more so e.g.
	// `copilot-gpt-…` and `anthropic.claude-…` both reach the bare family.
	id = stripRegionPrefix(id);
	id = stripDottedVendorPrefix(id, provider);
	id = stripDashedVendorPrefix(id);
	id = stripRevisionSuffix(id);
	const key = canonicalizeSeparators(id);

	const recognizedNamespace =
		HOSTED_PROVIDER_NAMESPACES.has(provider) || startsWithVendorFamily(key);

	return { key, recognizedNamespace };
}
