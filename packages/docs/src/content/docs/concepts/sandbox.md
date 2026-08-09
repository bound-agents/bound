---
title: Sandbox and filesystem
description: How Bound separates its virtual files from host files exposed through boundless.
---

Bound has two filesystem layers that serve different purposes.

## Agent virtual filesystem

The agent works in an in-memory virtual filesystem — not your real disk. When the agent reads or writes a file during a conversation, it's operating on virtual files that live in memory and are persisted to the database. A stray write can never escape onto a real disk.

Files the agent creates are stored in the `files` table and replicated across hosts via sync. When a new agent loop starts, previously persisted files are loaded back into the virtual filesystem.

## Host filesystem access

The `boundless` terminal client can expose host file and shell tools for its working
directory. Shell commands run in an OS-level write-confinement sandbox:

| Platform | Mechanism |
| --- | --- |
| macOS | `seatbelt` (sandbox-exec profile) |
| Linux | `bubblewrap` (`bwrap`) |
| Windows | `IsolationSession` |

The agent can read the host filesystem. Writes are confined to the working directory and
allowed temporary directories.

File operations through `boundless_read`, `boundless_write`, and `boundless_edit` go through the boundless client's own I/O. Shell commands via `boundless_bash` run inside the sandbox.

See [Use the `boundless` terminal client](/bound/guides/boundless/) for the complete
workflow.
