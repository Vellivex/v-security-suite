# Mail app admission

The site calls `createMailProxy()` after its app gate. The proxy independently
checks app access for creation and accepts only these routes on
`https://www.vellivex.com` and `https://vellivex.com`:

| Site route | Method | Backend route | App session |
| --- | --- | --- | --- |
| `/api/mail/status` | GET | `/api/status` | Not required |
| `/api/mail/inbox` | POST | `/api/inbox` | Required |
| `/api/mail/inbox/<32 lowercase hex>` | GET, DELETE | `/api/inbox/<id>` | Existing bearer capability |

Mutations require an Origin matching the exact requesting site origin. App
cookies and identity headers never leave the site Worker. The proxy forwards
the original Turnstile body, trusted client-IP header and existing bearer
capability when appropriate. Creation cannot enter the separate pilot-token
lane. Original Turnstile validation, rate limits, capacity and expiry remain
active in the backend. Existing reads and deletion still work after app logout.

## Runtime contract

- Site import: `createMailProxy` from `./app-access/mail-proxy.mjs`.
- Call the returned async function as `(request, env)`; it returns `null` for
  paths outside `/api/mail/`, otherwise a Response.
- Site service binding: `MAIL_API`, service `vellivex-disposable-mail-pilot`.
- Binding requests use `https://mail-access.internal/api/...` with manual
  redirect handling. There is no public DNS/route for that private hostname.
- Backend import: `guardMailBackend` from
  `./app-access/mail-backend-guard.mjs`; shared transport module
  `mail-transport.mjs` is also required.
- New backend entrypoint:

```js
import core from './worker.js';
import { guardMailBackend } from './app-access/mail-backend-guard.mjs';
export default guardMailBackend(core);
```

The wrapper rejects all public POST requests, including direct API and
workers.dev creation. Only private service requests can reach creation. It
forwards public capability reads/deletes unchanged, and delegates `email`,
`scheduled` and `queue` to the original handlers with all arguments.

## Packaging and release

Use the reviewed live version's original `worker.js` and
`scheduled-cleanup-receipt.mjs`, preserving the receipt bytes, bindings, queue,
email routing and cleanup schedule. Apply `patch-mail.mjs` once to that exact
worker before packaging. Its only source change adds the apex site to the
existing allowed-origin Set. Preserving the actual Origin is necessary because
Turnstile validates the hostname; changing apex Origin to www would invalidate
an apex browser's token.

Stage and verify the backend wrapper and site proxy together. Add `MAIL_API`
to the site without removing existing bindings. Activate the guarded backend
before exposing the new client routes, then activate the site using the proxy.
During that short interval legacy creation fails closed; existing bearer
reads/deletes and scheduled cleanup continue. Restore the prior site and
backend version together if reverting the complete signup feature.

Run `node --test tests/app-access-mail-proxy.test.mjs`. Release verification also
uses the exact current backend in an isolated SQLite fixture with synthetic
Turnstile and MIME inputs for both site origins: creation, failed verification,
protected reads, message receipt, deletion, rate limits and expiry cleanup.
Those fixtures send no email and create no live inboxes.
