# App-access expiry indexes

`20261113-expiry-indexes.sql` adds two indexes to an existing app-access database.
The normal `schema.sql` includes the same definitions for fresh databases.
The migration changes no stored rows, authentication rules or expiry deadlines.

The email-state index lets expiry cleanup select expired rows directly. The
handoff parent index serves both branches of the existing expiry-or-parent
cleanup with indexes and avoids scanning handoffs for each SSO foreign-key
cascade. The small daily/monthly mail-budget table does not gain another index.

Apply this separately from Worker deployment after database service and quota
have recovered. First inspect the two tables' index metadata and the available
quota. Index creation performs one-time database work; do not loop or retry it
during an exhausted quota. Run the two idempotent statements, retain each
statement's result and resource metadata, then verify the index definitions and
the existing cleanup query plans. Do not use customer-row exports or repeated
full-table counts as a readiness check.

`node --test tests/app-access-cleanup-indexes.test.mjs` compares the actual
Worker cleanup queries before and after migration on fictional SQLite data.
It checks indexed query plans, repeat application, unchanged rows during index
creation, and identical cleanup results with foreign keys enabled.
