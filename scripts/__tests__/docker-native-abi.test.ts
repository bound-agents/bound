import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const releaseWorkflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const smokeScript = readFileSync(join(root, "scripts/docker-native-abi-smoke.sh"), "utf8");

describe("release Docker native ABI contract", () => {
	test("runs Bun embedded native addons on an Ubuntu 24.04 runtime with its matching C++ ABI", () => {
		expect(dockerfile).toMatch(/^FROM ubuntu:24\.04$/m);
		expect(dockerfile).toMatch(
			/apt-get install -y --no-install-recommends ca-certificates libstdc\+\+6/,
		);
		expect(dockerfile).not.toContain("debian:bookworm");
	});

	test("builds each native architecture on Ubuntu 24.04 and smoke-tests startup plus structure-reader loading", () => {
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04");
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04-arm");
		expect(releaseWorkflow).toContain("- name: Smoke-test native ABI in runtime image");
		expect(releaseWorkflow).toContain("bash scripts/docker-native-abi-smoke.sh");
		expect(releaseWorkflow).toContain(
			"IMAGE: ghcr.io/${{ github.repository }}:${{ github.ref_name }}-${{ matrix.arch }}",
		);
		expect(smokeScript).toContain('docker run -d --rm --name "$container"');
		expect(smokeScript).toContain("-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost");
		expect(smokeScript).not.toMatch(/(?:BIND_HOST|WEB_BIND_HOST)=0\.0\.0\.0/);
		expect(smokeScript).toContain("bound start");
		expect(smokeScript).toContain("bms_read_structure");
		expect(smokeScript).toContain("for _ in {1..5}; do");
	});
});
