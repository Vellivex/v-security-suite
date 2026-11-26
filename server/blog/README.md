# Vellivex blog editorial gateway

The owner’s ChatGPT publishing app uses this standalone Worker for editorial operations. The public website renders articles from the same database. It does not forward public requests to the gateway.

Bind `BLOG_DB` to the dedicated `vellivex-blog-content` D1 database using the accompanying [schema](schema.sql). Configure `BLOG_API_TOKEN` as a server-side secret shared only with the owner-private publishing app. Generate it from 32 random bytes, encoded as base64url or hex. Provision or rotate it using each service’s secret configuration. The publishing app authenticates the owner before making a server-to-server HTTPS request.

## API

Send one JSON object with `POST /v1/blog`, `Content-Type: application/json` and bearer authentication. The gateway provides the following operations.

| Action | Request | Result |
| --- | --- | --- |
| `list` | Optional `status` (`draft` or `published`), `limit` (1–100, default 30), and `afterSlug` | Slug-sorted metadata and a `nextAfterSlug` cursor. Bodies are omitted. |
| `get` | `slug` | The full post and public URL. The URL is null for a draft. A missing article returns 404. |
| `save` | `slug`, `title`, `summary`, `body`, `status`, and integer `expectedRevision` | The stored post, public URL and whether this call changed it. Use revision 0 for a new article or the observed revision for an existing article. |

To change a title or visibility, read the current article, retain the untouched fields and save using that article’s revision. Changing a published article to `draft` removes it from public view. Republish it by changing its status back to `published`. The slug and first publication timestamp are stable. A different edit at a stale revision gives HTTP 409 and the current revision. A retry that already matches the desired state makes no change. The site’s original article slugs are reserved and produce HTTP 409 when an editor tries to claim one.

The endpoint accepts the three editorial operations only. It uses bound D1 statements and starts each request on the primary database. Replies are marked private and non-cacheable. D1 and authentication details stay out of error responses.

From the repository root, run `node --test tests/blog-gateway.test.mjs` with Node 24 or newer to validate authentication, inputs, editing, retries, conflicts and pagination against the actual schema. The [ordinary-chat publishing guide](../../docs/BLOG-PUBLISHING.md) also covers using the connected Cloudflare account directly.
