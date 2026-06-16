worktree-create NAME:
    git worktree add -b {{ NAME }} {{ justfile_directory() }}/.worktrees/{{ NAME }}
    ln -s {{ justfile_directory() }}/AGENTS.md {{ justfile_directory() }}/.worktrees/{{ NAME }}/AGENTS.md
    (cd {{ justfile_directory() }}/.worktrees/{{ NAME }} && bun install)

worktree-delete NAME:
    git worktree remove {{ NAME }}
