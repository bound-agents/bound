/**
 * Varying-prefix builder — opens the volatile-tail varying half with
 * User/Thread ID, optional relay routing line, optional platform-
 * silence-semantics block (with Discord formatting note when relevant),
 * and an optional current-model line.
 *
 * Properties pinned by `__tests__/build.property.test.ts`:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, platform, current model.
 *   V4 Platform-tool fallback when `toolNames` is empty.
 *   V5 Platform-tool join with backticks when multiple names.
 *   V6 Discord formatting block iff platform is discord variant.
 *   V7 Optional fields absent -> their lines absent.
 */

export {
	buildVaryingPrefix,
	type BuildVaryingPrefixParams,
	type PlatformContext,
	type RelayInfo,
} from "./build";
