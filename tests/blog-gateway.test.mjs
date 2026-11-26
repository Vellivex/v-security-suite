import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { crc32 } from "node:zlib";
import gateway from "../server/blog/worker.mjs";

const schema = readFileSync(new URL("../server/blog/schema.sql", import.meta.url), "utf8");
const photos = readFileSync(new URL("../server/blog/photos.sql", import.meta.url), "utf8");
const url = "https://editor.example.test/v1/blog";
const original = {
  action: "save", expectedRevision: 0, slug: "example-post", title: "Test article",
  summary: "A short summary", body: "A paragraph.\n\n## A heading\n\nIt's <b>plain text</b> 🔐.", status: "draft",
};

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  sqlite.exec(photos);
  t.after(() => sqlite.close());
  let sessions = 0;
  const db = {
    withSession(consistency) {
      assert.equal(consistency, "first-primary");
      sessions++;
      return {
        async batch(statements) {
          sqlite.exec("BEGIN");
          try {
            const result = statements.map(statement => statement.rows());
            sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
        prepare(sql) {
          return {
            bind(...args) {
              const statement = sqlite.prepare(sql);
              return {
                rows: () => ({ results: statement.all(...args) }),
                first: async () => statement.get(...args) ?? null,
                all: async () => ({ results: statement.all(...args) }),
              };
            },
          };
        },
      };
    },
  };
  const token = randomBytes(32).toString("base64url");
  const env = { BLOG_DB: db, BLOG_API_TOKEN: token };
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  async function send(data) {
    const response = await gateway.fetch(new Request(url, {
      method: "POST", headers, body: JSON.stringify(data),
    }), env);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    return { code: response.status, data: await response.json() };
  }
  return { sqlite, env, headers, send, getSessions: () => sessions };
}

test("gateway requires the exact endpoint, POST and valid bearer before opening the database", async t => {
  const { env, headers, getSessions } = fixture(t);
  assert.equal((await gateway.fetch(new Request(url + "/other"), env)).status, 404);
  assert.equal((await gateway.fetch(new Request(url + "?extra=1"), env)).status, 404);
  for (const method of ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await gateway.fetch(new Request(url, { method, headers }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  for (const auth of [null, "Basic test", "Bearer short", "Bearer " + randomBytes(32).toString("base64url")]) {
    const requestHeaders = { "Content-Type": "application/json" };
    if (auth) requestHeaders.Authorization = auth;
    const response = await gateway.fetch(new Request(url, { method: "POST", headers: requestHeaders, body: "{" }), env);
    assert.equal(response.status, 401);
  }
  for (const unavailable of [{ ...env, BLOG_API_TOKEN: null }, { ...env, BLOG_API_TOKEN: "weak" }, { ...env, BLOG_DB: null }]) {
    const response = await gateway.fetch(new Request(url, { method: "POST", headers, body: "{}" }), unavailable);
    assert.equal(response.status, 503);
  }
  assert.equal(getSessions(), 0);
});

test("gateway bounds and validates request bytes and endpoint operations", async t => {
  const { env, headers, send } = fixture(t);
  for (const [contentType, body, expected] of [
    ["text/plain", "{}", 415], ["application/json", "{", 400], ["application/json", "[]", 400],
    ["application/json", "null", 400], ["application/json", new Uint8Array([0xff]), 400],
    ["application/json", " ".repeat(2113153), 413],
  ]) {
    const request = new Request(url, { method: "POST", headers: { ...headers, "Content-Type": contentType }, body });
    assert.equal((await gateway.fetch(request, env)).status, expected);
  }
  for (const input of [
    { action: "delete", slug: original.slug }, { action: "query", sql: "SELECT 1" },
    { action: "list", limit: 0 }, { action: "list", limit: 101 }, { action: "list", limit: null },
    { action: "list", afterSlug: "invalid/slug" }, { action: "list", status: "" },
    { action: "get", slug: "bad\n" }, { action: "get", slug: original.slug, extra: true },
    { ...original, expectedRevision: "0" }, { ...original, expectedRevision: -1 }, { ...original, expectedRevision: 0.5 },
    { ...original, title: "\n  " }, { ...original, summary: "x".repeat(401) }, { ...original, body: "x".repeat(60001) },
    { ...original, title: "x".repeat(161) }, { ...original, body: "zero\u0000byte" },
    { ...original, title: "\uD800" }, { ...original, slug: "-bad" }, { ...original, slug: "bad--slug" },
    { ...original, status: "archived" }, { ...original, arbitrary: "field" },
  ]) {
    const response = await send(input);
    assert.equal(response.code, 400, JSON.stringify(input).slice(0,70));
  }
  assert.equal((await send({ action: "get", slug: original.slug })).code, 404);
});

test("draft, publish, concurrent, unpublish and republish operations preserve canonical state", async t => {
  const { sqlite, send } = fixture(t);
  const reserved = sqlite.prepare("SELECT slug FROM blog_reserved_slugs LIMIT 1").get().slug;
  assert.equal((await send({ ...original, slug: reserved })).data.error, "reserved_slug");
  const create = await send(original);
  assert.equal(create.code, 201);
  assert.deepEqual([create.data.changed, create.data.post.revision, create.data.post.publishedAt, create.data.url], [true, 1, null, null]);
  assert.equal(create.data.post.body, original.body);
  assert.match(create.data.post.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const duplicate = await send(original);
  assert.deepEqual([duplicate.code, duplicate.data.changed, duplicate.data.post.revision], [200, false, 1]);
  const collision = await send({ ...original, title: "A different article" });
  assert.deepEqual([collision.code, collision.data.error, collision.data.currentRevision], [409, "revision_conflict", 1]);
  const publish = { ...original, expectedRevision: 1, status: "published" };
  const [a, b] = await Promise.all([send(publish), send(publish)]);
  assert.deepEqual([a.data.changed, b.data.changed].sort(), [false, true]);
  const firstPublishedAt = a.data.post.publishedAt;
  assert.match(firstPublishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(a.data.url, "https://www.vellivex.com/blog/" + original.slug);
  assert.equal(b.data.post.revision, 2);
  const stale = await send({ ...publish, summary: "Overlapping edit" });
  assert.deepEqual([stale.code, stale.data.error, stale.data.currentRevision], [409, "revision_conflict", 2]);
  const unpublish = await send({ ...original, expectedRevision: 2 });
  assert.equal(unpublish.data.post.publishedAt, firstPublishedAt);
  assert.equal(unpublish.data.url, null);
  const edit = { ...publish, expectedRevision: 3, body: "Changed body 🔐." };
  const republish = await send(edit);
  assert.equal(republish.data.post.revision, 4);
  assert.equal(republish.data.post.publishedAt, firstPublishedAt);
  assert.equal((await send(edit)).data.changed, false);
  const get = await send({ action: "get", slug: original.slug });
  assert.deepEqual(get.data.post, republish.data.post);
  assert.equal(get.data.url, republish.data.url);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM blog_posts").get().n, 1);
});

test("listing is keyset-paginated, filtered by state, and omits full article bodies", async t => {
  const { send } = fixture(t);
  for (const [slug, status] of [["c", "published"], ["a", "published"], ["b", "draft"]]) {
    assert.equal((await send({ ...original, slug, status })).code, 201);
  }
  const first = (await send({ action: "list", limit: 2 })).data;
  assert.deepEqual(first.posts.map(p => p.slug), ["a", "b"]);
  assert.equal(first.posts[0].body, undefined);
  assert.equal(first.nextAfterSlug, "b");
  const last = (await send({ action: "list", limit: 2, afterSlug: first.nextAfterSlug })).data;
  assert.deepEqual(last.posts.map(p => p.slug), ["c"]);
  assert.equal(last.nextAfterSlug, null);
  assert.deepEqual((await send({ action: "list", status: "published" })).data.posts.map(p => p.slug), ["a", "c"]);
  assert.deepEqual((await send({ action: "list", status: "draft" })).data.posts.map(p => p.slug), ["b"]);
});

test("unexpected D1 failure has a compact response with no internal information", async t => {
  const { env, headers } = fixture(t);
  const request = new Request(url, { method: "POST", headers, body: '{"action":"list"}' });
  const response = await gateway.fetch(request, {
    ...env,
    BLOG_DB: { withSession() { throw new Error("private-handler-details"); } },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private-handler-details"), false);
});

const photoFiles = {
  "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mP8v5SBgYGBiYGBgYGBAQAU2QGo4O09ngAAAABJRU5ErkJggg==",
  "image/webp": "UklGRj4AAABXRUJQVlA4IDIAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8JCj/4cp8OU+HKf8OU/9QZ8tD5aH63AAAA==",
  "image/jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtASg0f//Z",
};
const firstPhoto = {
  action: "setPhoto", slug: original.slug, expectedRevision: 1, contentType: "image/png",
  altText: "An orange square", dataBase64: photoFiles["image/png"],
};

test("photos share the article revision, preserve metadata on text edits and retry safely", async t => {
  const { send, sqlite } = fixture(t);
  assert.equal((await send(firstPhoto)).code, 404);
  assert.equal((await send(original)).data.post.photo, null);
  const [a,b] = await Promise.all([send(firstPhoto),send(firstPhoto)]);
  assert.deepEqual([a.data.changed,b.data.changed].sort(), [false,true]);
  const photo = a.data.post.photo;
  assert.equal(a.code, 200);
  assert.deepEqual(Object.keys(photo).sort(), ["altText","byteLength","caption","contentType","sha256"]);
  assert.deepEqual([photo.altText,photo.caption,photo.contentType], [firstPhoto.altText,"","image/png"]);
  assert.equal(photo.byteLength, Buffer.from(firstPhoto.dataBase64,"base64").length);
  assert.match(photo.sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.data.post.revision, 2);
  assert.ok(a.data.post.updatedAt);
  assert.deepEqual((await send({action:"get", slug:original.slug})).data.post.photo, photo);
  assert.deepEqual((await send({action:"list"})).data.posts[0].photo, photo);
  assert.equal(Buffer.from(sqlite.prepare("SELECT data FROM blog_photos").get().data).toString("base64"), firstPhoto.dataBase64);

  assert.equal((await send({...original,body:"Stale edit",expectedRevision:1})).code, 409);
  const publish = await send({...original, status:"published", expectedRevision:2});
  assert.equal(publish.data.post.revision, 3);
  assert.deepEqual(publish.data.post.photo, photo);
  const withCaption = {...firstPhoto, expectedRevision:3, caption:"An optional caption."};
  assert.equal((await send(withCaption)).data.post.photo.caption, withCaption.caption);
  const staleRemove = {action:"removePhoto", slug:firstPhoto.slug, expectedRevision:3};
  assert.equal((await send(staleRemove)).code, 409);
  const replace = {...firstPhoto, contentType:"image/webp", dataBase64:photoFiles["image/webp"], expectedRevision:4};
  const replaced = await send(replace);
  assert.equal(replaced.data.post.revision, 5);
  assert.notEqual(replaced.data.post.photo.sha256, photo.sha256);
  assert.equal(replaced.data.post.photo.byteLength, Buffer.from(replace.dataBase64,"base64").length);
  assert.equal((await send(firstPhoto)).code, 409);
  assert.equal((await send(replace)).data.changed, false);
  const remove = {...staleRemove,expectedRevision:5};
  const removed = await send(remove);
  assert.equal(removed.data.post.revision, 6);
  assert.equal(removed.data.post.photo, null);
  assert.equal((await send(remove)).data.changed, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM blog_photos").get().n, 0);
  const jpeg = await send({...firstPhoto, contentType:"image/jpeg", dataBase64:photoFiles["image/jpeg"], expectedRevision:6});
  assert.equal(jpeg.data.post.photo.contentType, "image/jpeg");
  assert.equal((await send(remove)).code, 409);
  assert.equal(jpeg.data.post.publishedAt, publish.data.post.publishedAt);
});

test("photo operations validate binary signatures, encoding, lengths, revision and storage constraints",async t => {
  const { send, sqlite } = fixture(t);
  await send(original);
  for (const [overrides,code] of [
    [{contentType:"image/png",dataBase64:photoFiles["image/jpeg"]},415],
    [{contentType:"image/svg+xml",dataBase64:btoa("<svg/>")},415],
    [{contentType:"image/png",dataBase64:photoFiles["image/png"].slice(0,-4)},415],
    [{dataBase64:"SGVsbG8"},400], [{dataBase64:photoFiles["image/png"]+"\n"},400],
    [{dataBase64:Buffer.alloc(1572865).toString("base64")},413],
    [{caption:"a".repeat(501)},400], [{altText:" "},400], [{altText:"a".repeat(301)},400],
    [{expectedRevision:0},400], [{expectedRevision:1.5},400], [{caption:null},400],
    [{url:"https://example.invalid/photo.png"},400],
  ]) assert.equal((await send({...firstPhoto,...overrides})).code,code);
  assert.equal((await send({action:"removePhoto",slug:firstPhoto.slug,expectedRevision:1,extra:true})).code,400);
  assert.equal((await send({action:"get",slug:firstPhoto.slug})).data.post.revision,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM blog_photos").get().n,0);
  sqlite.exec(photos);
  sqlite.exec(`CREATE TRIGGER simulate_storage_failure BEFORE UPDATE ON blog_posts BEGIN SELECT RAISE(ABORT,'failure'); END;`);
  assert.equal((await send(firstPhoto)).code,503);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM blog_photos").get().n,0);
});

test("a complete PNG at the exact upload limit round-trips through SQLite as a BLOB", async t => {
  const {send, sqlite} = fixture(t);
  await send(original);
  const limit = 1572864;
  const png = Buffer.from(photoFiles["image/png"], "base64");
  const chunk = Buffer.alloc(limit - png.length);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("tEXt", 4);
  chunk.write("Description\0", 8);
  chunk.fill(32, 20, chunk.length - 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const photo = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const result = await send({...firstPhoto, dataBase64: photo.toString("base64")});
  assert.equal(result.code, 200);
  assert.equal(result.data.post.photo.byteLength, limit);
  assert.equal(Buffer.compare(sqlite.prepare("SELECT data FROM blog_photos").get().data, photo), 0);
});
