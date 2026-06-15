import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LOG_LEVEL) {
	process.env.LOG_LEVEL = "silent";
	process.env.BOUND_LOG_STDERR = "0";
}

// createSandbox() materializes the embedded WASM workers to disk, defaulting
// to ~/.bound/sandbox-runtime/. Under test that pollutes the developer's real
// bound install, and under the boundless mxc sandbox (seatbelt/bubblewrap)
// writes outside cwd + the system temp dir are denied — so the whole sandbox
// suite died with `EPERM: mkdir '~/.bound/...'` when run through boundless.
// Redirect materialization into $TMPDIR, which the sandbox allows and which is
// safe to share: the materializer keys each binary's assets under a content
// hash subdir + .ready marker, so a stable base path caches the ~30MB copy
// across runs instead of re-copying every time.
if (!process.env.BOUND_SANDBOX_RUNTIME_ROOT) {
	process.env.BOUND_SANDBOX_RUNTIME_ROOT = join(tmpdir(), "bound-sandbox-runtime-test");
}

// Tests run on a single host with no sync, so the cross-host lease-verification
// settle wait in scheduler.runTask provides no value here and only eats into
// the waitFor budgets of scheduler tests. The verification logic itself still
// runs (catches local bugs); only the heuristic settle delay is skipped.
if (!process.env.BOUND_LEASE_VERIFY_SETTLE_MS) {
	process.env.BOUND_LEASE_VERIFY_SETTLE_MS = "0";
}

// The introspect tool polls the target thread's messages on a 2s interval in
// production. Tests exercise the full polling loop (dispatch -> poll -> detect
// response / timeout / error) and pay one or more full 2s sleeps each, which
// dominated the agent suite wall time (~14s in introspect.test.ts alone). The
// polling LOGIC still runs unchanged; only the inter-poll sleep is collapsed.
if (!process.env.BOUND_INTROSPECT_POLL_INTERVAL_MS) {
	process.env.BOUND_INTROSPECT_POLL_INTERVAL_MS = "5";
}
