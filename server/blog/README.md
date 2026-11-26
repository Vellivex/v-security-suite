# Vellivex blog editorial gateway

The owner’s ChatGPT publishing app uses this standalone Worker for editorial operations. The public website renders articles from the same database. It does not forward public requests to the gateway.

Bind `BLOG_DB` to the dedicated `vellivex-blog-content` D1 database. Apply the [article schema](schema.sql), then the [photo migration](photos.sql). The photo migration can be rerun. Configure `BLOG_API_TOKEN` as a server-side secret shared only with the owner-private publishing app. Generate it from 32 random bytes, encoded as base64url or hex. Provision or rotate it using each service’s secret configuration. The publishing app authenticates the owner before making a server-to-server HTTPS request.

## API

Send one JSON object with `POST /v1/blog`, `Content-Type: application/json` and bearer authentication. The gateway provides the following operations.

| Action | Request | Result |
| --- | --- | --- |
| `list` | Optional `status` (`draft` or `published`), `limit` (1–100, default 30), and `afterSlug` | Slug-sorted metadata and a `nextAfterSlug` cursor. Bodies are omitted. |
| `get` | `slug` | The full post and public URL. The URL is null for a draft. A missing article returns 404. |
| `save` | `slug`, `title`, `summary`, `body`, `status`, and integer `expectedRevision` | The stored post, public URL and whether this call changed it. Use revision 0 for a new article or the observed revision for an existing article. |
| `setPhoto` | `slug`, positive `expectedRevision`, `contentType`, `altText`, optional `caption`, and `dataBase64` | Attaches or replaces the article’s photo and returns the stored post, public URL and change flag. |
| `removePhoto` | `slug` and positive `expectedRevision` | Removes the article’s current photo and returns the stored post, public URL and change flag. |

Save an article before attaching its photo. The editor submits standard padded base64 of a JPEG, PNG or WebP with its matching MIME type. The decoded file can contain up to 1,572,864 bytes (1.5 MiB). Alt text is required and supports 1–300 characters. A caption supports up to 500 characters and defaults to an empty string. Reading an article or listing posts returns `photo: null` or a metadata object with `contentType`, `altText`, `caption`, `byteLength` and `sha256`. The editor never returns the file bytes. Text edits preserve the photo, and publishing or withdrawing the article also controls public access to its photo.

To change a title or visibility, read the current article, retain the untouched fields and save using that article’s revision. Changing a published article to `draft` removes it from public view. Republish it by changing its status back to `published`. The slug and first publication timestamp are stable. A different edit at a stale revision gives HTTP 409 and the current revision. A retry that already matches the desired state makes no change. The site’s original article slugs are reserved and produce HTTP 409 when an editor tries to claim one.

Article and photo changes use the same revision counter. A repeated photo upload compares the file’s SHA-256, type, alt text, and caption. An identical retry, or withdrawing an already-removed photo, succeeds with `changed: false`. A stale revision cannot replace or remove a different current photo. Each mutation and its readback run in a single D1 batch. Replies are marked private and non-cacheable.

From the repository root, run `node --test tests/blog-gateway.test.mjs` with Node 24 or newer to validate authentication, inputs, editing, photos, retries, conflicts, transaction rollback and pagination against the actual schema. The [ordinary-chat publishing guide](../../docs/BLOG-PUBLISHING.md) also covers using the connected Cloudflare account directly.
