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
