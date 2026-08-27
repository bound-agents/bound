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

	test("builds each native architecture on Ubuntu 24.04 and directly probes every structure-reader grammar", () => {
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04");
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04-arm");
		expect(releaseWorkflow).toContain("fail-fast: false");
		expect(releaseWorkflow).toContain("build-essential python3 make g++ node-gyp");
		expect(releaseWorkflow).toMatch(
			/bun install --frozen-lockfile[\s\S]*bun run scripts\/tree-sitter-native-staging\.ts[\s\S]*bun run build/,
		);
		expect(releaseWorkflow).toContain("- name: Smoke-test native ABI in runtime image");
		expect(releaseWorkflow).toContain("bash scripts/docker-native-abi-smoke.sh");
		expect(releaseWorkflow).toContain(
			"IMAGE: ghcr.io/${{ github.repository }}:${{ github.ref_name }}-${{ matrix.arch }}",
		);
		expect(smokeScript).toContain(
			'{"default_web_user":"smoke","users":{"smoke":{"display_name":"Smoke"}}}',
		);
		expect(smokeScript).toContain('{"backends":[],"default":""}');
		expect(smokeScript).not.toContain('docker run -d --rm --name "$container"');
		expect(smokeScript).toContain('docker run -d --name "$container"');
		expect(smokeScript).toContain(
			"printf 'Docker ABI smoke failed; preserving container for inspection: %s\\n' \"$container\" >&2",
		);
		expect(smokeScript).toContain("docker inspect --format");
		expect(smokeScript).toContain("uname -m");
		expect(smokeScript).toContain("/etc/os-release");
		expect(smokeScript).toContain('stat -c "%A %a %U:%G %n" /tmp');
		expect(smokeScript).toContain("findmnt -no TARGET,OPTIONS /tmp");
		expect(smokeScript).toContain("ldconfig -p | grep -E");
		expect(smokeScript).toContain("strings /usr/lib/*/libstdc++.so.6");
		expect(smokeScript).toContain("sort -V | tail -n 1");
		expect(smokeScript).toContain('docker logs "$container" >&2 || printf');
		expect(smokeScript).toMatch(
			/if \(\(status != 0\)\); then[\s\S]*return "\$status"[\s\S]*docker rm -f "\$container"/,
		);
		expect(smokeScript).not.toMatch(/docker rm -f "\$container"[^\n]*\|\| true/);
		expect(smokeScript).toContain("-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost");
		expect(smokeScript).not.toMatch(/(?:BIND_HOST|WEB_BIND_HOST)=0\.0\.0\.0/);
		expect(smokeScript).toContain("for _ in {1..5}; do");
		expect(smokeScript).toContain(
			"BUN_BE_BUN=1 /usr/local/bin/bound /probe/structure-reader-probe.ts",
		);
		expect(smokeScript).toContain('mkdir -p "$probe_dir/node_modules"');
		expect(smokeScript).toMatch(
			/mkdir -p "\$probe_dir\/node_modules"[\s\S]*-v "\$probe_dir:\/probe:ro" -v "\$PWD\/packages\/shared\/node_modules:\/probe\/node_modules:ro"/,
		);
		expect(smokeScript).toContain('-v "$PWD/packages/shared/node_modules:/probe/node_modules:ro"');
		expect(smokeScript).toContain('import Cpp from "tree-sitter-cpp"');
		expect(smokeScript).toContain('import Kotlin from "tree-sitter-kotlin"');
		expect(smokeScript).toContain('import Swift from "tree-sitter-swift"');
		expect(smokeScript).toContain("parser.setLanguage(language)");
		expect(smokeScript).toContain("loaded ${grammars.length} structure-reader grammar addons");
	});
});
