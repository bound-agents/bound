#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?Set IMAGE to the just-built runtime image}"

container="bound-native-abi-smoke-$RANDOM"
config_dir="$(mktemp -d)"
cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	rm -rf "$config_dir"
}
trap cleanup EXIT

# `bound start` imports bms_read_structure and its Bun-embedded tree-sitter
# addon. This must be a runtime test: ELF DT_NEEDED cannot expose that addon.
printf '%s\n' '{"default_web_user":"smoke","users":{}}' >"$config_dir/allowlist.json"
printf '%s\n' '{"backends":{}}' >"$config_dir/model_backends.json"
# Keep both listeners in the container namespace. The web server deliberately
# rejects non-loopback binds unless an operator explicitly overrides that guard.
docker run -d --rm --name "$container" -v "$config_dir:/app/config:ro" \
	-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost "$IMAGE" >/dev/null

# `bound start` imports the shared structure reader, which loads Bun's embedded
# tree-sitter addons. Keep the daemon alive across several scheduler turns so
# both import-time ABI failures and startup failures surface.
for _ in {1..5}; do
	sleep 1
	if ! docker inspect -f '{{.State.Running}}' "$container" | grep -qx true; then
		docker logs "$container"
		exit 1
	fi
done

echo "bound startup loaded the bms_read_structure tree-sitter addon"
