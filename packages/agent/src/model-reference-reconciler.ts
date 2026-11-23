import type { Database } from "bun:sqlite";
import { analyzeModelReferences, listActiveAdvisories, softDelete } from "@bound/core";
import { createAdvisory } from "./advisories";

/**
 * Advisory lifecycle for the route/model removal and re-introduction lifecycle
 * (2026-11-21-model-routing.md §6.3 R-RT23/R-RT24; 2026-11-21-model-catalog.md
 * §7.3 R-MC13).
 *
 * A cluster role (`default`/`heavy`/`fast`), an aux-agent `model_hint`, or a live
 * scheduled task's `model_hint` that points at a logical model advertised by no
 * non-deleted host is a dangling reference: Bound neither silently reassigns it
 * nor cascade-deletes it. Instead it raises an operator advisory so a human
 * decides, and auto-resolves that advisory once the model is re-advertised
 * anywhere in the cluster. Scheduled tasks matter because heartbeats are never
 * poison-pill parked (scheduler.ts) — a dead heartbeat model_hint re-arms and
 * fails silently forever, so the advisory is the operator's only signal.
 *
 * This reconciler is the write companion of the pure `analyzeModelReferences`
 * read. It is idempotent: a dangling reference whose advisory already exists is
 * not re-raised (dedup by the deterministic title), and a resolved reference's
 * open advisory is soft-deleted exactly once. The stale dormant-preference lists
 * (`route_order` / `route_drains` / `model_aliases` / fallback) are surfaced to
 * Settings for manual pruning and deliberately do NOT raise advisories — they
 * are no-ops, not operator-blocking, per §6.3.
 *
 * Call it on the model-catalog reconcile cadence (a host lineup refresh or a
 * synced `hosts` change), not per turn: the live advertised set only moves when
 * a host's `hosts.models` or liveness row changes.
 */

const DANGLING_TYPE = "model_reference_dangling" as const;

/** Deterministic advisory title for a dangling cluster-role reference. */
function roleTitle(role: string, logicalModel: string): string {
	return `Cluster role "${role}" points at decommissioned model "${logicalModel}"`;
}

/** Deterministic advisory title for a dangling aux-agent reference. */
function agentTitle(agentName: string, logicalModel: string): string {
	return `Aux agent "${agentName}" targets decommissioned model "${logicalModel}"`;
}

/** Deterministic advisory title for a dangling scheduled-task reference. */
function taskTitle(taskId: string, logicalModel: string): string {
	return `Scheduled task "${taskId}" targets decommissioned model "${logicalModel}"`;
}

export interface ReconcileResult {
	/** Dangling advisories newly raised this pass. */
	raised: number;
	/** Open dangling advisories auto-resolved (soft-deleted) this pass. */
	resolved: number;
}

/**
 * Raise advisories for newly-dangling cluster-role and aux-agent model
 * references, and auto-resolve open dangling advisories whose referenced model
 * has returned. Idempotent and safe to call repeatedly. Returns the counts.
 */
export function reconcileModelReferenceAdvisories(db: Database, siteId: string): ReconcileResult {
	const report = analyzeModelReferences(db);

	// The exact set of dangling-reference titles we SHOULD have open right now.
	const expectedTitles = new Set<string>();
	for (const { role, logicalModel } of report.danglingRoles) {
		expectedTitles.add(roleTitle(role, logicalModel));
	}
	for (const { agentName, logicalModel } of report.danglingAgents) {
		expectedTitles.add(agentTitle(agentName, logicalModel));
	}
	for (const { taskId, logicalModel } of report.danglingTasks) {
		expectedTitles.add(taskTitle(taskId, logicalModel));
	}

	// Existing open (non-applied/dismissed, non-deleted) dangling advisories,
	// indexed by title so we can both dedup raises and find auto-resolvable rows.
	const openByTitle = new Map<string, string>(); // title -> advisory id
	for (const advisory of listActiveAdvisories(db)) {
		if (advisory.type === DANGLING_TYPE) openByTitle.set(advisory.title, advisory.id);
	}

	let raised = 0;
	let resolved = 0;

	// Auto-resolve: an open dangling advisory whose reference is no longer
	// dangling (the model came back, or the role/agent was reassigned/removed).
	// Soft-delete rather than dismiss so the row leaves the active surface and
	// a future recurrence raises a fresh advisory with its own provenance.
	for (const [title, id] of openByTitle) {
		if (!expectedTitles.has(title)) {
			softDelete(db, "advisories", id, siteId);
			resolved++;
		}
	}

	// Raise: a currently-dangling reference with no open advisory yet.
	for (const { role, logicalModel } of report.danglingRoles) {
		const title = roleTitle(role, logicalModel);
		if (openByTitle.has(title)) continue;
		createAdvisory(
			db,
			{
				type: DANGLING_TYPE,
				status: "proposed",
				title,
				detail: `The cluster role "${role}" is assigned to logical model "${logicalModel}", which no non-deleted host in the cluster currently advertises (decommissioned). Bound will not silently reassign the role; omitted-model and "${role}"-targeted requests resolve to nothing until you point the role at a live model or the model is re-advertised. This advisory resolves on its own if "${logicalModel}" returns.`,
				action: null,
				impact: `Requests resolving through the "${role}" role fail until the role is reassigned or the model returns.`,
				evidence: `routing.model_roles.${role} = "${logicalModel}"`,
			},
			siteId,
		);
		raised++;
	}
	for (const { agentName, logicalModel } of report.danglingAgents) {
		const title = agentTitle(agentName, logicalModel);
		if (openByTitle.has(title)) continue;
		createAdvisory(
			db,
			{
				type: DANGLING_TYPE,
				status: "proposed",
				title,
				detail: `Auxiliary agent "${agentName}" names logical model "${logicalModel}" in its model_hint, which no non-deleted host in the cluster currently advertises (decommissioned). Bound will not silently substitute another model; invocations of this agent fail until its model_hint is updated or the model is re-advertised. This advisory resolves on its own if "${logicalModel}" returns.`,
				action: null,
				impact: `Invocations of aux agent "${agentName}" fail until its model_hint is updated or the model returns.`,
				evidence: `agents."${agentName}".model_hint -> "${logicalModel}"`,
			},
			siteId,
		);
		raised++;
	}
	for (const { taskId, logicalModel } of report.danglingTasks) {
		const title = taskTitle(taskId, logicalModel);
		if (openByTitle.has(title)) continue;
		createAdvisory(
			db,
			{
				type: DANGLING_TYPE,
				status: "proposed",
				title,
				detail: `Scheduled task "${taskId}" names logical model "${logicalModel}" in its model_hint, which no non-deleted host in the cluster currently advertises (decommissioned). Bound will not silently substitute another model; the task's runs fail validation until its model_hint is updated or the model is re-advertised. Heartbeat tasks are never poison-pill parked, so they keep re-arming and failing silently — this advisory is the only operator signal. This advisory resolves on its own if "${logicalModel}" returns.`,
				action: null,
				impact: `Runs of scheduled task "${taskId}" fail until its model_hint is updated or the model returns.`,
				evidence: `tasks."${taskId}".model_hint -> "${logicalModel}"`,
			},
			siteId,
		);
		raised++;
	}

	return { raised, resolved };
}
