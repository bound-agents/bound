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
