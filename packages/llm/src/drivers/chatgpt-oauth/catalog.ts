/**
 * Pure parser for the ChatGPT/Codex model inventory
 * (`GET ${CHATGPT_BACKEND_BASE_URL}/models?client_version=…`), catalog §4.1 /
 * R-MC3. Keeps listed, API-callable rows and maps the metadata the endpoint
 * publishes onto the provider-neutral `DiscoveredModel` shape.
 */

import type { DiscoveredModel } from "../../catalog/discovery";
import type { ResolvedCapabilities } from "../../catalog/resolve-metadata";

/**
 * `client_version` sent with the inventory request. The endpoint gates the
 * lineup by client version: an old version (e.g. `0.100.0`) sees only a hidden
 * placeholder row, while `1.0.0` sees the current model set.
 */
export const CODEX_MODELS_CLIENT_VERSION = "1.0.0";

/** One raw row of the Codex `/models` response (fields Bound reads). */
interface CodexModelRow {
	slug?: unknown;
	display_name?: unknown;
	visibility?: unknown;
	supported_in_api?: unknown;
	context_window?: unknown;
	max_context_window?: unknown;
	input_modalities?: unknown;
	default_reasoning_level?: unknown;
	supported_reasoning_levels?: unknown;
	supports_reasoning_summaries?: unknown;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseEfforts(levels: unknown): string[] {
	if (!Array.isArray(levels)) return [];
	const out: string[] = [];
	for (const level of levels) {
		const effort =
			typeof level === "string"
				? level
				: level !== null && typeof level === "object"
					? (level as { effort?: unknown }).effort
					: undefined;
		if (typeof effort === "string" && effort.length > 0 && !out.includes(effort)) {
			out.push(effort);
		}
	}
	return out;
}

/**
 * Parse a Codex `/models` body into routable discovery rows. A row is kept when
 * it has a non-empty `slug`, is listed (`visibility === "list"` or absent), and
 * is not marked `supported_in_api: false`. A malformed body yields `[]`.
 */
export function parseCodexModels(body: unknown): DiscoveredModel[] {
	if (body === null || typeof body !== "object") return [];
	const rows = (body as { models?: unknown }).models;
	if (!Array.isArray(rows)) return [];

	const seen = new Set<string>();
	const out: DiscoveredModel[] = [];
	for (const raw of rows) {
		if (raw === null || typeof raw !== "object") continue;
		const row = raw as CodexModelRow;
		if (typeof row.slug !== "string" || row.slug.length === 0) continue;
		if (row.visibility !== undefined && row.visibility !== "list") continue;
		if (row.supported_in_api === false) continue;
		if (seen.has(row.slug)) continue;
		seen.add(row.slug);

		const efforts = parseEfforts(row.supported_reasoning_levels);
		const capabilities: ResolvedCapabilities = {
			tool_use: true,
			vision: Array.isArray(row.input_modalities) && row.input_modalities.includes("image"),
			...(isPositiveNumber(row.context_window) && { max_context: row.context_window }),
			...(efforts.length > 0 && {
				reasoning: { supported: true, effort_values: efforts },
			}),
		};
		out.push({
			providerModelId: row.slug,
			...(typeof row.display_name === "string" &&
				row.display_name.length > 0 && { displayName: row.display_name }),
			capabilities,
		});
	}
	return out;
}
