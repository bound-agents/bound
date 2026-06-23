# Domain query modules

Cross-table read queries that no single-table finder in the parent
`repositories/` directory can hold — JOINs, aggregates spanning multiple synced
tables, and operation-shaped reads.

Conventions:

- Named by the **operation**, not a table (e.g. `memory-delta.ts`, not
  `semantic-memory-with-source.ts`).
- Same shape as the per-table repositories: standalone functions, `db: Database`
  first arg, no classes, reads only.
- Return a purpose-built row interface declared in the module when the shape is a
  JOIN projection rather than a single table's `SyncedTableRowMap[T]` row.
- bun:sqlite `.get()` returns `null` (not undefined) on empty reads.

Example: `summary-extraction.ts`'s memory-delta query (`LEFT JOIN tasks + threads`
for source resolution) belongs here as `memory-delta.ts`.
