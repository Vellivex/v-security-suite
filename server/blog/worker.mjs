const MAX_REQUEST_BYTES = 800000;
const nowUtc = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const summaryColumns = "slug, title, summary, status, revision, published_at AS publishedAt, updated_at AS updatedAt";
const fullColumns = summaryColumns + ", body";

class InputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function json(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function failure(status, error, message, info = {}, headers = {}) {
  return json({ ok: false, error, message, ...info }, status, headers);
}

const encoder = new TextEncoder();

async function validBearer(authorization, expected) {
  const match = /^Bearer ([A-Za-z0-9._~+\/=-]{43,160})$/i.exec(authorization ?? "");
  if (!match) return false;
  // WebCrypto verifies authentication tags in constant time. Both secrets stay on the server.
  const key = await crypto.subtle.importKey("raw", encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const expectedMac = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, expectedMac, encoder.encode(match[1]));
}

async function readInput(request) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("unsupported_media_type", "Use application/json.", 415);
  }
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) {
    throw new InputError("too_large", "Request exceeds the editorial input limit.", 413);
  }
  if (!request.body) throw new InputError("invalid_json", "An editorial request is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let content = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new InputError("too_large", "Request exceeds the editorial input limit.", 413);
      }
      content += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(content + decoder.decode());
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new InputError("invalid_input", "Use one JSON object for an editorial operation.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("invalid_json", "Expected a JSON object encoded as UTF-8.");
  } finally {
    reader.releaseLock();
  }
}

function onlyFields(input, allowed) {
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new InputError("invalid_input", "The operation included an unrecognised field.");
  }
}

function checkSlug(slug) {
  if (typeof slug !== "string" || slug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || /[^a-z0-9-]/.test(slug)) {
    throw new InputError("invalid_input", "Use a lowercase article slug with single hyphens, up to 100 characters.");
  }
}

function checkText(value, field, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > 2 * limit ||
      Array.from(value).length > limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) ||
      /[\uD800-\uDFFF]/u.test(value)) {
    throw new InputError("invalid_input", field + " must be nonblank plain text within " + limit + " characters.");
  }
}

function checkStatus(status) {
  if (status !== "draft" && status !== "published") {
    throw new InputError("invalid_input", "Status must be draft or published.");
  }
}

function urlFor(post) {
  return post.status === "published" ? "https://www.vellivex.com/blog/" + post.slug : null;
}

function currentPost(db, slug) {
  return db.prepare("SELECT " + fullColumns + " FROM blog_posts WHERE slug = ?1").bind(slug).first();
}

async function listPosts(db, input) {
  onlyFields(input, ["action", "limit", "status", "afterSlug"]);
  if (Object.hasOwn(input, "status")) checkStatus(input.status);
  if (Object.hasOwn(input, "afterSlug")) checkSlug(input.afterSlug);
  const limit = Object.hasOwn(input, "limit") ? input.limit : 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InputError("invalid_input", "Limit must be an integer from 1 to 100.");
  }
  const { results } = await db.prepare(
    "SELECT " + summaryColumns + " FROM blog_posts WHERE (?1 = '' OR status = ?1) AND slug > ?2 ORDER BY slug LIMIT ?3"
  ).bind(input.status ?? "", input.afterSlug ?? "", limit + 1).all();
  const posts = results.slice(0, limit);
  return json({ ok: true, posts, nextAfterSlug: results.length > limit ? posts[posts.length - 1].slug : null });
}

async function savePost(db, input) {
  onlyFields(input, ["action", "slug", "title", "summary", "body", "status", "expectedRevision"]);
  const { slug, title, summary, body, status, expectedRevision } = input;
  checkSlug(slug);
  checkText(title, "Title", 160);
  checkText(summary, "Summary", 400);
  checkText(body, "Body", 60000);
  checkStatus(status);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new InputError("invalid_input", "Supply the observed revision, or 0 to create a new article.");
  }

  let post;
  if (expectedRevision === 0) {
    post = await db.prepare(
      "INSERT INTO blog_posts (slug, title, summary, body, status, published_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 'published' THEN " + nowUtc + " END " +
      "WHERE NOT EXISTS (SELECT 1 FROM blog_reserved_slugs WHERE slug = ?1) " +
      "ON CONFLICT(slug) DO NOTHING RETURNING " + fullColumns
    ).bind(slug, title, summary, body, status).first();
  } else {
    post = await db.prepare(
      "UPDATE blog_posts SET title = ?2, summary = ?3, body = ?4, status = ?5, " +
      "published_at = CASE WHEN ?5 = 'published' THEN coalesce(published_at, " + nowUtc + ") ELSE published_at END, " +
      "updated_at = " + nowUtc + ", revision = revision + 1 " +
      "WHERE slug = ?1 AND revision = ?6 AND (title <> ?2 OR summary <> ?3 OR body <> ?4 OR status <> ?5) " +
      "RETURNING " + fullColumns
    ).bind(slug, title, summary, body, status, expectedRevision).first();
  }
  if (post) return json({ ok: true, post, url: urlFor(post), changed: true }, expectedRevision === 0 ? 201 : 200);

  const actual = await currentPost(db, slug);
  if (actual && title === actual.title && summary === actual.summary && body === actual.body && status === actual.status) {
    return json({ ok: true, post: actual, url: urlFor(actual), changed: false });
  }
  if (!actual && await db.prepare("SELECT 1 AS reserved FROM blog_reserved_slugs WHERE slug = ?1").bind(slug).first()) {
    return failure(409, "reserved_slug", "An existing website article uses this slug.");
  }
  return failure(409, "revision_conflict", "Read the current article before applying a different change.", { currentRevision: actual?.revision ?? 0 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/blog" || url.search) return failure(404, "not_found", "Unknown route.");
    if (request.method !== "POST") return failure(405, "method_not_allowed", "Use POST.", {}, { Allow: "POST" });
    try {
      if (typeof env.BLOG_API_TOKEN !== "string" || !/^[A-Za-z0-9._~+\/=-]{43,160}$/.test(env.BLOG_API_TOKEN) || !env.BLOG_DB) {
        return failure(503, "unavailable", "The editorial service is unavailable.");
      }
      if (!await validBearer(request.headers.get("Authorization"), env.BLOG_API_TOKEN)) {
        return failure(401, "unauthorized", "Owner authorisation is required.");
      }
      const input = await readInput(request);
      const db = env.BLOG_DB.withSession("first-primary");
      if (input.action === "list") return await listPosts(db, input);
      if (input.action === "save") return await savePost(db, input);
      if (input.action === "get") {
        onlyFields(input, ["action", "slug"]);
        checkSlug(input.slug);
        const post = await currentPost(db, input.slug);
        return post ? json({ ok: true, post, url: urlFor(post) }) : failure(404, "not_found", "Editorial article not found.");
      }
      throw new InputError("invalid_input", "Action must be list, get, or save.");
    } catch (error) {
      if (error instanceof InputError) return failure(error.status, error.code, error.message);
      return failure(503, "unavailable", "The editorial service is unavailable.");
    }
  },
};
