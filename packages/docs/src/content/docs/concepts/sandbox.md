---
title: Sandbox & Filesystem
description: How the agent reads and writes files, and how boundless confines shell commands.
---

Bound has two filesystem layers that serve different purposes.

## Agent virtual filesystem

The agent works in an in-memory virtual filesystem — not your real disk. When the agent reads or writes a file during a conversation, it's operating on virtual files that live in memory and are persisted to the database. A stray write can never escape onto a real disk.

Files the agent creates are stored in the `files` table and replicated across hosts via sync. When a new agent loop starts, previously persisted files are loaded back into the virtual filesystem.

## Boundless filesystem sandbox

When using `boundless` (the terminal client), the agent gets real filesystem tools that operate on your actual working directory. Shell commands run in an OS-level write-confinement sandbox:

| Platform | Mechanism |
| --- | --- |
| macOS | `seatbelt` (sandbox-exec profile) |
| Linux | `bubblewrap` (`bwrap`) |
| Windows | `IsolationSession` |

The whole filesystem is readable — the agent can inspect any file on your machine. But writes are confined to the current working directory and `/tmp`. This lets the agent explore your codebase freely while preventing accidental writes outside the project.

File operations through `boundless_read`, `boundless_write`, and `boundless_edit` go through the boundless client's own I/O. Shell commands via `boundless_bash` run inside the sandbox.

See [Boundless](/bound/guides/boundless/) for more on the terminal client.
