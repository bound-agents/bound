import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { LLMBackend, ModelRouter } from "@bound/llm";
import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";
import { context as otelContext, trace } from "@opentelemetry/api";
import { z } from "zod";
import { resolveModel } from "../model-resolution";
import { createRelayBackend } from "../relay-backend";
import type { RegisteredTool, ToolContext } from "../types";
import {
	type JsonValue,
	type YardHost,
	type YardInferenceRequest,
	runYardProgram,
} from "../yard/driver";
import { parseToolInput, zodToToolParams } from "./tool-schema";

/**
 * Yard — actionless native tool that executes a bounded JavaScript generator
 * in QuickJS (slice 2 of the Yard design plan: registry wiring). The guest
 * program keeps corpus-scale intermediates outside conversation history and
 * yields branded effects; this file implements the `YardHost` seam over
 * Bound's existing dispatch paths:
 *
 * - tool effects  → the unified tool registry (via `ctx.getToolRegistry`),
 *   so schema validation, structural denials, and side-effect policy are
 *   exactly what a direct call would get;
 * - inference     → `resolveModel` + the local backend's `chat()` stream
 *   (remote/relayed models are a follow-up slice — Yard refuses them loudly
 *   rather than resolving to a different model silently).
 *
 * Tree-wide limits ride an AsyncLocalStorage scope: the ROOT invocation owns
 * one absolute deadline and one leaf-concurrency semaphore; a nested
 * `tool("yard", ...)` call (dispatched through the same registry entry)
 * detects the scope, inherits both unchanged, and increments depth. Nested
 * calls must omit `budget` (design decision) and never acquire a leaf permit
 * — only ordinary tools and inference do, so a waiting parent can't starve
 * its children.
 */

const MAX_YARD_DEPTH = 4;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INFER_MAX_TOKENS = 4096;

interface YardRunScope {
	deadlineAt: number;
	semaphore: Semaphore;
	depth: number;
	/** Root tree id — shared by every run in the recursive tree. */
	traceId: string;
	/** Tree-wide leaf concurrency, recorded on each run span. */
	concurrency: number;
	/** Monotonic sequence shared by every run/effect in the tree. */
	sequence: { value: number };
	/** Current run id; effects use it for client-side grouping. */
	runId?: string;
	/** Outer yard tool call id, exposed on the root event for UI correlation. */
	toolCallId?: string;
	/**
	 * Tree-wide cancellation. The ROOT invocation owns the controller and a
	 * timer that fires it at the absolute deadline; every descendant shares
	 * the same signal. Passed into backend.chat() (local drivers and the
	 * relay backend both honor ChatParams.signal — the relay side writes a
	 * relay cancel), and raced against tool executes, so deadline expiry
	 * CANCELS in-flight work instead of merely abandoning the await.
	 */
	abort: AbortController;
}

function getTracer() {
	return trace.getTracer("bound.yard");
}

/** Bounded content identifier for trace attributes (never the content itself). */
function hash16(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Carries the root scope across nested yard executions. The nested call
 * arrives through the ordinary registry dispatch (`tool.execute`), which
 * stays on the same async continuation as the parent's `dispatchTool`, so
 * the store is visible without any explicit threading.
 */
const yardRunStorage = new AsyncLocalStorage<YardRunScope>();
const yardNodeStorage = new AsyncLocalStorage<string | null>();

const PREVIEW_LIMIT = 4000;
function preview(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	if (text.length <= PREVIEW_LIMIT) return text;
	const half = Math.floor((PREVIEW_LIMIT - 32) / 2);
	return `${text.slice(0, half)}\n… truncated ${text.length - half * 2} chars …\n${text.slice(-half)}`;
}

function emitLifecycle(
	ctx: ToolContext,
	scope: YardRunScope,
	event: Omit<YardExecutionEvent, "thread_id" | "trace_id" | "seq">,
): void {
	if (!ctx.threadId) return;
	try {
		ctx.eventBus.emit("yard:execution", {
			...event,
			thread_id: ctx.threadId,
			trace_id: scope.traceId,
			seq: ++scope.sequence.value,
		});
	} catch (error) {
		ctx.logger.debug("[yard] lifecycle listener failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Counting semaphore for tree-wide leaf-work concurrency. */
class Semaphore {
	private available: number;
	private waiters: Array<() => void> = [];

	constructor(permits: number) {
		this.available = permits;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		this.available += 1;
	}
}

/**
 * Reject `promise` when the tree's absolute deadline passes or its abort
 * signal fires. The root scope owns one AbortController whose timer fires at
 * the deadline, so "deadline expired" and "cancelled" converge on the same
 * signal — in-flight operations that honor ChatParams.signal are CANCELLED
 * (relay writes a relay cancel; local drivers abort the provider stream),
 * not merely abandoned.
 */
async function raceDeadline<T>(
	promise: Promise<T>,
	scope: Pick<YardRunScope, "deadlineAt" | "abort">,
	what: string,
): Promise<T> {
	const remaining = scope.deadlineAt - Date.now();
	if (remaining <= 0 || scope.abort.signal.aborted) {
		throw new Error(`yard deadline exceeded before ${what}`);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				const fail = () =>
					reject(new Error(`yard deadline exceeded during ${what} (root timeout)`));
				timer = setTimeout(fail, remaining);
				onAbort = fail;
				scope.abort.signal.addEventListener("abort", fail, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) scope.abort.signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Minimal JSON Schema subset validator for `infer()` results: `type`,
 * `properties`, `required`, `items`, `enum`. Yard performs no hidden
 * schema-repair inference (design decision) — a violation fails the effect
 * and the guest program decides whether to retry. The subset matches what
 * classification/extraction programs actually send; unknown keywords are
 * ignored rather than rejected so standard schemas remain usable.
 */
function validateAgainstSchema(
	value: unknown,
	schema: Record<string, unknown>,
	path: string,
): string[] {
	const errors: string[] = [];
	const type = schema.type;
	if (typeof type === "string") {
		const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		const expected = type === "integer" ? "number" : type;
		if (actual !== expected) {
			errors.push(`${path || "$"}: expected ${type}, got ${actual}`);
			return errors;
		}
		if (type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
			errors.push(`${path || "$"}: expected integer`);
		}
	}
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
	) {
		errors.push(`${path || "$"}: value not in enum`);
	}
	if (
		schema.type === "object" &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		const record = value as Record<string, unknown>;
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (typeof key === "string" && !(key in record)) {
					errors.push(`${path || "$"}: missing required property "${key}"`);
				}
			}
		}
		const properties = schema.properties;
		if (properties !== null && typeof properties === "object") {
			for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
				if (key in record && sub !== null && typeof sub === "object") {
					errors.push(
						...validateAgainstSchema(record[key], sub as Record<string, unknown>, `${path}.${key}`),
					);
				}
			}
		}
	}
	if (schema.type === "array" && Array.isArray(value)) {
		const items = schema.items;
		if (items !== null && typeof items === "object") {
			value.forEach((item, i) => {
				errors.push(
					...validateAgainstSchema(item, items as Record<string, unknown>, `${path}[${i}]`),
				);
			});
		}
	}
	return errors;
}

/** Strip a Markdown code fence if the model wrapped its JSON in one. */
function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
	return match ? (match[1] as string) : trimmed;
}

/**
 * Recover an `input` object that crossed the tool boundary as JSON *text*.
 *
 * Models routinely emit nested object params as a JSON string rather than a
 * nested object, and `input` is `z.any()`, so a string passes validation. The
 * driver then `JSON.stringify()`s it and the guest `JSON.parse()`s it straight
 * back to the same string — a faithful round-trip of the wrong thing, leaving
 * the guest with `typeof input === "string"` and every `input.field` undefined.
 * Same class as the tavily list-arg serialization.
 *
 * Only strings that parse to an object or array are recovered: a scalar string
 * ("hello", "42", "true") is a legitimate input value and is passed through
 * untouched, so this cannot swallow a deliberate string payload.
 */
export function normalizeYardInput(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed !== null && typeof parsed === "object" ? parsed : raw;
	} catch {
		return raw;
	}
}

const yardSchema = z.object({
	program: z
		.string()
		.describe("Complete JavaScript generator program defining `function* main(input) { ... }`."),
	input: z
		.any()
		.optional()
		.describe(
			"JSON-compatible value exposed to the program as `input` (deeply frozen). A JSON *string* encoding an object or array is decoded first, so a stringified nested param still reaches the guest as a value; scalar strings pass through unchanged.",
		),
	budget: z
		.object({
			timeout_seconds: z
				.number()
				.positive()
				.describe("Absolute deadline for the complete recursive Yard tree."),
			concurrency: z
				.number()
				.int()
				.min(1)
				.describe("Tree-wide cap on concurrently-running leaf effects (tools/inference/aux)."),
		})
		.strict()
		.optional()
		.describe(
			"Optional limits for the complete recursive Yard tree. Nested yard calls must omit this and inherit the root values.",
		),
});

type YardInput = z.infer<typeof yardSchema>;

/**
 * Steering error for a Yard running inside an auxiliary agent (ctx.agentId
 * set). The aux toolset structurally excludes `aux` (EXCLUDED_TOOLS in
 * agent-factory): nested fan-out would deadlock the shared concurrency cap
 * and escalate past the capability boundary. Incident 5411b76f/5076d967: an
 * aux discovered this only at dispatch, mid-graph, and degraded into a
 * 20-minute serial tool() grind. The message names the alternative, not just
 * the prohibition.
 */
const AUX_INSIDE_AUX_REASON =
	"aux() is not available inside an auxiliary agent: the aux toolset structurally excludes the aux tool, so nested aux fan-out cannot run. Do the errand's work directly with tool() effects, or return your findings and let the main agent orchestrate any further aux dispatch.";

/** Prepended to the yard description an aux agent sees, so the doomed program is never written. */
const AUX_UNAVAILABLE_NOTICE =
	"NOTE: aux() is not available in this Yard — you are running inside an auxiliary agent, and nested aux dispatch is structurally excluded. Use tool() and infer() effects to do the work directly, or return your findings so the main agent can orchestrate further aux fan-out.";

const YARD_DESCRIPTION = `Execute a bounded JavaScript generator while retaining intermediate values outside conversation history. This is a HIGH-LEVEL ORCHESTRATION tool: the unit of work is normally an agent — scatter \`aux()\` specialists across partitions, gather their findings into structured form with \`infer()\`, re-scatter implementers, gate acceptance with a reviewer — while corpus-scale intermediates stay inside the program and only the final JSON value returns to you.

Before writing a nontrivial program, activate the \`yard-recipes\` skill — it carries the working recipes (scatter-gather, review gates, partitioning doctrine) and the failure modes that waste runs. The \`aux-agents\` skill covers designing the identities those recipes dispatch.

The \`program\` must define \`function* main(input) { ... }\` and return a JSON-compatible value. Yard has no ambient I/O — no fetch, process, filesystem, modules, clock, randomness, timers, promises, or async/await. Request external work by yielding branded effects created only by these globals:

- \`input\` — deeply frozen JSON-compatible \`input\` from this tool call.
- \`tool(name, args)\` — create an effect for an ordinary Bound tool in your current effective toolset. Use the tool's normal argument schema.
- \`infer(modelId, { prompt, input?, schema?, max_tokens? })\` — create an ephemeral inference effect using the required explicit model ID. Returns a string without \`schema\`, or validated JSON with \`schema\`. No hidden schema repair: a violation fails the effect; retry explicitly if needed.
- \`aux(name, instructions, options?)\` — shorthand for \`tool("aux", { action: "invoke", name, instructions, ...options })\`. Invocations are synchronous only: \`background: true\` is rejected at dispatch (deferred results have no resolution path inside a Yard run). For concurrent aux work, yield several aux effects through \`all()\` instead.
- \`all(effects, { concurrency?, errors? }?)\` — create a parallel compound effect. \`errors\` is "fail-fast" by default or "settled" (input-ordered \`{ status, value | reason }\` entries); results preserve input order.
- \`sequence(effects)\` — create an ordered, fail-fast compound effect.

Constructors do not execute work. \`yield\` an effect to suspend the generator; Yard dispatches it and resumes the generator with its result. A failed effect is thrown into the generator as a catchable Error. Plain effect-shaped objects are rejected — only the constructors above create dispatchable effects. All values crossing the boundary must be JSON-compatible.

Choosing the right effect: \`infer()\` is pure text-to-text — the invoked model has NO tools, no filesystem, and sees nothing beyond your \`prompt\` and \`input\`. Asking it to "inspect the repository" or "apply edits" fails structurally; it can only answer from data you hand it. Gather data with \`tool()\` effects and pass it in. Reach for \`aux()\` when the sub-errand itself needs tools plus judgment — an aux agent runs a real tool loop and can read and edit files itself. Rule of thumb: \`aux()\` is the normal unit of substantive work; \`infer()\` structures and synthesizes between stages; \`tool()\` is glue — enumeration up front, verification at the end. If the program's core work is a chain of raw \`tool()\` calls, that work usually belongs inside an \`aux()\` errand instead.

Size the program to the WHOLE task, on the FIRST attempt. A corpus-scale request ("clean up the codebase", "audit every handler") deserves a partitioned plan from the start — not a hand-run survey in your own loop before reaching for Yard, and not one or two broadly-scoped errands that sample the surface. Enumerate the units first (\`tool()\` a listing or search), then fan out one \`aux()\` per partition through \`all()\` with real concurrency, each with an explicit scope and a concrete standard for what to change. A partition is the smallest unit one agent can exhaustively cover and verify — a directory or a batch of a few files, not a group of packages; dozens of concurrent aux agents is the normal shape for repo-wide work, not an escalation. Make the program return per-partition outcomes (files touched, items skipped and why) so coverage is checkable from the result — a single blended summary hides unworked ground. Budget generously (\`timeout_seconds\`, \`concurrency\`) rather than shrinking the plan to fit a default.

Example — run concurrent specialist reviews, then synthesize their findings:

\`\`\`js
function* main(input) {
  const reviews = yield all([
    aux("pricing-skeptic", input.pricing_question),
    aux("yard-ui-scout", input.ui_question),
  ], { concurrency: 2, errors: "settled" });

  const synthesis = yield infer(input.planner_model, {
    prompt: "Synthesize a compact decision artifact. Preserve disagreements and name the next implementation slice.",
    input: reviews,
    schema: {
      type: "object",
      properties: {
        decision: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
        next_slice: { type: "string" },
      },
      required: ["decision", "risks", "next_slice"],
    },
  });
  return { reviews, synthesis };
}
\`\`\`

Example — scatter-gather a corpus-scale change: read-agents survey every partition, \`infer()\` structures the plan, write-agents implement it, reviewer agents gate acceptance and failures re-dispatch once:

\`\`\`js
function* main(input) {
  // Partitions via one glue tool() call — the work itself belongs to agents.
  const listing = String(yield tool("boundless_bash", { command: "ls -d packages/*/" }));
  const pkgs = listing.match(/^packages\\/[\\w-]+(?=\\/)/gm) ?? [];
  if (pkgs.length === 0) throw new Error("no partitions");

  // SCATTER: a read-agent surveys each partition. No edits yet.
  const surveys = yield all(
    pkgs.map((pkg) => aux("scout", \`Survey \${pkg} for: \${input.goal}. List candidate files with reasons; make NO edits.\`)),
    { concurrency: 4 },
  );

  // GATHER: structure the free-text reports into per-partition work orders.
  const orders = yield infer(input.planner_model, {
    prompt: \`Turn each survey into a concrete work order for: \${input.goal}. No real candidates => skip=true.\`,
    input: pkgs.map((pkg, i) => ({ pkg, survey: surveys[i] })),
    schema: { type: "array", items: {
      type: "object",
      properties: { pkg: { type: "string" }, skip: { type: "boolean" }, order: { type: "string" } },
      required: ["pkg", "skip", "order"],
    } },
  });

  // RE-SCATTER: a write-agent implements each order.
  let active = orders.filter((o) => !o.skip);
  yield all(
    active.map((o) => aux("implementer", \`In \${o.pkg}, do exactly this, then report per-file outcomes: \${o.order}\`)),
    { concurrency: 4 },
  );

  // REVIEW GATE: reviewer agents inspect the real diffs; infer() structures
  // their verdicts; failed partitions re-dispatch once with the objections.
  const outcomes = [];
  for (let round = 0; active.length > 0; round++) {
    const reviews = yield all(
      active.map((o) => aux("reviewer", \`Run git diff -- \${o.pkg} and judge whether the changes satisfy: \${o.order}. Name specific gaps.\`)),
      { concurrency: 4 },
    );
    const verdicts = yield infer(input.planner_model, {
      prompt: "For each review, decide pass/fail and extract the objections.",
      input: active.map((o, i) => ({ pkg: o.pkg, review: reviews[i] })),
      schema: { type: "array", items: {
        type: "object",
        properties: { pass: { type: "boolean" }, objections: { type: "string" } },
        required: ["pass", "objections"],
      } },
    });
    const failed = [];
    active.forEach((o, i) => {
      if (!verdicts[i].pass && round === 0) failed.push({ ...o, objections: verdicts[i].objections });
      else outcomes.push({ pkg: o.pkg, pass: verdicts[i].pass, objections: verdicts[i].objections });
    });
    if (failed.length > 0) {
      yield all(
        failed.map((o) => aux("implementer", \`Rework \${o.pkg} — the reviewer rejected it: \${o.objections}. Original order: \${o.order}\`)),
        { concurrency: 4 },
      );
    }
    active = failed;
  }
  return { partitions: pkgs.length, skipped: orders.filter((o) => o.skip).map((o) => o.pkg), outcomes };
}
\`\`\`

\`tool("yard", ...)\` may recursively invoke Yard. Nested calls run in isolated child runtimes, must omit \`budget\`, and inherit the root deadline and concurrency unchanged. Returns \`{ result, trace_id, usage }\` as JSON.`;

/**
 * Wrap one effect dispatch in a `yard.effect` span under the ambient
 * `yard.run` span, so per-effect timing and status land on the tree trace
 * (design plan, "Trace": each yielded tool or inference call and its
 * timing/status).
 */
async function withEffectSpan<T>(
	ctx: ToolContext,
	scope: YardRunScope,
	node: YardExecutionNode,
	attributes: Record<string, string | number>,
	fn: () => Promise<T>,
): Promise<T> {
	const nodeId = randomUUID();
	const parentId = yardNodeStorage.getStore() ?? null;
	const runId = scope.runId ?? scope.traceId;
	emitLifecycle(ctx, scope, {
		run_id: runId,
		node_id: nodeId,
		parent_id: parentId,
		phase: "started",
		node,
		started_at: new Date().toISOString(),
	});
	const span = getTracer().startSpan("yard.effect", { attributes }, otelContext.active());
	try {
		const value = await yardNodeStorage.run(nodeId, () =>
			otelContext.with(trace.setSpan(otelContext.active(), span), fn),
		);
		span.setAttribute("yard.effect.status", "ok");
		emitLifecycle(ctx, scope, {
			run_id: runId,
			node_id: nodeId,
			parent_id: parentId,
			phase: "completed",
			node,
			finished_at: new Date().toISOString(),
		});
		return value;
	} catch (err) {
		span.setAttribute("yard.effect.status", "error");
		emitLifecycle(ctx, scope, {
			run_id: runId,
			node_id: nodeId,
			parent_id: parentId,
			phase: "failed",
			node,
			finished_at: new Date().toISOString(),
			summary: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
		});
		throw err;
	} finally {
		span.end();
	}
}

/** Build the YardHost that dispatches effects through Bound's dispatch paths. */
function createYardHost(
	ctx: ToolContext,
	scope: YardRunScope,
	counters: { inferenceTokens: number },
): YardHost {
	return {
		dispatchTool(name: string, args: JsonValue): Promise<unknown> {
			const lifecycleName =
				name === "aux" &&
				args &&
				typeof args === "object" &&
				typeof (args as Record<string, unknown>).name === "string"
					? `aux:${String((args as Record<string, unknown>).name)}`
					: name;
			return withEffectSpan(
				ctx,
				scope,
				{ kind: "tool", name: lifecycleName },
				{ "yard.effect.kind": "tool", "yard.effect.tool": name },
				async () => {
					// Dispatch-time guard for the raw tool("aux", ...) bypass: the aux()
					// constructor already fails at construction, but the driver never
					// trusts guest memory — the same steering error fires here.
					if (name === "aux" && ctx.agentId) {
						throw new Error(AUX_INSIDE_AUX_REASON);
					}
					const registry = ctx.getToolRegistry?.();
					if (!registry) throw new Error("yard has no tool registry wired on this host");
					const tool = registry.get(name);
					if (!tool) throw new Error(`tool "${name}" is not available in the current toolset`);
					// Client tools are awaitable inside Yard: dispatch through the live
					// local WS session or relay client_tool/client_result to its host,
					// then resume this generator with the completed value. The shared
					// dispatcher consumes the WS handler's generated result wake so no
					// second agent loop runs this thread.
					if (tool.kind === "client") {
						if (!ctx.executeClientTool) {
							throw new Error(`tool "${name}" has no client dispatcher wired on this host`);
						}
						const remaining = Math.max(1, scope.deadlineAt - Date.now());
						const resolved = await ctx.executeClientTool(
							name,
							args as Record<string, unknown>,
							remaining,
							scope.abort.signal,
						);
						if (!resolved) {
							throw new Error(
								`client tool "${name}" timed out, was cancelled, or has no live session`,
							);
						}
						if (resolved.isError) throw new Error(resolved.content);
						try {
							return JSON.parse(resolved.content);
						} catch {
							return resolved.content;
						}
					}

					// Sandbox-kind registry entries intentionally have no direct execute
					// closure: the loop owns command execution (including MCP bridge
					// subcommands). Use the executor injected by agent-factory so Yard
					// follows the same sandbox rather than implementing a parallel runner.
					const execute = async (): Promise<unknown> => {
						if (tool.kind === "sandbox") {
							if (!ctx.executeSandboxTool) {
								throw new Error(`tool "${name}" has no sandbox executor wired on this host`);
							}
							const record = args as Record<string, unknown>;
							if (typeof record.command !== "string") {
								throw new Error(`tool "${name}" requires a command string`);
							}
							const result = await ctx.executeSandboxTool(
								record.command,
								typeof record.timeout === "number" ? record.timeout : undefined,
								typeof record.cwd === "string" ? record.cwd : undefined,
							);
							const parts = [result.stdout, result.stderr].filter(
								(part): part is string => typeof part === "string" && part.length > 0,
							);
							const content =
								parts.length > 0
									? parts.join("\n")
									: (result.exitCode ?? 0) === 0
										? "Command completed successfully"
										: `Exit code: ${result.exitCode ?? 1}`;
							if ((result.exitCode ?? 0) !== 0) {
								throw new Error(content);
							}
							return content;
						}
						if (!tool.execute) {
							throw new Error(
								`tool "${name}" has no direct execute path and cannot be used from yard`,
							);
						}
						return tool.execute(args as Record<string, unknown>);
					};

					// Nested yard is orchestration, not leaf work — no permit, so a
					// suspended parent can never hold a permit its child needs.
					const isNestedYard = name === "yard";
					if (!isNestedYard) await scope.semaphore.acquire();
					try {
						const raw = await raceDeadline(Promise.resolve(execute()), scope, `tool "${name}"`);
						let content: string;
						if (typeof raw === "string") {
							content = raw;
						} else if (Array.isArray(raw)) {
							content = JSON.stringify(raw);
						} else if (raw !== null && typeof raw === "object" && "deferred" in raw) {
							throw new Error(`tool "${name}" defers to background work; not usable from yard`);
						} else if (raw !== null && typeof raw === "object" && "content" in raw) {
							const inner = (raw as { content: unknown }).content;
							content = typeof inner === "string" ? inner : JSON.stringify(inner);
						} else {
							content = String(raw);
						}
						if (content.startsWith("Error:")) throw new Error(content);
						// Give the guest structured data when the tool returned JSON,
						// else the raw string — same information a direct call yields.
						try {
							return JSON.parse(content);
						} catch {
							return content;
						}
					} finally {
						if (!isNestedYard) scope.semaphore.release();
					}
				},
			);
		},

		dispatchInference(model: string, request: YardInferenceRequest): Promise<unknown> {
			return withEffectSpan(
				ctx,
				scope,
				{ kind: "inference", model },
				{ "yard.effect.kind": "inference", "yard.effect.model": model },
				async () => {
					if (!ctx.modelRouter) throw new Error("yard has no model router wired on this host");
					const resolution = resolveModel(
						model,
						ctx.modelRouter as ModelRouter,
						ctx.db,
						ctx.siteId,
					);
					if (resolution.kind === "error") {
						throw new Error(`model "${model}" failed to resolve: ${resolution.error}`);
					}
					// Local resolution chats in-process; remote wraps the inference
					// relay — the same acquisition split acquireSummaryBackend uses,
					// so a backendless host runs yard infer() exactly like summary
					// extraction. The relay per-host timeout is bounded by whatever
					// remains of the root deadline: a relay hop can never outlive
					// the tree that requested it.
					const backend: LLMBackend =
						resolution.kind === "local"
							? resolution.backend
							: createRelayBackend(
									{
										db: ctx.db,
										eventBus: ctx.eventBus,
										siteId: ctx.siteId,
										logger: ctx.logger,
									},
									resolution.hosts,
									resolution.modelId,
									Math.max(1, scope.deadlineAt - Date.now()),
								);

					const parts: string[] = [request.prompt];
					if (request.input !== undefined) {
						parts.push(`Input:\n${JSON.stringify(request.input)}`);
					}
					if (request.schema !== undefined) {
						parts.push(
							`Respond with ONLY a JSON value that conforms to this JSON Schema — no prose, no code fence:\n${JSON.stringify(request.schema)}`,
						);
					}
					const requested = request.max_tokens ?? DEFAULT_INFER_MAX_TOKENS;
					const maxTokens =
						resolution.maxOutputTokens !== undefined
							? Math.min(requested, resolution.maxOutputTokens)
							: requested;

					await scope.semaphore.acquire();
					try {
						const consume = async (): Promise<string> => {
							const chunks: string[] = [];
							for await (const chunk of backend.chat({
								messages: [{ role: "user", content: parts.join("\n\n") }],
								max_tokens: maxTokens,
								signal: scope.abort.signal,
							})) {
								if (chunk.type === "text") chunks.push(chunk.content);
								if (chunk.type === "done") {
									counters.inferenceTokens += chunk.usage.input_tokens + chunk.usage.output_tokens;
								}
							}
							return chunks.join("").trim();
						};
						const text = await raceDeadline(consume(), scope, `inference on "${model}"`);

						if (request.schema === undefined) return text;

						let parsed: unknown;
						try {
							parsed = JSON.parse(stripCodeFence(text));
						} catch {
							throw new Error(
								`inference output is not valid JSON for the requested schema (model "${model}")`,
							);
						}
						const violations = validateAgainstSchema(
							parsed,
							request.schema as Record<string, unknown>,
							"",
						);
						if (violations.length > 0) {
							throw new Error(
								`inference output violates the requested schema: ${violations.join("; ")}`,
							);
						}
						return parsed;
					} finally {
						scope.semaphore.release();
					}
				},
			);
		},
	};
}

async function runYard(ctx: ToolContext, params: YardInput, scope: YardRunScope): Promise<string> {
	const counters = { inferenceTokens: 0 };
	const host = createYardHost(ctx, scope, counters);
	const startedAt = Date.now();
	// One yard.run span per run in the tree: the root opens under whatever
	// ambient span dispatched the yard tool; a nested run opens under the
	// parent's dispatching yard.effect span, so the OTEL tree mirrors the
	// yard tree. scope.traceId ties the whole tree together; run_id is this
	// run's own identity.
	const runId = randomUUID();
	scope.runId = runId;
	const parentId = yardNodeStorage.getStore() ?? null;
	const runNode: YardExecutionNode = { kind: "run", depth: scope.depth };
	emitLifecycle(ctx, scope, {
		run_id: runId,
		node_id: runId,
		parent_id: parentId,
		phase: "started",
		node: runNode,
		started_at: new Date().toISOString(),
		input_preview: preview(params.input),
		// Program source rides the start event so the boundless card — which
		// REPLACES the persisted request/result rows — can render the generator
		// highlighted without reaching back to the tool_call row.
		program_preview: preview(params.program),
		...(scope.depth === 0 && scope.toolCallId ? { tool_call_id: scope.toolCallId } : {}),
	});
	const span = getTracer().startSpan(
		"yard.run",
		{
			attributes: {
				"yard.trace_id": scope.traceId,
				"yard.run_id": runId,
				"yard.depth": scope.depth,
				"yard.program_hash": hash16(params.program),
				"yard.input_hash": hash16(JSON.stringify(params.input ?? null)),
				"yard.deadline_ms": scope.deadlineAt,
				"yard.concurrency": scope.concurrency,
			},
		},
		otelContext.active(),
	);
	try {
		return await yardNodeStorage.run(runId, () =>
			otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
				try {
					const out = await runYardProgram({
						program: params.program,
						input: normalizeYardInput(params.input) as JsonValue | undefined,
						host,
						// Inside an aux agent, aux() fails at CONSTRUCTION with the
						// steering message — before any effect dispatches — instead of
						// discovering the exclusion mid-graph at dispatch time.
						...(ctx.agentId ? { auxUnavailableReason: AUX_INSIDE_AUX_REASON } : {}),
					});
					out.usage.inference_tokens += counters.inferenceTokens;
					span.setAttributes({
						"yard.tool_calls": out.usage.tool_calls,
						"yard.inference_calls": out.usage.inference_calls,
						"yard.inference_tokens": out.usage.inference_tokens,
						"yard.status": "completed",
						"yard.result_hash": hash16(JSON.stringify(out.result)),
					});
					emitLifecycle(ctx, scope, {
						run_id: runId,
						node_id: runId,
						parent_id: parentId,
						phase: "completed",
						node: runNode,
						finished_at: new Date().toISOString(),
						result_preview: preview(out.result),
						summary: `${out.usage.tool_calls} tools · ${out.usage.inference_calls} inferences`,
					});
					ctx.logger.info("[yard] run completed", {
						traceId: scope.traceId,
						runId,
						depth: scope.depth,
						toolCalls: out.usage.tool_calls,
						inferenceCalls: out.usage.inference_calls,
						inferenceTokens: out.usage.inference_tokens,
						elapsedMs: out.usage.elapsed_ms,
					});
					return JSON.stringify({ result: out.result, trace_id: scope.traceId, usage: out.usage });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					span.setAttribute("yard.status", "failed");
					emitLifecycle(ctx, scope, {
						run_id: runId,
						node_id: runId,
						parent_id: parentId,
						phase: "failed",
						node: runNode,
						finished_at: new Date().toISOString(),
						summary: message.slice(0, 500),
					});
					ctx.logger.info("[yard] run failed", {
						traceId: scope.traceId,
						runId,
						depth: scope.depth,
						elapsedMs: Date.now() - startedAt,
						error: message,
					});
					return message.startsWith("Error:") ? message : `Error: ${message}`;
				}
			}),
		);
	} finally {
		span.end();
	}
}

export function createYardTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(yardSchema);
	// Description-time steering: an aux agent's Yard carries the warning up
	// front so the doomed aux() program is never written (the construction-
	// and dispatch-time guards below remain the enforcement).
	const description = ctx.agentId
		? `${AUX_UNAVAILABLE_NOTICE}\n\n${YARD_DESCRIPTION}`
		: YARD_DESCRIPTION;

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "yard",
				description,
				parameters: jsonSchema,
			},
		},
		execute: async (input: Record<string, unknown>, callId?: string) => {
			const parsed = parseToolInput(yardSchema, input, "yard");
			if (!parsed.ok) return parsed.error;
			if (!ctx.getToolRegistry?.()) {
				return "Error: yard is not wired to a tool registry on this host";
			}

			const parentScope = yardRunStorage.getStore();
			if (parentScope) {
				// Nested call: structural isolation comes from the fresh QuickJS
				// runtime inside runYardProgram; limits are inherited unchanged.
				if (parsed.value.budget) {
					return "Error: nested yard calls must omit budget; the root deadline and concurrency are inherited unchanged";
				}
				if (parentScope.depth + 1 >= MAX_YARD_DEPTH) {
					return `Error: nested yard depth limit reached (max ${MAX_YARD_DEPTH})`;
				}
				const childScope: YardRunScope = { ...parentScope, depth: parentScope.depth + 1 };
				return yardRunStorage.run(childScope, () => runYard(ctx, parsed.value, childScope));
			}

			const budget = parsed.value.budget ?? {
				timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
				concurrency: DEFAULT_CONCURRENCY,
			};
			const deadlineAt = Date.now() + budget.timeout_seconds * 1000;
			const abort = new AbortController();
			// Fire the tree-wide signal AT the deadline so in-flight operations
			// are cancelled (relay cancel written, provider streams torn down),
			// not just abandoned by raceDeadline. Cleared on completion either way.
			const deadlineTimer = setTimeout(
				() => abort.abort(new Error("yard root deadline exceeded")),
				budget.timeout_seconds * 1000,
			);
			const rootScope: YardRunScope = {
				deadlineAt,
				semaphore: new Semaphore(budget.concurrency),
				depth: 0,
				traceId: randomUUID(),
				concurrency: budget.concurrency,
				sequence: { value: 0 },
				toolCallId: callId,
				abort,
			};
			try {
				return await yardRunStorage.run(rootScope, () => runYard(ctx, parsed.value, rootScope));
			} finally {
				clearTimeout(deadlineTimer);
				// Sweep any still-running work the guest left behind (e.g. a
				// settled all() branch whose sibling failed the run).
				if (!abort.signal.aborted) abort.abort(new Error("yard run finished"));
			}
		},
	};
}
