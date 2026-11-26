# Publish a Vellivex blog post from ChatGPT

In an ordinary ChatGPT chat, select **Vellivex Blog Publisher** from Apps. Ask, “Publish this on the Vellivex blog. Use the title and article below, write a short summary and give me its live link.” To keep a post private, ask to **save a draft**. To change a live article, give its URL and the change you want. To take it off the website, ask to **unpublish** it. The owner-private app handles publication, editing and withdrawal. Work mode can stay off.

The connected Vellivex Cloudflare account also supports the workflow below for ordinary chats with editorial database access.

## Where to publish

Use the authenticated **Vellivex** Cloudflare connection and the Cloudflare account named exactly **Vellivex**. Its dedicated D1 database is **vellivex-blog-content**. The website reads published rows from that database. Editorial work requires D1 write access. Readers visit the public website without a Cloudflare account. Public article URLs use `https://www.vellivex.com/blog/<slug>`.

Use Cloudflare’s connected search tool to find its List D1 Databases and Query D1 Database operations, then its execute tool to call the API. If the connection lists several accounts, use `GET /accounts` filtered by the exact account name and pass the returned account ID as the tool’s account selection. The following is a complete read example. To perform another operation, substitute its SQL and ordered parameter values in the same call. Pass article text as parameter strings, including any quotes and line breaks.

```js
async () => {
  const dbListPath = "/accounts/" + accountId + "/d1/database";
  const list = await cloudflare.request({
    method: "GET",
    path: dbListPath,
    query: { name: "vellivex-blog-content" }
  });
  const matches = list.result.filter(db => db.name === "vellivex-blog-content");
  if (matches.length !== 1) throw new Error("Expected one Vellivex editorial database");

  const sql = "SELECT slug, title, status, revision, published_at, updated_at FROM blog_posts ORDER BY updated_at DESC, slug LIMIT 30";
  const params = [];
  const response = await cloudflare.request({
    method: "POST",
    path: dbListPath + "/" + matches[0].uuid + "/query",
    body: { sql, params }
  });
  if (!response.success || !response.result.every(statement => statement.success)) {
    throw new Error("Vellivex editorial query failed");
  }
  return response.result[0].results;
}
```

## Prepare an article

Use the supplied copy or write to the owner’s brief. Publishing can proceed when the owner asks to publish. A request for a draft saves it privately. Use a descriptive, permanent slug of 1–100 lowercase ASCII letters, digits and single hyphens. The first and last characters must be letters or digits. The title allows 160 characters, the summary 400 and the body 60,000. All three need text. Write the body as plain text with a blank line between paragraphs. Optional headings use `## ` or `### ` at the start of their own line. Raw HTML is displayed as text. Keep personal identities and contact details out of public copy and use the Vellivex project identity.

## Read by slug

Bind the slug as the only parameter. This also returns a draft. Existing articles originally shipped with the website have reserved slugs and their own source history. If the database returns no row for a URL that is already live, leave its original article intact.

```sql
SELECT slug, title, summary, body, status, revision, published_at, updated_at
FROM blog_posts WHERE slug = ?1;
```

If a long article exceeds the connector’s response limit, request it in sections with `SELECT substr(body, ?2, 3000) AS section, length(body) AS characters, revision FROM blog_posts WHERE slug = ?1`. Bind the slug followed by a 1-based character offset such as `"1"` or `"3001"`. Check that the revision stays the same between sections.

## Create or publish a new post

Use this operation to create a post once. Bind **slug, title, summary, body, status** in that order. Use the exact status `draft` or `published`. The database sets the time. An empty returned row set means the slug already exists. Read that row and compare the content. If it already matches, report the existing result. If it differs, preserve the existing article and use a different unused slug for a new story or the explicit edit operation below for an intended update. The database rejects slugs reserved for earlier website articles.

```sql
INSERT INTO blog_posts (slug, title, summary, body, status, published_at)
VALUES (?1, ?2, ?3, ?4, ?5,
        CASE WHEN ?5 = 'published' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END)
ON CONFLICT(slug) DO NOTHING
RETURNING slug, status, revision, published_at, updated_at;
```

## Edit, publish an existing draft, or unpublish

First read the current row. Bind **slug, current revision as a string, new title, new summary, new body, new status**. Supply an empty string for each field that should keep its current value. For example, to publish the draft at revision 3 of an article called `choosing-a-screen-lock`, use `["choosing-a-screen-lock", "3", "", "", "", "published"]`. To unpublish a live article, pass its actual current revision and `draft`. To change only the title, supply the new title and leave the last three parameters empty. To republish, pass `published` again with the current revision. The operation preserves the article’s first publication time.

```sql
UPDATE blog_posts
SET title = coalesce(nullif(?3, ''), title),
    summary = coalesce(nullif(?4, ''), summary),
    body = coalesce(nullif(?5, ''), body),
    status = coalesce(nullif(?6, ''), status),
    published_at = CASE WHEN ?6 = 'published' AND published_at IS NULL
                        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE published_at END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    revision = revision + 1
WHERE slug = ?1 AND revision = ?2
  AND ((?3 <> '' AND ?3 <> title) OR (?4 <> '' AND ?4 <> summary)
       OR (?5 <> '' AND ?5 <> body) OR (?6 <> '' AND ?6 <> status))
RETURNING slug, status, revision, published_at, updated_at;
```

A successful edit returns its new revision. If the response is lost, retrying with the same observed revision is safe. An empty returned row set can mean an unchanged article, a missing article, or a concurrent edit. Read the current row and compare the requested fields. If the intended state already exists, report it. Otherwise resolve the conflict against the latest copy and preserve the other editor’s changes before proceeding.

## Verify the public result

Read the row after writing. For a published post, open its public URL and the blog index. Confirm the title and changed text are visible and the index links to that exact slug. For an unpublished post, confirm the former URL returns HTTP 404 and its listing disappears. The site also has a sitemap and an RSS feed. Give the owner the public link and observed revision, or confirm the private draft or removal as requested. If public reads cannot be verified, report the saved database state and the outstanding website check separately.

[Blog index](https://www.vellivex.com/blog) · [Sitemap](https://www.vellivex.com/sitemap.xml) · [RSS feed](https://www.vellivex.com/rss.xml)
