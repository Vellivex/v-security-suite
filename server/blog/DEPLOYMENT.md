# Vellivex website blog deployment

The website reads published articles and photos from the dedicated `vellivex-blog-content` D1 database through its existing `BLOG_DB` binding. The owner’s Vellivex Blog Publisher app writes through the [editorial gateway](README.md). The [ordinary-chat publishing guide](../../docs/BLOG-PUBLISHING.md) covers posting, editing and withdrawing articles.

## Deploy this release

For a fresh database, initialize the article tables with [schema.sql](schema.sql). Apply [photos.sql](photos.sql) to create the photo table and revision triggers. Existing articles keep their current text, status and revision when this migration runs. Update the editorial gateway separately using the bindings documented in its guide.

The public website release starts from v54. Confirm the Vellivex account, Worker name and active deployment ID. The deployment ID that controls traffic and the Worker version ID are distinct. From this directory, generate the operation for the authenticated Cloudflare connection.

```sh
python3 assemble.py test --database "$BLOG_DB_UUID" --base-deployment "$BASE_DEPLOYMENT_ID"
```

Use `test` to validate and `stage` to create an inactive version. Supply the returned version ID with `--staged "$BLOG_VERSION_ID"` for `verify` and `deploy`. Save the deployment ID returned by `deploy`. The `rollback` action takes both `--staged "$BLOG_VERSION_ID"` and `--deployed "$BLOG_DEPLOYMENT_ID"` as well as the original database and base deployment arguments.

The starting module inventory records the type, size and SHA-256 digest of each production module. Only the blog renderer changes. Stage the generated version, independently verify all 15 modules, all nine bindings and Worker settings, then direct traffic to that version.

## Production record

| Item | Value |
| --- | --- |
| Website Worker | `vellivex-site-migration` |
| Starting version | v54, `7144a063-dc68-4816-8ae3-a3736c503a40` |
| Starting deployment | `ab691b58-2b5a-47c9-827d-2fb3b71572b8` |
| Starting renderer SHA-256 | `43a5bf144c7f19e08e93938a0ecbaa0b0f0b271f7fa3966d180d4e2ed319e581` |
| Photo-enabled version | v55, `83c2fab5-627a-49a3-80c5-48c64062c5ff` |
| Production deployment | `ad2ab7b5-e2e9-4458-916b-7fbbefbf0e6c`, 100% on 26 November 2026 at 21:21 UTC |
| Photo-enabled renderer SHA-256 | `abbda091fa06c30cb95f7c9386c8c9f8e2cda5dc5db379daad6fe1a113f61d30` |

The [initial blog release](https://github.com/Vellivex/v-security-suite/blob/6f9c1ddc4bf0e7c6d2710492d51b040465a67661/server/blog/DEPLOYMENT.md) contains the precise v53-to-v54 procedure and sources.

## Verify and roll back

Run `npm test` and `bash scripts/build.sh` from the repository root. Verify an original static article and the Messenger download. Use a local disposable article to check public rendering, image status and MIME type, image bytes, alt text, caption, replacement and removal across publish and unpublish. On production, use an owner-private draft to check that its article and image URL both return HTTP 404. Validate public rendering on real editorial content when the owner publishes it.

To reverse this website release while its recorded deployment is active, send 100% of traffic back to the starting v54 Worker version and read the deployment back. The photo table and editorial content can stay in the database. If a later website release has shipped, apply the photo-specific reversal to the current source and preserve subsequent changes.
