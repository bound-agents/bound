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

# Shadow any image-local dependency path with an empty mount. Startup must use only
# addons embedded by `bun build --compile`; no runner node_modules are ever mounted.
mkdir -p "$probe_dir/node_modules"

# Exercise the standalone compiled probe; its dependency graph is embedded at build time.
printf '%s\n' '{"default_web_user":"smoke","users":{"smoke":{"display_name":"Smoke"}}}' >"$config_dir/allowlist.json"
printf '%s\n' '{"backends":[],"default":""}' >"$config_dir/model_backends.json"
docker run -d --name "$container" -v "$config_dir:/app/config:ro" -v "$probe_dir:/probe:ro" \
	-v "$probe_dir/node_modules:/app/node_modules:ro" \
	-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost "$IMAGE" >/dev/null

for _ in {1..5}; do
	sleep 1
	if ! docker inspect -f '{{.State.Running}}' "$container" | grep -qx true; then
		exit 1
	fi
done

docker exec "$container" test -d /app/node_modules
docker exec "$container" /usr/local/bin/tree-sitter-native-probe
printf '%s\n' 'bound startup and direct embedded structure-reader grammar probe passed'
