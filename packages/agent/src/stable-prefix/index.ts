/**
 * Stable-prefix subsystem barrel.
 *
 * The R-VC24 stable subsection of the volatile context is rendered
 * through a single seam — `composeStableVolatileSubsection` — whose
 * input type (`StableVolatileInputs`) declares every signal allowed
 * to influence the byte output. Drift between the declared inputs
 * and the rendered output is detected post-hoc by the validator at
 * `../validation/run-stable-prefix-drift-validation.ts`, which
 * compares per-turn hashes recorded on `context_debug`.
 *
 * See `types.ts`, `compose.ts`, and `hash.ts` for module-level
 * rationale.
 */

export {
	collectStableVolatileInputs,
	type LoadedStableInputs,
	projectStableVolatileInputs,
} from "./collect";
export { composeStableVolatileSubsection, renderSkillIndex } from "./compose";
export { hashStableVolatileInputs, hashSystemPromptString } from "./hash";
export type {
	DetailEntryView,
	MemoryEntryView,
	SkillIndexView,
	StableVolatileInputs,
} from "./types";
