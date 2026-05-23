if (!process.env.LOG_LEVEL) {
	process.env.LOG_LEVEL = "silent";
	process.env.BOUND_LOG_STDERR = "0";
}

// Tests run on a single host with no sync, so the cross-host lease-verification
// settle wait in scheduler.runTask provides no value here and only eats into
// the waitFor budgets of scheduler tests. The verification logic itself still
// runs (catches local bugs); only the heuristic settle delay is skipped.
if (!process.env.BOUND_LEASE_VERIFY_SETTLE_MS) {
	process.env.BOUND_LEASE_VERIFY_SETTLE_MS = "0";
}
