import { randomUUID } from "node:crypto";
import {
	findActiveAgentByName,
	findAgentByNameIncludingRetired,
	insertRow,
	listAgentsForToolView,
	updateRow,
} from "@bound/core";
import type { Agent } from "@bound/shared";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

/**
 * Auxiliary-agent identity management (#201), define/list/retire slice.
 *
 * An auxiliary agent is a durable, named identity with its own memory namespace;
 * each invocation is ephemeral. Definitions are persona-scoped, not
 * use-case-scoped: the persona says who the aux IS (temperament, working style,
 * standing habits), not which job it does — the job arrives per-invocation in
 * `instructions` once the invoke slice lands. This slice covers only the CRUD
 * over identities; invoke/send/cancel (the nested loop) follow.
 *
 * Everything rides one action-dispatcher tool in the house style of
 * memory/task/advisory. Dispatch is a STRICT discriminated union: each action's
 * required fields are validated up front, so a param that belongs to another
 * action can never silently steer the wrong branch (the advisory
 * create-branch-shadowing bug is the cautionary tale).
 */

/** Aux name shares the skill-name grammar: lowercase alphanumeric, hyphens between segments. */
const AUX_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_AUX_NAME_LENGTH = 64;
const MAX_PERSONA_LENGTH = 8192;

const auxSchema = z.object({
	action: z
		.enum(["define", "update", "retire", "list"])
		.describe("Auxiliary-agent operation to perform"),
	name: z.string().optional().describe("Identity name (for define, update, retire)"),
	persona: z
		.string()
		.optional()
		.describe(
			"Who the aux IS — temperament, working style, standing habits. NOT a job description, NOT the main persona (for define; optional for update).",
		),
	tools: z
		.array(z.string())
		.optional()
		.describe(
			"Allowlisted tool names — a subset of the toolset where the aux runs. Omit for unrestricted (structural denials still apply). (for define / update)",
		),
	model_hint: z
		.string()
		.optional()
		.describe("Default model for this identity (for define / update)"),
});

type AuxInput = z.infer<typeof auxSchema>;

export function createAuxTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(auxSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "aux",
				description:
					"Manage auxiliary-agent identities: define, update, retire, or list. An auxiliary agent is a durable, persona-scoped identity with its own memory namespace, invoked to handle side errands without dragging the main agent's context or identity along. The persona says who it IS, not what it's for.",
				parameters: jsonSchema,
			},
		},
		resolveAnnotations: (args: Record<string, unknown>) => {
			switch (args.action) {
				case "list":
					return { idempotent: true, readOnly: true };
				case "define":
				case "update":
				case "retire":
					// Each converges to the same final state on replay: define by
					// deterministic name-keyed check, update/retire by LWW on the row.
					return { idempotent: true, readOnly: false };
				default:
					return {};
			}
		},
		execute: async (raw: Record<string, unknown>): Promise<string> => {
			const parsed = parseToolInput(auxSchema, raw, "aux");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "define":
						return handleDefine(ctx, input);
					case "update":
						return handleUpdate(ctx, input);
					case "retire":
						return handleRetire(ctx, input);
					case "list":
						return handleList(ctx);
					default:
						return `Error: Invalid action '${input.action}'. Valid actions: define, update, retire, list`;
				}
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
}

/** Validate the name against the shared grammar + length. Returns an error string, or null when valid. */
function validateName(name: string): string | null {
	if (!AUX_NAME_REGEX.test(name)) {
		return `Error: Invalid aux name '${name}': must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric, hyphens allowed between segments)`;
	}
	if (name.length > MAX_AUX_NAME_LENGTH) {
		return `Error: aux name '${name}' exceeds maximum length of ${MAX_AUX_NAME_LENGTH} characters`;
	}
	return null;
}

function validatePersona(persona: string): string | null {
	if (persona.trim().length === 0) {
		return "Error: 'persona' must be non-empty";
	}
	if (persona.length > MAX_PERSONA_LENGTH) {
		return `Error: 'persona' exceeds maximum length of ${MAX_PERSONA_LENGTH} characters`;
	}
	return null;
}

function handleDefine(ctx: ToolContext, input: AuxInput): string {
	if (!input.name) return "Error: 'name' is required for define action";
	if (input.persona === undefined) return "Error: 'persona' is required for define action";

	const nameErr = validateName(input.name);
	if (nameErr) return nameErr;
	const personaErr = validatePersona(input.persona);
	if (personaErr) return personaErr;

	// Reuse an existing active identity rather than mint a near-duplicate:
	// identity sprawl is worse than tool sprawl, since every duplicate splits a
	// memory namespace. `define` on an existing active name is refused; the
	// caller should `update` it or pick a distinct name.
	const existing = findActiveAgentByName(ctx.db, input.name);
	if (existing) {
		return `Error: an active auxiliary agent named '${input.name}' already exists. Use action 'update' to change its persona/tools/model, or choose a different name.`;
	}

	const now = new Date().toISOString();
	const row: Agent = {
		id: randomUUID(),
		name: input.name,
		persona: input.persona,
		tools: input.tools ? JSON.stringify(input.tools) : null,
		model_hint: input.model_hint ?? null,
		retired_at: null,
		created_by_thread: ctx.threadId ?? null,
		created_at: now,
		modified_at: now,
		deleted: 0,
	};
	insertRow(ctx.db, "agents", row, ctx.siteId);

	return `Defined auxiliary agent '${input.name}'. Its memory namespace is now scoped to this identity; invoke it to hand off an errand (the use case rides in the invocation's instructions, not the persona).`;
}

function handleUpdate(ctx: ToolContext, input: AuxInput): string {
	if (!input.name) return "Error: 'name' is required for update action";

	const nameErr = validateName(input.name);
	if (nameErr) return nameErr;

	// Update resolves against the active (non-retired, non-deleted) identity:
	// changing a retired identity's persona would be surprising. To bring a
	// retired identity back, that's a distinct un-retire path (not this slice).
	const existing = findActiveAgentByName(ctx.db, input.name);
	if (!existing) {
		return `Error: no active auxiliary agent named '${input.name}'. Use action 'define' to create it, or 'list' to see existing identities.`;
	}

	const updates: Partial<Agent> = {};
	if (input.persona !== undefined) {
		const personaErr = validatePersona(input.persona);
		if (personaErr) return personaErr;
		updates.persona = input.persona;
	}
	if (input.tools !== undefined) {
		updates.tools = JSON.stringify(input.tools);
	}
	if (input.model_hint !== undefined) {
		updates.model_hint = input.model_hint;
	}

	if (Object.keys(updates).length === 0) {
		return "Error: update requires at least one of 'persona', 'tools', or 'model_hint'.";
	}

	updates.modified_at = new Date().toISOString();
	updateRow(ctx.db, "agents", existing.id, updates, ctx.siteId);

	const changed = Object.keys(updates)
		.filter((k) => k !== "modified_at")
		.join(", ");
	return `Updated auxiliary agent '${input.name}' (${changed}). Everything it has learned carries over — the change applies to the next invocation; any in-flight turn finishes on the definition it started with.`;
}

function handleRetire(ctx: ToolContext, input: AuxInput): string {
	if (!input.name) return "Error: 'name' is required for retire action";

	const nameErr = validateName(input.name);
	if (nameErr) return nameErr;

	// Retire is domain state, NOT deletion: set retired_at so the identity
	// drops from list/invoke, but its memory namespace stays readable to the
	// main agent. We look it up including-retired so retiring an
	// already-retired identity is an idempotent no-op message, not an error.
	const existing = findAgentByNameIncludingRetired(ctx.db, input.name);
	if (!existing) {
		return `Error: no auxiliary agent named '${input.name}' to retire.`;
	}
	if (existing.retired_at) {
		return `Auxiliary agent '${input.name}' is already retired; nothing to do. Its memory namespace remains readable.`;
	}

	const now = new Date().toISOString();
	updateRow(ctx.db, "agents", existing.id, { retired_at: now, modified_at: now }, ctx.siteId);

	return `Retired auxiliary agent '${input.name}'. It is gone from list/invoke; its memory namespace stays readable to you. Any open conversations archive; a later define under the same name starts a fresh identity.`;
}

function handleList(ctx: ToolContext): string {
	const rows = listAgentsForToolView(ctx.db);
	if (rows.length === 0) {
		return "No auxiliary agents defined. Use action 'define' to create one.";
	}

	const lines: string[] = [];
	lines.push("NAME             MODEL           PERSONA");
	lines.push("-".repeat(80));
	for (const row of rows) {
		const name = row.name.padEnd(16);
		const model = (row.model_hint ?? "(default)").slice(0, 15).padEnd(15);
		const persona = row.persona.replace(/\s+/g, " ").slice(0, 60);
		lines.push(`${name} ${model} ${persona}`);
	}
	return lines.join("\n");
}
