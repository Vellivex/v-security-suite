import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import gateway from "../server/blog/worker.mjs";

const schema = readFileSync(new URL("../server/blog/schema.sql", import.meta.url), "utf8");
const url = "https://editor.example.test/v1/blog";
const original = {
  action: "save", expectedRevision: 0, slug: "example-post", title: "Test article",
  summary: "A short summary", body: "A paragraph.\n\n## A heading\n\nIt's <b>plain text</b> 🔐.", status: "draft",
};

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  let sessions = 0;
  const db = {
    withSession(consistency) {
      assert.equal(consistency, "first-primary");
      sessions++;
      return {
        prepare(sql) {
          return {
            bind(...args) {
              const statement = sqlite.prepare(sql);
              return {
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
    ["application/json", " ".repeat(800001), 413],
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
