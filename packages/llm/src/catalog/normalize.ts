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
 * The four structural rules (§6.1 step 3), applied in order:
 *   1. strip region/routing prefixes   (`us.`, `eu.`, `ap.`, `global.`)
 *   2. strip provider/vendor prefixes   (`anthropic.`, `openai.`, `google.`,
 *                                        `copilot-`, `bedrock-`)
 *   3. strip deployment revision suffixes (`-vN:0`, `:0`, dated snapshots when a
 *                                        family key remains)
 *   4. canonicalize version separators   (`.` vs `-` in version numbers)
 *
 * Normalization is intentionally lossy and NOT an identity map on raw IDs: two
 * different raw IDs that denote the same model collapse to the same canonical
 * key. It never produces the empty string (a degenerate ID is returned as-is).
 */

/** Leading dotted routing/region segments stripped in rule 1. */
const REGION_PREFIXES = ["us", "eu", "ap", "global"];

/** Dotted vendor prefixes stripped in rule 2. */
const DOTTED_VENDOR_PREFIXES = ["anthropic", "openai", "google", "amazon", "meta", "mistral"];

/** Dashed vendor prefixes stripped in rule 2. */
const DASHED_VENDOR_PREFIXES = ["copilot", "bedrock"];

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

/** Strip a leading dotted or dashed vendor prefix (rule 2). */
function stripVendorPrefix(id: string): string {
	const dot = id.indexOf(".");
	if (dot > 0 && DOTTED_VENDOR_PREFIXES.includes(id.slice(0, dot))) {
		return id.slice(dot + 1);
	}
	const dash = id.indexOf("-");
	if (dash > 0 && DASHED_VENDOR_PREFIXES.includes(id.slice(0, dash))) {
		return id.slice(dash + 1);
	}
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
	let id = providerModelId.trim();
	id = stripRegionPrefix(id);
	id = stripVendorPrefix(id);
	// A dashed-vendor strip (copilot-/bedrock-) can expose a dotted vendor
	// segment underneath; run the prefix passes once more so e.g.
	// `copilot-gpt-…` and `anthropic.claude-…` both reach the bare family.
	id = stripRegionPrefix(id);
	id = stripVendorPrefix(id);
	id = stripRevisionSuffix(id);
	const key = canonicalizeSeparators(id);

	const recognizedNamespace =
		HOSTED_PROVIDER_NAMESPACES.has(provider) || startsWithVendorFamily(key);

	return { key, recognizedNamespace };
}
