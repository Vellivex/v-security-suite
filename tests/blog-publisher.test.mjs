// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {withBlog} from '../server/blog/blog-publisher.mjs';

const origin = 'https://www.vellivex.com';
const at = '2026-11-01T14:10:00.000Z';
const shell = '<!doctype html><html><head><title>Page not found | Vellivex</title><meta name="description" content="Original"><meta name="robots" content="noindex,nofollow"><meta property="og:title" content="Page not found"></head><body><header>Vellivex</header><main id="main">Missing</main><footer>Footer</footer></body></html>';
const legacy = {
  '/blog': '<main><section class="products"><article><a href="/blog/original">Original</a></article></section></main>',
  '/blog/original': 'Original content',
  '/rss.xml': '<rss><channel><title>Vellivex</title><item><link>' + origin + '/blog/original</link></item></channel></rss>',
  '/sitemap.xml': '<urlset><url><loc>' + origin + '/blog/original</loc></url></urlset>',
  '/messenger': 'Messenger download',
};
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE blog_posts(slug TEXT PRIMARY KEY,title TEXT,summary TEXT,body TEXT,published_at TEXT,updated_at TEXT,status TEXT,revision INTEGER DEFAULT 1)');
  sql.exec(readFileSync(new URL('../server/blog/photos.sql', import.meta.url), 'utf8'));
  const calls = [];
  const put = (slug, title, status = 'published', date = at) => sql.prepare(
    'INSERT INTO blog_posts (slug,title,summary,body,published_at,updated_at,status) VALUES (?,?,?,?,?,?,?)'
  ).run(slug, title, 'A & B "guide"', 'First paragraph.\n\n## Heading\nText & <script>alert()</script>\nsecond line\n\n### Next\nLast.', date, date, status);
  const env = {BLOG_DB: {prepare(query) {
    calls.push(query);
    const statement = sql.prepare(query);
    return {all: async () => ({results: statement.all()}), bind: arg => ({first: async () => statement.get(arg)})};
  }}};
  const worker = withBlog({scheduled: 'untouched', fetch(request) {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const found = Object.hasOwn(legacy, path);
    const status = found ? 200 : 404;
    return new Response(request.method === 'HEAD' ? null : found ? legacy[path] : shell, {status, headers: {
      'Content-Type': path.endsWith('.xml') ? 'application/xml' : 'text/html',
      'Content-Security-Policy': "default-src 'none'", 'X-Robots-Tag': found ? 'index, follow' : 'noindex, nofollow',
      'ETag': '"static"',
    }});
  }});
  const get = (path, method = 'GET', binding = env) => worker.fetch(new Request(new URL(path, origin), {method}), binding);
  return {sql, calls, put, get, worker};
}

test('new posts use the original site shell, safe text, SEO and correct HEAD', async () => {
  const {put, get} = fixture();
  put('new-note', 'Money $& <test>');
  const response = await get('/blog/new-note');
  const page = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(response.headers.get('etag'), null);
  assert.match(page, /<header>Vellivex<\/header>.*<main id="main">/s);
  assert.match(page, /<footer>Footer<\/footer>/);
  assert.equal((page.match(/<title>/g) || []).length, 1);
  assert.ok(page.includes('<title>Money $&amp; &lt;test&gt; | Vellivex</title>'));
  assert.ok(page.includes('<link rel="canonical" href="https://www.vellivex.com/blog/new-note">'));
  assert.ok(page.includes('<meta name="description" content="A &amp; B &quot;guide&quot;">'));
  assert.ok(page.includes('<h2>Heading</h2>'));
  assert.ok(page.includes('<h3>Next</h3>'));
  assert.ok(page.includes('<p>Text &amp; &lt;script&gt;alert()&lt;/script&gt; second line</p>'));
  assert.ok(!page.includes('Page not found'));
  const head = await get('/blog/new-note', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('x-robots-tag'), 'index, follow');
});

test('index, sitemap and feed include only published values, respect order/legacy slugs, and reflect edits immediately', async () => {
  const {get, sql, put} = fixture();
  put('old-news', 'Old');
  put('new-news', 'New', 'published', '2026-11-30T14:00:00.000Z');
  put('draft', 'Private title', 'draft');
  put('original', 'Collision');
  for (const path of ['/blog', '/rss.xml', '/sitemap.xml']) {
    const page = await (await get(path)).text();
    assert.ok(page.indexOf('/blog/new-news') >= 0 && page.indexOf('/blog/new-news') < page.indexOf('/blog/old-news'));
    assert.equal((page.match(/\/blog\/original/g) || []).length, 1);
    assert.ok(!page.includes('Collision') && !page.includes('/blog/draft'));
  }
  assert.equal((await get('/blog/draft')).status, 404);
  assert.equal(await (await get('/blog/original')).text(), legacy['/blog/original']);
  sql.exec("UPDATE blog_posts SET title='Edited once' WHERE slug='old-news'");
  assert.ok((await (await get('/blog/old-news')).text()).includes('Edited once'));
  assert.ok((await (await get('/blog')).text()).includes('Edited once'));
  sql.exec("UPDATE blog_posts SET status='draft' WHERE slug='old-news'");
  for (const path of ['/blog', '/rss.xml', '/sitemap.xml']) assert.ok(!(await (await get(path)).text()).includes('/blog/old-news'));
  assert.equal((await get('/blog/old-news', 'HEAD')).status, 404);
});

test('static pages, unrelated methods and unrecognised origins bypass the blog database', async () => {
  const {get, calls, put, worker} = fixture();
  put('online', 'Published');
  assert.equal(worker.scheduled, 'untouched');
  assert.equal(await (await get('/messenger')).text(), legacy['/messenger']);
  assert.equal(await (await get('/blog/original')).text(), legacy['/blog/original']);
  assert.equal((await get('/blog/online', 'POST')).status, 404);
  assert.equal((await get('https://elsewhere.example/blog/online')).status, 404);
  assert.equal((await get('/blog/a..b')).status, 404);
  assert.equal((await get('/blog/online', 'GET', {})).status, 404);
  assert.equal(calls.length, 0);
});

test('unavailable D1 preserves the original static index and only known public posts can return 200', async () => {
  const {get} = fixture();
  const unavailable = {BLOG_DB:{prepare(){throw Error('offline');}}};
  const index = await get('/blog', 'GET', unavailable);
  assert.equal(await index.text(), legacy['/blog']);
  assert.equal((await get('/blog/unknown', 'GET', unavailable)).status, 404);
});

test('photo metadata, caption and share card are escaped and bytes are served only while published', async () => {
  const {sql, put, get, calls} = fixture();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY0UAAAAASUVORK5CYII=', 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = '/blog/field-note/photo';
  const versioned = path + '?v=' + digest;
  put('field-note', 'Field note', 'draft');
  sql.prepare('INSERT INTO blog_photos VALUES (?,?,?,?,?,?,?)')
    .run('field-note','image/png','A "lit" window & light','<Evening> $&',bytes.byteLength,digest,bytes);
  for (const method of ['GET', 'HEAD']) {
    const hidden = await get(versioned, method);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers.get('cache-control'), 'no-store');
    assert.equal(await hidden.text(), '');
  }
  assert.equal((await get('/blog/field-note')).status, 404);
  sql.exec("UPDATE blog_posts SET status='published' WHERE slug='field-note'");
  const article = await (await get('/blog/field-note')).text();
  assert.match(article, /<figure class="blog-photo"><img[^>]+alt="A &quot;lit&quot; window &amp; light"/);
  assert.ok(article.includes('<figcaption class="fine">&lt;Evening&gt; $&amp;</figcaption>'));
  assert.ok(article.includes('src="' + versioned + '"'));
  assert.ok(article.includes('<meta property="og:image" content="' + origin + versioned + '">'));
  assert.ok(article.includes('<link rel="stylesheet" href="/assets/blog-photo.css">'));
  assert.ok(!calls.at(-1).includes('f.data'));
  const css = await get('/assets/blog-photo.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /max-width:100%;height:auto/);
  for (const url of [path, versioned]) {
    const image = await get(url);
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('content-length'), String(bytes.byteLength));
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    const head = await get(url, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.byteLength));
    assert.equal(await head.text(), '');
    assert.ok(!calls.at(-1).includes('f.data'));
  }
  sql.exec("UPDATE blog_photos SET caption='' WHERE slug='field-note'");
  assert.ok(!(await (await get('/blog/field-note')).text()).includes('<figcaption'));
  assert.equal((await get(path + '?v=old')).status, 404);
  assert.equal((await get(path + '?v=' + '0'.repeat(64))).status, 404);
  sql.exec("UPDATE blog_posts SET status='draft' WHERE slug='field-note'");
  for (const url of [path, versioned]) assert.equal((await get(url)).status, 404);
  sql.exec("UPDATE blog_posts SET status='published' WHERE slug='field-note'; DELETE FROM blog_photos WHERE slug='field-note'");
  const textOnly = await (await get('/blog/field-note')).text();
  assert.ok(textOnly.includes('<h1>Field note</h1>'));
  assert.ok(!textOnly.includes('<figure') && !textOnly.includes('blog-photo.css') && !textOnly.includes('summary_large_image'));
  assert.equal((await get(versioned)).status, 404);
});
