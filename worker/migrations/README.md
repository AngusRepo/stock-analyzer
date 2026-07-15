# D1 migration contract

`schema.production.snapshot.sql` is the reproducible bootstrap snapshot.
All new DDL must be an ordered, append-only file in this directory and must
also refresh the snapshot after production migration verification.

The 113 root-level `migration_*.sql` files are historical and frozen by
`legacy-migrations.manifest.txt`. Do not add or edit flat migrations.

Remote migrations remain an explicit operation; code review and a verified
local apply are required before `npm run db:migrations:apply:remote`.
