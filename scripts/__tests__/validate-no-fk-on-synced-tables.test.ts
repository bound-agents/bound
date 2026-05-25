/**
 * Self-test for `scripts/validate-no-fk-on-synced-tables.ts`.
 *
 * The validator is itself unit-tested by running it as a subprocess
 * against synthetic schema fixtures: one with no FK clauses (must
 * exit 0), one with a FOREIGN KEY clause (must exit non-zero), one
 * with a REFERENCES clause (must exit non-zero).
 *
 * This style — fixture + subprocess — is intentional: the validator
 * itself reads files via `readFileSync` against the real
 * `packages/core/src/schema.ts`, so unit-testing the inner regex
 * would not catch wiring bugs in the real entry point.
 *
 * For now, we validate the actual production schema is clean by
 * invoking the script directly. Future work: add fixture-based
 * integration tests that swap SCHEMA_FILES via a CLI arg.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

describe("validate-no-fk-on-synced-tables (production schema)", () => {
	it("exits 0 against the current production schema", () => {
		const result = spawnSync("bun", ["run", "scripts/validate-no-fk-on-synced-tables.ts"], {
			cwd: `${import.meta.dir}/../..`,
		});
		expect(result.status).toBe(0);
	});
});

describe("validate-events-after-commit (production source)", () => {
	it("exits 0 against the current production source", () => {
		const result = spawnSync("bun", ["run", "scripts/validate-events-after-commit.ts"], {
			cwd: `${import.meta.dir}/../..`,
		});
		expect(result.status).toBe(0);
	});
});
