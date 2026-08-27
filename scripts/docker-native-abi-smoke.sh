#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?Set IMAGE to the just-built runtime image}"

container="bound-native-abi-smoke-$RANDOM"
config_dir="$(mktemp -d)"
probe_dir="$(mktemp -d)"
diagnose_failure() {
	printf 'Docker ABI smoke failed; preserving container for inspection: %s\n' "$container" >&2
	printf 'Preserving mounted config directory: %s\n' "$config_dir" >&2
	printf 'Preserving mounted structure-reader probe: %s\n' "$probe_dir" >&2
	docker inspect --format 'container platform={{.Platform}} state={{.State.Status}} exit_code={{.State.ExitCode}}' "$container" >&2 ||
		printf 'Unable to inspect container %s\n' "$container" >&2
	printf '%s\n' '--- runtime ABI diagnostics ---' >&2
	docker run --rm --entrypoint sh "$IMAGE" -c '
		printf "%s\\n" "--- architecture ---"
		uname -m
		printf "%s\\n" "--- OS release ---"
		cat /etc/os-release
		printf "%s\\n" "--- /tmp permissions ---"
		stat -c "%A %a %U:%G %n" /tmp
		printf "%s\\n" "--- /tmp mount flags ---"
		findmnt -no TARGET,OPTIONS /tmp
		printf "%s\\n" "--- dynamic linker libraries ---"
		ldconfig -p | grep -E "libstdc\\+\\+|libc\\.so" || true
		printf "%s\\n" "--- libstdc++ GLIBCXX floor ---"
		strings /usr/lib/*/libstdc++.so.6 | grep -E "^GLIBCXX_[0-9.]+$" | sort -V | tail -n 1
	' >&2 || printf '%s\n' 'Unable to collect runtime ABI diagnostics' >&2
	printf '%s\n' '--- container logs ---' >&2
	docker logs "$container" >&2 || printf 'Unable to read logs for container %s\n' "$container" >&2
}

cleanup() {
	local status=$?
	trap - EXIT
	if ((status != 0)); then
		diagnose_failure
		return "$status"
	fi
	docker rm -f "$container" >/dev/null
	rm -rf "$config_dir" "$probe_dir"
}
trap cleanup EXIT

# Use Bun's CLI mode embedded in the release binary to load every grammar through
# its real bindings/node/index.js branch. This is deliberately separate from daemon
# liveness: each parser receives a harmless declaration and must construct a tree.
cat >"$probe_dir/structure-reader-probe.ts" <<'EOF'
import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Kotlin from "tree-sitter-kotlin";
import Python from "tree-sitter-python";
import Ruby from "tree-sitter-ruby";
import Rust from "tree-sitter-rust";
import Swift from "tree-sitter-swift";

const grammars = [
	["bash", Bash, "probe() { :; }"], ["c", C, "int probe(void) { return 0; }"],
	["cpp", Cpp, "class Probe {};"], ["go", Go, "package probe\nfunc Probe() {}"],
	["java", Java, "class Probe {}"], ["kotlin", Kotlin, "class Probe"],
	["python", Python, "class Probe:\n    pass"], ["ruby", Ruby, "class Probe; end"],
	["rust", Rust, "struct Probe;"], ["swift", Swift, "struct Probe {}"],
] as const;
for (const [name, language, source] of grammars) {
	const parser = new Parser();
	parser.setLanguage(language);
	if (parser.parse(source).rootNode.hasError) throw new Error(`${name}: probe parse failed`);
}
console.log(`loaded ${grammars.length} structure-reader grammar addons`);
EOF

printf '%s\n' '{"default_web_user":"smoke","users":{"smoke":{"display_name":"Smoke"}}}' >"$config_dir/allowlist.json"
printf '%s\n' '{"backends":[],"default":""}' >"$config_dir/model_backends.json"
mkdir -p "$probe_dir/node_modules"
docker run -d --name "$container" -v "$config_dir:/app/config:ro" \
	-v "$probe_dir:/probe:ro" -v "$PWD/packages/shared/node_modules:/probe/node_modules:ro" \
	-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost "$IMAGE" >/dev/null

for _ in {1..5}; do
	sleep 1
	if ! docker inspect -f '{{.State.Running}}' "$container" | grep -qx true; then
		exit 1
	fi
done

docker exec "$container" env BUN_BE_BUN=1 /usr/local/bin/bound /probe/structure-reader-probe.ts
printf '%s\n' 'bound startup and direct structure-reader grammar probe passed'
