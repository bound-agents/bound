# Domain query modules

Cross-table read queries that no single-table finder in the parent
`repositories/` directory can hold — JOINs, aggregates spanning multiple synced
tables, and operation-shaped reads.

Conventions:

- Named by the **operation**, not a table (e.g. `memory-with-source.ts`,
  `threads-directory-listing.ts`).
- Same shape as the per-table repositories: standalone functions, `db: Database`
  first arg, no classes, reads only.
- Return a purpose-built row interface declared in the module when the shape is a
  JOIN projection rather than a single table's `SyncedTableRowMap[T]` row.
- SQL fragments shared across modules live in `sql-fragments.ts`, which the
  repository barrel does not re-export.
