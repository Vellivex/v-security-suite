# Shared app access packaging

`package-live.mjs` performs local packaging only. It cannot call Cloudflare,
send email, change bindings, create inboxes, deploy versions or enable a paid
service. The release operator retains responsibility for the independently
captured live versions, complete module inventories and settings.

## Small payload for remote preservation

```js
import { buildPayload } from './server/app-access/package-live.mjs';
const payload = await buildPayload({
  offlineManifestPath: '/absolute/path/to/exact-live-offline-manifest.json'
});
```

The manifest must have the exact pinned hash and 34 complete asset records.
The builder uses the tested service-worker template and current Mail/Number
clients. It preserves the manifest's live asset hashes and security headers;
it does not regenerate older application assets from this checkout. The retained
chat fixture is pinned to the current verified live client. An explicit
`chatClientPath` can select another copy only if its bytes match that same hash.

| Payload field | Use |
| --- | --- |
| `runtimeModules` | Map of new module names to UTF-8 source |
| `workerEntries` | New main source for each of the seven logical workers |
| `workerPlans` | Exact service, original main, new main, own origins and needed modules |
| `patches.call`, `patches.mail` | Before/after hashes, unique replacements, self-contained function source, original patch module source |
| `generatedModules` | Ready-to-upload site and chat override module source |
| `siteOverrides`, `chatOverrides` | The corresponding response override data |
| `evidence` | Offline manifest, cache, client and generated/runtime module hashes |

For a remote preservation upload, first compare the fresh complete inventory
and current deployed version with the captured baseline. Preserve every
original module and content type. For each applicable descriptor call
`applyGuardedPatch(source, descriptor)` or perform its same unique-anchor and
before/after hash checks. Add only the runtime/generated modules named in that
worker's plan, add its `app-access-entry.mjs`, and set that as the new main.
Original main modules are retained. New mains re-export their named exports,
including existing Durable Object classes. Never replace a previously
unknown module, use stale source assets or silently accept a changed baseline.

The payload can be written with a JSON configuration file:

```sh
node server/app-access/package-live.mjs payload CONFIG.json NEW_PAYLOAD.json
```

The output must not already exist. Rebuild the payload after a runtime source
change; its hash evidence identifies exactly which source snapshot it contains.

## Complete local package

`packLiveWorkers` additionally accepts `baselineDirs`, `expectedModules` and
`outputDir`. Both maps must contain `accounts`, `site`, `vphone`, `vdecoy`,
`vkey`, `private` and `mail`. Each directory must contain the complete original
module tree, and each matching inventory must map every relative module name
to its independently obtained SHA-256. Symlinks, missing/extra modules, hash
mismatches, changed patch targets and collisions with new modules are rejected.
Local VKey and Private packages also verify the full current asset module hash.

The new output directory contains the seven complete module trees and a
`package-manifest.json`. Original binary and text bytes are copied exactly,
except the two explicitly guarded Call/Mail patches. Captured settings and
module MIME metadata remain separate; this package does not invent them.

```sh
node server/app-access/package-live.mjs pack CONFIG.json NEW_DIRECTORY
```

Partial source snapshots are suitable for review, not full local packing. Use
the small payload and fresh remote preservation when complete local module
trees are unavailable.

## Release settings and order

1. Record current deployment IDs, version IDs, all module hashes, bindings,
   compatibility settings, routes, Durable Object migrations and event handlers.
   Preserve the existing strong account secret, account database and owner/2FA
   configuration. Apply only the additive `schema.sql` tables to `ACCOUNTS_DB`.
2. Stage the accounts main with its local central broker. Other app Workers use
   an `APP_ACCESS` service binding to the accounts service; the central account
   Worker uses its local broker, without a self service binding. Preserve all
   unrelated bindings. Site also gains `MAIL_API` pointing to
   `vellivex-disposable-mail-pilot`.
3. Stage all seven exact modules and run the relevant tests, including unknown
   host rejection, new API creation without app cookies, privileged account
   rejection, capability cleanup, existing assets and named actor exports.
   Verify generated Mail and Number clients, both chat clients, and the service
   worker hashes from the payload. Platform email, queue and scheduled cleanup
   handlers stay attached to Mail.
4. Activate the accounts broker before its dependent gates. Activate the Mail
   creation guard before the site proxy/client release, then the remaining app
   wrappers. This brief ordering can reject new creation, while existing bearer
   reads/deletes continue. Keep public homepage, source, help and privacy routes
   available. No paid provider, subscription or payment flag is enabled.
5. Re-read deployed versions and verify current modules/settings against the
   candidate hashes. Exercise the email-code path with controlled testers, then
   verify each app's real entry and necessary existing capabilities. Distinguish
   isolated fixture tests from real browser, delivery and physical-device tests.

If reverting the complete feature, restore the captured prior versions and
corresponding site/backend pair. Keep additive access tables rather than
deleting customer records as an incidental rollback. Existing application
storage, user keys, encrypted files and downloads are not reset or rebuilt.

Verification commands include:

```sh
node --test tests/app-access-package.test.mjs tests/app-access-call-scope.test.mjs tests/app-access-mail-proxy.test.mjs
node server/app-access/verify-call-integration.mjs /path/to/audited/accounts/modules
```

## Preserving an already deployed Worker during a repair

Use the existing packager's `preserve` mode for every daily automatic repair and
other one-module production repair. A generic `scripts/build.sh` output is not
an input to this path: it contains historical release inputs, not the current
production module tree. The packager never calls a provider or changes service.

```sh
node server/app-access/package-live.mjs preserve CAPTURE.json NEW_DIRECTORY
```

The capture must contain these independently obtained fields:

- `service`, `expectedVersion` and the freshly read `currentVersion`;
- `baselineMetadata` and `candidateMetadata`: complete reviewed upload metadata,
  including `main_module`, compatibility settings and bindings. Preserve any
  existing provider-supported secret-preservation fields; do not export secret
  values merely to use this check;
- `baselineModules` and `candidateModules`: complete name-to-`{sha256,type}` maps,
  where `type` is the exact module MIME type;
- `reviewedChanges`: only changed module names, each with independently reviewed
  `beforeSha256` and `afterSha256` values;
- `baselineDir` and `candidateDir`: the complete corresponding module trees.

The validator requires the same captured main module, every original module,
unchanged module MIME types, exact bindings and all other metadata. Any changed
source bytes require the precise reviewed before/after hashes. Missing, extra,
symlinked or mismatched files stop packaging. Binary release replacements are
rejected in repair mode. It therefore rejects the historical accidental switch
from `app-access-entry.mjs` to `index.mjs`, a lost access wrapper or binding, and
an unreviewed substitution of the generic older APK-bearing module. Ungated
services retain their actual captured main; this path does not invent wrappers.

The result contains all module bytes, `upload-metadata.json` and a
`package-manifest.json` containing the module and metadata hashes. Upload the exact emitted metadata and bytes, then
re-read versions, module hashes and settings. Immediately before upload compare
the expected version again, and stop if another change has been deployed. Keep
the captured version for rollback. Only promote after the affected public
routes and gates pass. Never disable a gate to make a health check pass.

`validatePreservedDeployment(capture)` is also exported for preservation tools
that obtain complete inventories remotely without downloading module bytes.
This form checks inventory evidence only; `packPreservedWorker` additionally
hashes both local trees and writes the package atomically. Neither form can
prove a supplied capture is fresh, lock a deployment against concurrent changes,
or prevent an administrator from bypassing it through a direct provider API.
This is enforced in this packaging path, not an account-level deployment policy.
Binding changes, added/removed modules and native releases require their own
separately reviewed release procedure and are deliberately outside repair mode.
