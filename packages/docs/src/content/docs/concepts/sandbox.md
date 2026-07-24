---
title: Sandbox & Filesystem
description: The in-memory virtual filesystem, OCC persistence, command framework, and boundless OS-level write confinement.
---

Bound has two distinct sandboxing layers that solve different problems.

**`@bound/sandbox`** is the agent's server-side virtual filesystem — an in-memory VFS whose contents never reach durable storage until explicitly persisted to the `files` table. A stray write can never escape onto a real disk.

**boundless's filesystem sandbox** guards a real working directory on the operator's host against writes outside it. The whole filesystem is readable, but writes are confined to the working directory and `/tmp`.

## ClusterFs

`createClusterFs` constructs a `MountableFs` instance that routes filesystem paths to different storage backends:

| Mount path | Backend | Notes |
| --- | --- | --- |
| `/` (base) | `InMemoryFs` | Catch-all for everything not otherwise mounted |
| `/home/user` | `InMemoryFs` | The agent's primary working directory |

The agent reads and writes files in this virtual space. Nothing touches the host filesystem.

## OCC persistence

Filesystem persistence uses Optimistic Concurrency Control:

1. **Pre-execution snapshot** — before the agent loop runs, `snapshotWorkspace()` captures a `Map<path, SHA-256 hash>` of in-memory files
2. **Tool execution** — the agent reads, writes, and deletes files in the VFS
3. **Post-execution snapshot** — `FS_PERSIST` state takes another snapshot
4. **Diff** — `diffWorkspace()` compares before/after hashes, producing a `FileChange[]` of created/modified/deleted paths
5. **Persist** — changes are written to the `files` table inside a `BEGIN IMMEDIATE` transaction

If another writer modified a file between snapshot and persist, last-writer-wins (LWW) timestamp resolution applies. Because each loop invocation gets its own snapshot state via a closure, concurrent agent loops on the same `ClusterFs` don't interfere.

## Hydration

Two helpers restore persisted files into a fresh filesystem:

- **`hydrateWorkspace(fs, db)`** — loads all non-deleted rows from `files` (excluding `/mnt/` paths) into the VFS at startup
- **`hydrateRemoteCache(fs, db, hostName)`** — loads rows matching `/mnt/<hostName>/%` to warm the cache for a remote worker's file tree

## Command framework

Custom commands are defined as `CommandDefinition` objects with `name`, `description`, `args`, and an `execute` handler. The agent invokes them through the bash sandbox. MCP server tools are registered as subcommand-dispatched commands — one per server, with a `subcommand` parameter selecting the individual tool.

## boundless filesystem sandbox

When running `boundless`, shell commands execute in an OS-level write-confinement sandbox:

| Platform | Mechanism |
| --- | --- |
| macOS | `seatbelt` (sandbox-exec profile) |
| Linux | `bubblewrap` (`bwrap`) |
| Windows | `IsolationSession` |

The whole filesystem is readable — the agent can inspect any file on your machine. But writes are confined to the current working directory and `/tmp`. This lets the agent explore your codebase freely while preventing accidental writes outside the project.

Files read or written through `boundless_read`, `boundless_write`, and `boundless_edit` go through the boundless client's own I/O, not the sandbox. Shell commands via `boundless_bash` run inside the sandbox.

## File tools

The agent's file operations are exposed as native tools:

- **`read`** — read a file in hashline format (line:hash|content), with offset/limit paging for large files
- **`write`** — create or overwrite a file (atomic, creates parents)
- **`edit`** — edit a file using hashline anchors from a prior read; ranges validated atomically
- **`search`** — regex search across files, returning grep-style matches with hashline anchors

The hashline format serves double duty: it gives the LLM stable anchors to address specific lines without reproducing their text, and the 4-char hash survives line drift so edits land correctly even if the file shifted since the read.
