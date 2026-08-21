---
title: Sandbox and filesystem
description: How Bound separates replicated virtual files from host files exposed by a terminal session.
---

Bound exposes two filesystem models with different storage, availability, and security
boundaries. Distinguishing them explains why a file can be durable across agent turns but
separate from a project on your computer.

## Operation and boundary matrix

| Operation | Agent virtual filesystem | Connected client filesystem |
| --- | --- | --- |
| Read a file | Reads database-backed virtual content | Reads through tools supplied by a connected terminal client, subject to that client process's OS permissions |
| Write or edit a file | Changes virtual content persisted by Bound | Changes host content within the client's write boundary |
| Run a shell command | Not part of this filesystem model | Runs through the client under OS-level write confinement |
| Continue on another turn | Persisted virtual files remain available | Requires an applicable client session and its tools |
| Appear on another Bound host | Selected virtual file state can synchronize | Client files do not synchronize through Bound's file state |

The tool name and active client context determine which boundary an operation uses; a
similar-looking path or filename does not join the two filesystems.

## Agent virtual filesystem

The agent virtual filesystem is an in-memory workspace backed by Bound's database. Reads
and writes operate on virtual files rather than directly on a host disk.

This model gives the agent durable working files without granting host filesystem access.
Its contents follow Bound's state model rather than the directory layout of a connected
computer.

## Connected client filesystem

A connected `boundless` terminal client—the command-line client that connects a local
working directory to Bound—can provide file and shell tools. These tools operate on the
connected client's filesystem, so their availability and effects are tied to that session
rather than to the replicated virtual filesystem.

Reads can reach files that the client process's operating-system permissions allow. Writes
and shell commands are subject to OS-level write confinement: writes are limited to the
client's working directory and allowed temporary directories. macOS uses seatbelt, Linux uses
bubblewrap, and Windows uses Bound's one-shot AppContainer lowbox. On Windows, the CI oracle
proves allowed-root writes, sibling/traversal/junction denial, descendant-tree cancellation,
and watcher-owned profile, ACL, and journal cleanup. `.git/config` and `.git/hooks` remain
read-only on every platform while Git's index, refs, logs, and objects remain writable. This
boundary does not make client files part of the virtual filesystem or replicate them to other
Bound hosts.

## Next steps

- [Use the `boundless` terminal client](/bound/guides/boundless/) to connect a working
  directory and use its file and shell tools.
- [Agent tools](/bound/reference/agent-tools/) lists the available file and shell operations.
- [Security boundaries](/bound/concepts/security-boundaries/) explains the surrounding trust
  model and why client access should remain scoped.
