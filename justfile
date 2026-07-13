# Development scripts. Run `just` (no args) to list recipes.

# Absolute path to the .worktrees/ directory, derived from this justfile's location.
worktrees := justfile_directory() / ".worktrees"

# Show available recipes.
_default:
    @just --list

# Create a git worktree under .worktrees/<name>, link AGENTS.md into it, and install deps.
worktree-create name:
    git worktree add -b {{ name }} {{ worktrees }}/{{ name }}
    ln -s {{ justfile_directory() }}/AGENTS.md {{ worktrees }}/{{ name }}/AGENTS.md
    cd {{ worktrees }}/{{ name }} && bun install

# Remove the git worktree at .worktrees/<name> and delete its branch.
worktree-delete name:
    git worktree remove {{ worktrees }}/{{ name }}
    git branch -d {{ name }}

# Compile bound, boundctl, and boundless into dist/.
build:
    bun run build

# Build, then atomically install bound/boundctl/boundless into ~/.local/bin.
#
# Deliberately NOT a plain `cp dist/bound* ~/.local/bin/`: `cp` onto an existing
# destination overwrites the resident inode's bytes in place. On macOS 26+, AMFI's
# lazy page-by-page signature validation can SIGKILL a process launched from that
# path if the kernel's page cache still holds pages from a still-running (or just-
# exited) prior instance at the same inode — bare `[1] <pid> killed boundless ...`
# with a `SIGKILL (Code Signature Invalid)` / `Taskgated Invalid Signature` crash
# report. `scripts/build.ts` already re-signs each freshly-compiled binary with a
# plain adhoc signature (`codesign --force --sign -`) to protect the build output
# itself, but that doesn't cover the install step: writing to a temp file in the
# *same directory* and renaming it over the destination swaps the inode the path
# points to instead of mutating the one that might still be mapped, which
# sidesteps the race the same way at the install hop.
install: build
    mkdir -p ~/.local/bin
    for bin in bound boundctl boundless; do \
        cp dist/$bin ~/.local/bin/$bin.tmp && \
        chmod +x ~/.local/bin/$bin.tmp && \
        mv -f ~/.local/bin/$bin.tmp ~/.local/bin/$bin; \
    done
    @echo "Installed bound, boundctl, boundless -> ~/.local/bin/"
