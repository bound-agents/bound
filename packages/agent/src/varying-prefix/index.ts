/**
 * Varying-prefix builder — opens the volatile-tail varying half with
 * User/Thread ID, optional relay routing line, and an optional
 * current-model line.
 *
 * Properties pinned by `__tests__/build.property.test.ts`:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, current model.
 *   V7 Optional fields absent -> their lines absent.
 *   V8 No embedded newlines in any single emitted line.
 */

export {
	buildVaryingPrefix,
	type BuildVaryingPrefixParams,
	type RelayInfo,
} from "./build";
