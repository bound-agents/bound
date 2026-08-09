import { randomUUID } from "node:crypto";
import {
	enqueueMessage,
	findActiveAgentByName,
	findAgentByNameIncludingRetired,
	findThreadUserAndInterfaceById,
	insertRow,
	listAgentsForToolView,
	updateRow,
} from "@bound/core";
import type { Agent } from "@bound/shared";
import { z } from "zod";
import type { DeferredToolResult, RegisteredTool, ToolContext } from "../types";
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
		.enum(["define", "update", "retire", "list", "invoke"])
		.describe("Auxiliary-agent operation to perform"),
	name: z.string().optional().describe("Identity name (for define, update, retire, invoke)"),
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
	instructions: z
		.string()
		.optional()
		.describe(
			"The errand to run — what the aux should do this invocation. Arrives as a user-role message with sender_role='main' in the aux thread. (for invoke)",
		),
	model: z
		.string()
		.optional()
		.describe("Override the definition's model_hint for this invocation only. (for invoke)"),
	background: z
		.boolean()
		.optional()
		.describe(
			"Run the auxiliary agent in the background without blocking the current loop. Only valid for 'invoke' action. The tool returns immediately with a placeholder; the real result arrives when the aux agent completes. (for invoke)",
		),
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
					"Manage auxiliary-agent identities: define, update, retire, list, or invoke. An auxiliary agent is a durable, persona-scoped identity with its own memory namespace, invoked to handle side errands without dragging the main agent's context or identity along. The persona says who it IS, not what it's for.",
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
				case "invoke":
					// Not idempotent — each invocation creates a new thread.
					return { idempotent: false, readOnly: false };
				default:
					return {};
			}
		},
		execute: async (
			raw: Record<string, unknown>,
			callId?: string,
		): Promise<string | DeferredToolResult> => {
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
					case "invoke":
						return await handleInvoke(ctx, input, callId);
					case "list":
						return handleList(ctx);
					default:
						return `Error: Invalid action '${input.action}'. Valid actions: define, update, retire, list, invoke`;
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

/**
 * #201 Car B: create the child thread + seed the instructions.
 *
 * The thread carries agent_id (the aux identity) and parent_thread_id (the
 * dispatching thread). The instructions arrive as a user-role message with
 * sender_role='main' in metadata — the envelope role axis from step zero.
 *
 * interface='aux' is descriptive only: it must NOT join CLIENT_TOOL_INTERFACES
 * (which gate boundless client-tool relays). Behavioral code identifies aux
 * threads by `agent_id IS NOT NULL`, never by interface.
 *
 * Car C (the nested loop execution) wires the actual agent loop over this
 * thread and blocks for the result. Until then, invoke creates + seeds the
 * thread and returns the handle.
 */
async function handleInvoke(
	ctx: ToolContext,
	input: AuxInput,
	callId?: string,
): Promise<string | DeferredToolResult> {
	if (!input.name) return "Error: 'name' is required for invoke action";
	if (!input.instructions) return "Error: 'instructions' is required for invoke action";

	const nameErr = validateName(input.name);
	if (nameErr) return nameErr;

	// The identity must exist and be active (non-retired).
	const agent = findActiveAgentByName(ctx.db, input.name);
	if (!agent) {
		return `Error: no active auxiliary agent named '${input.name}'. Use action 'define' to create it, or 'list' to see existing identities.`;
	}

	// Resolve the owning human from the parent thread. The aux thread inherits
	// the same user_id so ownership cascades naturally (archive/delete on the
	// parent cascades to children).
	if (!ctx.threadId) {
		return "Error: invoke requires a parent thread context (ctx.threadId is undefined)";
	}
	const parentThreadId = ctx.threadId;
	const parentInfo = findThreadUserAndInterfaceById(ctx.db, ctx.threadId);
	if (!parentInfo) {
		return `Error: parent thread '${ctx.threadId}' not found`;
	}

	const now = new Date().toISOString();
	const threadId = randomUUID();
	const messageId = randomUUID();

	// Create the child thread with the aux identity and parent linkage.
	insertRow(
		ctx.db,
		"threads",
		{
			id: threadId,
			user_id: parentInfo.user_id,
			interface: "aux",
			host_origin: ctx.siteId,
			color: 0,
			title: `aux: ${input.name}`,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			model_hint: input.model ?? agent.model_hint ?? null,
			agent_id: agent.id,
			parent_thread_id: ctx.threadId,
		},
		ctx.siteId,
	);

	// Seed the instructions as a user-role message with sender_role='main'.
	// The #201 sender-envelope role axis stamps this as a main→aux dispatch,
	// distinguishable from user→aux messages (which carry sender_role='user').
	//
	// #76: a background invocation additionally stamps the parent correlation
	// (parent thread + placeholder call_id) on the seed. The correlation lives on
	// durable state — never in this process's memory — so whichever process
	// finishes the run (this one, or the next daemon after a restart) knows
	// exactly which placeholder to resolve.
	const seedMetadata: Record<string, unknown> = { sender_role: "main" };
	if (input.background && callId) {
		seedMetadata.background_parent = {
			thread_id: parentThreadId,
			call_id: callId,
			agent_name: input.name,
		};
	}
	insertRow(
		ctx.db,
		"messages",
		{
			id: messageId,
			thread_id: threadId,
			role: "user",
			content: input.instructions,
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: ctx.siteId,
			deleted: 0,
			exit_code: null,
			metadata: JSON.stringify(seedMetadata),
		},
		ctx.siteId,
	);

	// Background mode (#76): durable, dispatcher-owned execution. The original
	// shape fired an untracked in-process promise, which died with the process
	// and stranded the parent's placeholder forever. Instead, the seed message is
	// enqueued through dispatch_queue and the thread handed to the server
	// dispatcher, which recognizes the correlation stamped on the seed, runs an
	// AuxAgentLoop over the child thread, and resolves the placeholder on
	// completion. Restart recovery is the ordinary dispatch machinery: bootstrap
	// resets interrupted entries to pending; recovery re-dispatches the thread.
	if (input.background && callId) {
		enqueueMessage(ctx.db, messageId, threadId);
		ctx.eventBus.emit("notify:enqueued", { thread_id: threadId });
		return {
			deferred: true,
			description: `Auxiliary agent '${input.name}' queued on thread ${threadId} — running in background. Result will arrive when complete.`,
		};
	}

	// Synchronous mode: execute the nested loop and block for the result.
	if (ctx.auxLoopRunner) {
		const allowlistedTools = agent.tools ? (JSON.parse(agent.tools) as string[]) : null;
		const result = await ctx.auxLoopRunner({
			threadId,
			agentId: agent.id,
			persona: agent.persona,
			modelHint: input.model ?? agent.model_hint ?? null,
			allowlistedTools,
			instructions: input.instructions,
			userId: parentInfo.user_id,
			parentThreadId: ctx.threadId,
		});
		if (result.error) {
			return `Auxiliary agent '${input.name}' completed with error: ${result.error}\n\nThread: ${threadId}`;
		}
		// The thread reference trailer is load-bearing beyond the LLM: the web
		// chat view parses `Thread: <uuid>` out of the persisted tool_result to
		// render an inline card linking to the aux thread (which is excluded
		// from the thread directory, so this card is its only door). Every
		// invoke result shape carries it — keep that property when editing.
		return `${result.summary}\n\nThread: ${threadId}`;
	}

	return `Invoked auxiliary agent '${input.name}' — thread ${threadId} created and seeded with instructions. Agent ID: ${agent.id}. Parent: ${ctx.threadId}. Loop runner not available — thread is ready for manual execution.`;
}
