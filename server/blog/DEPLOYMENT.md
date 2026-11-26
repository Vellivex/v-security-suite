# Vellivex website blog deployment

The website reads articles from the dedicated `vellivex-blog-content` D1 database through its `BLOG_DB` binding. The public Worker serves published content over GET and HEAD. The owner’s Vellivex Blog Publisher app writes through the [editorial gateway](README.md). The authenticated Vellivex Cloudflare connection also supports direct editorial changes. See [the ordinary-chat publishing procedure](../../docs/BLOG-PUBLISHING.md) for drafting, publishing, editing and withdrawing a post.

## Release files

- `blog-publisher.mjs` contains the read-only rendering layer for the article, blog index, RSS feed and sitemap.
- `app-access-entry.mjs` is the deployed entry module. The existing access checks wrap the blog renderer and the original phone shop.
- `schema.sql` is the initial database migration, including reservations for existing static article URLs. Apply it once to an empty dedicated database.
- `base-inventory.json` records the 14 starting module names, types, sizes and SHA-256 digests. `assemble.py` combines this inventory with the reviewed source modules and `worker-version-template.js` to build a Cloudflare connector operation.

From this directory, prepare an operation with the UUID of the dedicated database and the original v53 deployment ID. In Cloudflare’s authenticated account view, select Vellivex. The Workers version ID and traffic deployment ID are separate identifiers. Run the generated JavaScript function with the Cloudflare connection under that account.

```sh
python3 assemble.py test --database "$BLOG_DB_UUID" --base-deployment "$BASE_DEPLOYMENT_ID"
```

Use `test` to validate the starting state and `stage` to create an inactive version. Save the returned version ID and add `--staged "$BLOG_VERSION_ID"` for `verify` and `deploy`. The deployment returns a traffic deployment ID. A `rollback` call takes both `--staged "$BLOG_VERSION_ID"` and `--deployed "$BLOG_DEPLOYMENT_ID"`, plus the original database and base deployment arguments. The checks require the recorded starting version and module hashes, compare preserved module and binding metadata, and check traffic before mutation.

## Production release

| Item | Value |
| --- | --- |
| Worker | `vellivex-site-migration` |
| Starting version | v53, `922e0c18-d30b-44bf-8d7f-fee54f78d08f` |
| Starting entry SHA-256 | `e460fb64cc656acc22c14c7706471e9ec095358e365379d3cd2f203660503796` |
| Blog-enabled version | v54, `7144a063-dc68-4816-8ae3-a3736c503a40` |
| Production deployment | `ab691b58-2b5a-47c9-827d-2fb3b71572b8`, 100% on 26 November 2026 at 21:08 UTC |
| Blog-enabled entry SHA-256 | `be2e40ac048499f7f28de17f84d1a7e2052de3c6f8babff9be3b7d3e56b53f08` |
| Blog renderer SHA-256 | `43a5bf144c7f19e08e93938a0ecbaa0b0f0b271f7fa3966d180d4e2ed319e581` |

To reproduce this change from the recorded starting version, first verify the live version and entry digest. Start from all modules and settings of that version. Replace the entry with the file here, add the blog renderer under `blog-publisher.mjs` at the module root, and bind the dedicated database as `BLOG_DB`. Keep all other modules and bindings from the verified version. Create an inactive Worker version and inspect its resources before directing traffic to it. If production has moved beyond the recorded version, adapt the small entry change to the actual deployed source and preserve subsequent changes.

## Verification and rollback

Run `npm test` and `bash scripts/build.sh` from the repository root. On the deployed website check an article’s title, body, HTTP status and canonical URL. Verify a published entry on `/blog`, `/rss.xml` and `/sitemap.xml`. A draft should be absent from all four views. Check an existing static article and the Messenger download as well.

To reverse this release while the blog-enabled version above is still the active version, use the Cloudflare Worker deployments control to send 100% of traffic to the recorded v53 version. Verify the selected live version, existing public article and signed Messenger download again. Leave the D1 content intact. To take down a single post, use the editorial unpublish operation. If later website changes have already shipped, apply the blog-specific reversal to that newer version to preserve those releases.
