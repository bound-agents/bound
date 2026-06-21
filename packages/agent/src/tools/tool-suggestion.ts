import type { RegisteredTool } from "../types";

/**
 * Extract the `action` enum values from a tool's JSON-schema parameters, if it
 * has one. Grouped tools (connector, skill, memory, advisory, task) all expose
 * a required `action` enum; standalone tools (query, bash, etc.) do not.
 *
 * The schema shape is produced by `zodToToolParams` (z.toJSONSchema), so the
 * action field lives at `parameters.properties.action.enum`.
 */
function getActionEnum(tool: RegisteredTool): string[] | undefined {
	const params = tool.toolDefinition.function.parameters;
	if (!params || typeof params !== "object") return undefined;
	const properties = (params as Record<string, unknown>).properties;
	if (!properties || typeof properties !== "object") return undefined;
	const actionProp = (properties as Record<string, unknown>).action;
	if (!actionProp || typeof actionProp !== "object") return undefined;
	const enumValues = (actionProp as Record<string, unknown>).enum;
	if (!Array.isArray(enumValues)) return undefined;
	return enumValues.filter((v): v is string => typeof v === "string");
}

/**
 * Extract all parameter names from a tool's JSON-schema parameters.
 * Returns an empty array if the schema has no properties.
 */
function getParamNames(tool: RegisteredTool): string[] {
	const params = tool.toolDefinition.function.parameters;
	if (!params || typeof params !== "object") return [];
	const properties = (params as Record<string, unknown>).properties;
	if (!properties || typeof properties !== "object") return [];
	return Object.keys(properties as Record<string, unknown>);
}

/**
 * When a model routes an action value to the wrong tool (e.g. calling
 * `connector` with `action: "activate"`, which belongs to `skill`), the Zod
 * validation error enumerates the *valid* options for the called tool but
 * never reveals that the rejected value belongs to a *different* tool. Models
 * that confuse two action-dispatcher tools re-decide the same wrong routing
 * every turn — the 2026-06-12 and 2026-06-21 gpt-5.5 connector-vs-skill spins
 * (26+ and 12+ identical-error turns respectively) both followed this pattern.
 *
 * This function cross-references the rejected action against the full tool
 * registry. If exactly one other tool accepts it, it returns a direct
 * suggestion naming that tool — injected on the *first* failed call, not after
 * the loop guard's 5-turn threshold.
 *
 * Returns `undefined` when:
 * - the registry is absent (legacy dispatch path)
 * - the input has no string `action` field
 * - the action IS valid for the called tool (real validation error elsewhere)
 * - no other registered tool accepts the action value
 */
export function suggestToolForAction(
	calledToolName: string,
	input: Record<string, unknown>,
	registry?: Map<string, RegisteredTool>,
): string | undefined {
	if (!registry) return undefined;

	const action = input.action;
	if (typeof action !== "string") return undefined;

	// If the action is valid for the called tool, the error is somewhere else
	// in the params — no cross-tool suggestion to make.
	const calledTool = registry.get(calledToolName);
	if (calledTool) {
		const calledActions = getActionEnum(calledTool);
		if (calledActions?.includes(action)) return undefined;
	}

	// Scan for another tool that accepts this action value.
	for (const [name, tool] of registry) {
		if (name === calledToolName) continue;
		const actions = getActionEnum(tool);
		if (actions?.includes(action)) {
			return `The "${action}" action is valid for the "${name}" tool, not "${calledToolName}". Call ${name} with action "${action}" instead.`;
		}
	}

	return undefined;
}

/**
 * When a model passes a set of parameter *names* that don't belong to the
 * called tool (e.g. calling `connector` with `boundless_search`'s params
 * `pattern`, `path`, `case_insensitive`, `fixed_strings` and no `action`),
 * the Zod error enumerates the called tool's valid params but never reveals
 * the names belong to a *different* tool. Models that confuse the shape of
 * one tool with another re-decide the same wrong routing every turn — the
 * 2026-06-21 GPT-5.5 connector-spin (60+ identical-error turns across three
 * aborts) followed this exact pattern.
 *
 * Cross-references the rejected input's parameter names against every other
 * tool in the registry. If exactly one tool accepts ALL (or a strong majority
 * of) the passed names and the called tool accepts none, returns a direct
 * suggestion naming that tool.
 *
 * Returns `undefined` when:
 * - the registry is absent
 * - the input is empty
 * - the called tool already accepts the passed names
 * - no other tool has sufficient param overlap
 */
export function suggestToolByParams(
	calledToolName: string,
	input: Record<string, unknown>,
	registry?: Map<string, RegisteredTool>,
): string | undefined {
	if (!registry) return undefined;
	const inputKeys = Object.keys(input);
	if (inputKeys.length === 0) return undefined;

	// If the called tool accepts all passed names, the error is in the values,
	// not the routing — no cross-tool suggestion.
	const calledTool = registry.get(calledToolName);
	if (calledTool) {
		const calledParams = new Set(getParamNames(calledTool));
		if (inputKeys.every((k) => calledParams.has(k))) return undefined;
	}

	// Score each other tool by how many of the input keys it accepts.
	let bestName: string | undefined;
	for (const [name, tool] of registry) {
		if (name === calledToolName) continue;
		const params = new Set(getParamNames(tool));
		if (params.size === 0) continue;
		const overlap = inputKeys.filter((k) => params.has(k)).length;
		// Require ALL input keys to match for a suggestion.
		if (overlap === inputKeys.length) {
			bestName = name;
			break;
		}
	}

	if (bestName) {
		return `The parameters (${inputKeys.join(", ")}) are valid for the "${bestName}" tool, not "${calledToolName}". Call ${bestName} instead.`;
	}

	return undefined;
}

/**
 * Unified cross-tool suggestion dispatcher. Tries action-value matching first
 * (handles dispatcher-vs-dispatcher confusion like connector→skill), then
 * falls back to parameter-signature matching (handles tool-shape confusion
 * like connector-called-with-search-params→boundless_search). This is the
 * single entry point called from agent-loop.ts on every failed tool call.
 *
 * Both strategies are designed to fire on the FIRST failed call, before the
 * loop guard's 5-turn threshold — because a model stuck in a parameter-routing
 * loop re-decides the same wrong routing every turn and never self-corrects.
 */
export function suggestCorrectTool(
	calledToolName: string,
	input: Record<string, unknown>,
	registry?: Map<string, RegisteredTool>,
): string | undefined {
	return (
		suggestToolForAction(calledToolName, input, registry) ??
		suggestToolByParams(calledToolName, input, registry)
	);
}
