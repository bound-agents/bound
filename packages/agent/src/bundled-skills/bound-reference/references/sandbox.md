# Sandbox Reference

The **sandbox** is the environment your file tools (`bms_read`, `bms_write`, `bms_edit`) and
`bms_bash` act on. It is a *virtual filesystem* (VFS) backed by the database, not the
host's real disk. Understanding what is and is not in the sandbox saves you from
two recurring mistakes: looking for host config inside it (it is not there — see
`config.md`), and expecting a `bms_write` to be queryable in the `files` table on the
same turn (the snapshot is deferred — see below).

## What the VFS is

Two implementations, same interface:

- **InMemoryFs** — a single-host in-memory tree.
- **ClusterFs** — the multi-host variant whose contents replicate via the synced
  `files` table, so a file you write on one host appears on others.

File contents live in the `files` table (synced, LWW). Writes go through
**optimistic concurrency control** (OCC): persistence compares hash-to-hash
inside a `BEGIN IMMEDIATE` transaction and emits `file:changed` events only after
commit. You do not manage this — it is what keeps concurrent writers from
clobbering each other — but it explains why a write is a transaction, not a
syscall.

## The deferred-snapshot gotcha

The `files` table is populated by an **end-of-agent-loop snapshot**, not on every
individual `bms_write`. Mid-loop, after you `bms_write` a file, querying `files` for that
path may show the *old* content or no row yet. The write is real and a subsequent
`bms_read` sees it; only the synced catalog lags until the loop ends. Do not "verify"
a write by querying `files` in the same turn and conclude it failed — `bms_read` the
path instead.

## Overlay mounts — reading real codebases

The sandbox can mount real host directories read-through as **overlays** (e.g. a
checked-out repo), configured in `overlay.json`. An overlay scanner indexes those
trees into the `overlay_index` table so you can discover and read source without
the files being copied into the VFS proper. This is how you read a codebase you
are reasoning about. Overlay mounts are read paths; your writable workspace is the
VFS itself.

## The 256 KiB tool-result cap

Every tool result, regardless of kind, is bounded by a universal **256 KiB**
backstop (`capToolResultContent`, `MAX_TOOL_RESULT_BYTES = 256 * 1024`).
Over-cap output is **middle-cut** with a marker:

```
[truncated N bytes from middle; tool result exceeded 262144-byte cap —
 re-run with a narrower scope or pipe through head/grep]
```

If a result looks like it is missing a chunk, grep for that marker — it is the cap
firing, not a bug. The fix is to narrow scope (`head`, `grep`, a tighter path, a
`LIMIT`), not to retry the same broad command. Per-tool caps (line-aware for
`bms_read`, row-aware for `query`) run first; the 256 KiB cap is the final backstop.

## Network access from the sandbox

`bms_bash` runs in a sandbox whose outbound network is gated by a URL filter
(allowlist of prefixes). Do not assume arbitrary `curl`/`fetch` works — a given
deployment's sandbox may have no HTTP client at all, or only an allowlisted set of
destinations. If you need to fetch something, confirm the path exists before
promising a fetch.

## Loop context

Commands running *inside* the agent loop automatically see `threadId` and
`taskId` via `loopContextStorage` (an AsyncLocalStorage exported from
`@bound/sandbox`). Commands invoked *outside* the loop (e.g. an operator running
`boundctl`) do not. This is why a tool can know which thread it belongs to without
being told.

## The boundless distinction

When the current thread is a **boundless** terminal session, you also have
`boundless_read` / `boundless_write` / `boundless_edit` / `boundless_bash`. These
act on the operator's **real local working directory**, NOT the VFS. They are a
different filesystem entirely:

- `bms_read` / `bms_write` / `bms_edit` / `bms_bash` → the sandbox VFS (synced, database-backed).
- `boundless_*` → the host's actual disk in the boundless cwd (not synced).

Mixing them up is a common error: editing a real repo file requires `boundless_edit`,
while `bms_edit` would (silently, harmlessly) write into the VFS instead. The
`boundless_copy` tool moves bytes between the two filesystems without round-tripping
through your context.

## What is NOT in the sandbox

Host configuration. The `config/` directory lives on the host's real disk and is
loaded into `AppContext.config` at startup behind strict Zod schemas — it is not a
VFS path and `bms_read`/`bms_bash` cannot reach it. See `config.md`.
