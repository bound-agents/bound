/**
 * Varying-tail subsystem barrel.
 *
 * The R-VC24 varying tail is rendered through a single seam —
 * `composeVolatileVarying` — whose input type
 * (`VolatileVaryingInputs`) declares every signal allowed to
 * influence byte output. `nowMs` is the only allowed wall-clock
 * ingress; otherwise the renderer is pure in inputs.
 *
 * See `types.ts`, `compose.ts` for module-level rationale and the
 * R-VC26 invariant in `docs/design/specs/2026-05-22-volatile-context.md` §10.
 */

export { composeVolatileVarying } from "./compose";
export type {
	AdvisoryEntryView,
	CrossThreadEntryView,
	FileEntryView,
	LiveStateView,
	RecentMemoryEntryView,
	StaleChildView,
	TaskEntryView,
	VolatileVaryingInputs,
	WorkingKnowledgeUpdatesView,
} from "./types";
