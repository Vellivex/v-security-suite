# Free Internet Call access

`call-scope.mjs` admits a verified app session only on the exact Call origin's
`POST /api/volatile` and `GET /connect`. It prefers an independently valid app
cookie and otherwise retains the existing strong account session. A stale cookie
in either family cannot invalidate the other valid family. Other account, owner,
recovery and financial routes retain their existing authentication.

The adapter imports no database schema. The account bundle imports these core
exports from `app-access/core.mjs`:

- `appCallScope(request, env)` validates the host app cookie and returns exactly
  `{id, epoch, session, appAccess: true}` for `https://call.vellivex.com`.
- `validateAppCallScope(env, scope, now)` checks the app session, parent SSO
  session, Call audience and user epoch/disabled state, returning a boolean.

The live actor preserves and validates the explicit family discriminator. Its
existing mutation checks and five-second watchdog use the corresponding store.
Room membership and watchdog keys include the family, so identical identifiers
in separate stores cannot exchange access. Incoming public identity headers are
discarded; the Worker constructs a new internal request using its verified scope.

`patch-call.mjs` checks the complete audited bundle hash and each unique text
anchor. It changes two admission sites, actor scope parsing/validation/membership
and watchdog keys. Embedded assets, financial authentication and all other
existing modules remain byte-identical. Apply it before any separate asset patch.
Package the resulting bundle alongside the current runtime `core.mjs`,
`call-scope.mjs`, `registry.mjs`, `mail.mjs` and `ui.mjs` under `app-access/`.

Verification:

```sh
node --test tests/app-access-call-scope.test.mjs
node server/app-access/verify-call-integration.mjs /path/to/audited/accounts/modules
```

The integration verifier builds an isolated candidate and exercises the actual
bundle with SQLite-backed app and legacy tables. It tests both free routes,
cookie precedence, privileged-route rejection, unchanged assets, a two-party
call lifecycle, malformed scopes, ticket reuse, family collisions and live
revocation. It sends no email and performs no deployment.

Existing strong sessions could support an optional convenience bridge through
the existing authenticated `/api/account` response. That would require a
separate, internal-only core method to mint app SSO from an already verified
strong identity, with no reverse conversion and no implied marketing consent.
This integration deliberately does not create that additional trust path.
