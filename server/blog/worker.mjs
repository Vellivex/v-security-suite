const MAX_PHOTO_BYTES = 1572864;
const MAX_REQUEST_BYTES = 4 * Math.ceil(MAX_PHOTO_BYTES / 3) + 16000;
const nowUtc = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const summaryColumns = `p.slug, p.title, p.summary, p.status, p.revision,
  p.published_at AS publishedAt, p.updated_at AS updatedAt,
  CASE WHEN f.slug IS NOT NULL THEN json_object('contentType', f.content_type,
    'altText', f.alt_text, 'caption', f.caption, 'byteLength', f.byte_length, 'sha256', f.sha256) END AS photoJson`;
const withPhoto = " FROM blog_posts p LEFT JOIN blog_photos f ON f.slug = p.slug ";

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

function storedPost(row) {
  if (!row) return null;
  const { photoJson, ...fields } = row;
  return { ...fields, photo: photoJson ? JSON.parse(photoJson) : null };
}

function currentPostQuery(db, slug) {
  return db.prepare("SELECT " + summaryColumns + ", p.body" + withPhoto + "WHERE p.slug = ?1").bind(slug);
}

async function writeAndRead(db, mutation, slug) {
  // The same D1 batch contains the mutation, trigger work and exact resulting revision.
  const [write, read] = await db.batch([mutation, currentPostQuery(db, slug)]);
  return { changed: write.results.length === 1, post: storedPost(read.results[0]) };
}

function writeResult(post, changed, status = 200) {
  return json({ ok: true, post, url: urlFor(post), changed }, status);
}

function revisionConflict(post) {
  return failure(409, "revision_conflict", "Read the current article before applying a different change.", { currentRevision: post?.revision ?? 0 });
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
    "SELECT " + summaryColumns + withPhoto + "WHERE (?1 = '' OR p.status = ?1) AND p.slug > ?2 ORDER BY p.slug LIMIT ?3"
  ).bind(input.status ?? "", input.afterSlug ?? "", limit + 1).all();
  const posts = results.slice(0, limit).map(storedPost);
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

  let mutation;
  if (expectedRevision === 0) {
    mutation = db.prepare(
      "INSERT INTO blog_posts (slug, title, summary, body, status, published_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 'published' THEN " + nowUtc + " END " +
      "WHERE NOT EXISTS (SELECT 1 FROM blog_reserved_slugs WHERE slug = ?1) " +
      "ON CONFLICT(slug) DO NOTHING RETURNING slug"
    ).bind(slug, title, summary, body, status);
  } else {
    mutation = db.prepare(
      "UPDATE blog_posts SET title = ?2, summary = ?3, body = ?4, status = ?5, " +
      "published_at = CASE WHEN ?5 = 'published' THEN coalesce(published_at, " + nowUtc + ") ELSE published_at END, " +
      "updated_at = " + nowUtc + ", revision = revision + 1 " +
      "WHERE slug = ?1 AND revision = ?6 AND (title <> ?2 OR summary <> ?3 OR body <> ?4 OR status <> ?5) " +
      "RETURNING slug"
    ).bind(slug, title, summary, body, status, expectedRevision);
  }
  const { post: actual, changed } = await writeAndRead(db, mutation, slug);
  if (changed) return writeResult(actual, true, expectedRevision === 0 ? 201 : 200);

  if (actual && title === actual.title && summary === actual.summary && body === actual.body && status === actual.status) {
    return writeResult(actual, false);
  }
  if (!actual && await db.prepare("SELECT 1 AS reserved FROM blog_reserved_slugs WHERE slug = ?1").bind(slug).first()) {
    return failure(409, "reserved_slug", "An existing website article uses this slug.");
  }
  return revisionConflict(actual);
}

function checkPhotoTarget(input) {
  checkSlug(input.slug);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new InputError("invalid_input", "Save the article first and supply its current revision.");
  }
}

function hasSignature(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    return bytes.length >= 45 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a
      && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452 && view.getUint32(16) > 0
      && view.getUint32(20) > 0 && view.getUint32(bytes.length - 12) === 0 && view.getUint32(bytes.length - 8) === 0x49454e44;
  }
  if (type === "image/jpeg") {
    return bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[3] !== 0x00 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  return type === "image/webp" && bytes.length >= 20 && view.getUint32(0) === 0x52494646
    && view.getUint32(4, true) === bytes.length - 8 && view.getUint32(8) === 0x57454250
    && [0x56503820, 0x5650384c, 0x56503858].includes(view.getUint32(12))
    && view.getUint32(16, true) > 0 && view.getUint32(16, true) <= bytes.length - 20;
}

function decodePhoto(encoded, contentType) {
  if (typeof encoded !== "string" || !encoded.length) throw new InputError("invalid_photo", "Attach a JPEG, PNG or WebP photo.");
  if (encoded.length > 4 * Math.ceil(MAX_PHOTO_BYTES / 3)) {
    throw new InputError("photo_too_large", "Choose or export a smaller photo (maximum 1.5 MiB).", 413);
  }
  let binary;
  try {
    binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error();
  } catch {
    throw new InputError("invalid_photo", "Expected standard padded base64 photo data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!hasSignature(bytes, contentType)) throw new InputError("unsupported_photo", "Use a JPEG, PNG or WebP image whose file contents match its type.", 415);
  return bytes;
}

async function changePhoto(db, input) {
  const remove = input.action === "removePhoto";
  const common = ["action", "slug", "expectedRevision"];
  onlyFields(input, remove ? common : [...common, "contentType", "altText", "caption", "dataBase64"]);
  checkPhotoTarget(input);
  const { slug, expectedRevision, contentType, altText, caption = "" } = input;
  let fingerprint;
  let mutation;
  if (remove) {
    mutation = db.prepare(`DELETE FROM blog_photos WHERE slug = ?1 AND
      EXISTS (SELECT 1 FROM blog_posts WHERE slug = ?1 AND revision = ?2) RETURNING slug`).bind(slug, expectedRevision);
  } else {
    checkText(altText, "Photo alt text", 300);
    if (caption !== "") checkText(caption, "Photo caption", 500);
    const bytes = decodePhoto(input.dataBase64, contentType);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    fingerprint = Array.from(digest, n => n.toString(16).padStart(2, "0")).join("");
    mutation = db.prepare(`INSERT INTO blog_photos (slug,content_type,alt_text,caption,byte_length,sha256,data)
      SELECT ?1,?3,?4,?5,?6,?7,?8 FROM blog_posts WHERE slug = ?1 AND revision = ?2
      ON CONFLICT(slug) DO UPDATE SET content_type=excluded.content_type, alt_text=excluded.alt_text,
        caption=excluded.caption, byte_length=excluded.byte_length, sha256=excluded.sha256, data=excluded.data
      WHERE blog_photos.sha256 <> excluded.sha256 OR blog_photos.alt_text <> excluded.alt_text
        OR blog_photos.caption <> excluded.caption OR blog_photos.content_type <> excluded.content_type RETURNING slug`)
      .bind(slug, expectedRevision, contentType, altText, caption, bytes.byteLength, fingerprint, bytes);
  }
  const { changed, post } = await writeAndRead(db, mutation, slug);
  if (!post) return failure(404, "not_found", "Editorial article not found.");
  if (changed) return writeResult(post, true);
  const photo = post.photo;
  const matches = remove ? !photo : photo?.sha256 === fingerprint && photo.contentType === contentType
    && photo.altText === altText && photo.caption === caption;
  return matches ? writeResult(post, false) : revisionConflict(post);
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
      if (input.action === "setPhoto" || input.action === "removePhoto") return await changePhoto(db, input);
      if (input.action === "get") {
        onlyFields(input, ["action", "slug"]);
        checkSlug(input.slug);
        const post = storedPost(await currentPostQuery(db, input.slug).first());
        return post ? json({ ok: true, post, url: urlFor(post) }) : failure(404, "not_found", "Editorial article not found.");
      }
      throw new InputError("invalid_input", "Action must be list, get, save, setPhoto or removePhoto.");
    } catch (error) {
      if (error instanceof InputError) return failure(error.status, error.code, error.message);
      return failure(503, "unavailable", "The editorial service is unavailable.");
    }
  },
};
