// SPDX-License-Identifier: GPL-3.0-or-later
// The public Worker only reads published content. Editorial writes use the owner's Cloudflare account.
const canonicalOrigin = 'https://www.vellivex.com';
const publicOrigins = new Set([canonicalOrigin, 'https://vellivex.com']);
const collections = new Set(['/blog', '/sitemap.xml', '/rss.xml']);
const safeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const htmlDate = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
const fields = 'slug, title, summary, published_at, updated_at';
const photoStylesheet = '/assets/blog-photo.css';
const photoCss = `.blog-photo{margin:1.5rem 0}.blog-photo img{display:block;max-width:100%;height:auto;margin-inline:auto}.blog-photo figcaption{margin-top:.65rem;overflow-wrap:anywhere}`;
const photoTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const photoDigest = /^[a-f0-9]{64}$/;

function validPhoto(photo) {
  return photo && photoTypes.has(photo.content_type) && photoDigest.test(photo.sha256) &&
    Number.isInteger(photo.byte_length) && photo.byte_length > 0 && photo.byte_length <= 1572864 &&
    typeof photo.alt_text === 'string' && !!photo.alt_text.trim();
}

function bodyHeaders(original) {
  const headers = new Headers(original.headers);
  for (const key of ['Content-Length', 'ETag', 'Last-Modified', 'Content-MD5', 'Digest', 'Content-Encoding', 'Content-Disposition']) headers.delete(key);
  headers.set('Cache-Control', 'no-store');
  return headers;
}

function assetResponse(original, body, type, size) {
  const headers = bodyHeaders(original);
  headers.set('Content-Type', type);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex');
  if (size !== undefined) headers.set('Content-Length', String(size));
  return new Response(body, {status: 200, headers});
}

async function publishedPhoto(request, previous, url, db, slug) {
  const head = request.method === 'HEAD';
  const version = url.searchParams.get('v');
  const missing = () => new Response(null, {status: 404, headers: bodyHeaders(previous)});
  if (version !== null && !photoDigest.test(version)) return missing();
  const result = await db.prepare(`SELECT f.content_type, f.byte_length, f.sha256, f.alt_text${head ? '' : ', f.data'}
    FROM blog_photos f JOIN blog_posts p ON p.slug = f.slug
    WHERE p.status = 'published' AND f.slug = ?`).bind(slug).first();
  if (!validPhoto(result) || (version !== null && result.sha256 !== version)) return missing();
  if (head) return assetResponse(previous, null, result.content_type, result.byte_length);
  const bytes = Array.isArray(result.data) ? Uint8Array.from(result.data) : result.data;
  if (!(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array) || bytes.byteLength !== result.byte_length) return missing();
  return assetResponse(previous, bytes, result.content_type, result.byte_length);
}

function escapeText(value) {
  return value.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);
}

function validSummary(post) {
  return post && typeof post.slug === 'string' && post.slug.length <= 100 && safeSlug.test(post.slug) &&
    typeof post.title === 'string' && !!post.title.trim() && typeof post.summary === 'string' &&
    !!post.summary.trim() && Number.isFinite(Date.parse(post.published_at)) && Number.isFinite(Date.parse(post.updated_at));
}

function dateLabel(timestamp) {
  return `<time datetime="${new Date(timestamp).toISOString()}">${htmlDate.format(new Date(timestamp))}</time>`;
}

function articleBody(text) {
  // The author supplies plain text. Blank lines separate paragraphs; heading lines stand alone.
  const parts = [];
  let lines = [];
  const closeParagraph = () => {
    if (lines.length) parts.push('<p>' + lines.join(' ') + '</p>');
    lines = [];
  };
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim();
    const heading = /^(##|###)\s+(.+)$/.exec(line);
    if (!line || heading) closeParagraph();
    if (heading) {
      const level = heading[1].length;
      parts.push(`<h${level}>${escapeText(heading[2])}</h${level}>`);
    } else if (line) {
      lines.push(escapeText(line));
    }
  }
  closeParagraph();
  return parts.join('\n');
}

function articlePath(post) {
  return '/blog/' + post.slug;
}

function articlePage(shell, post) {
  // Reuse the site's real 404 shell so future header, stylesheet and footer changes carry across.
  const main = /(<main\b[^>]*>)[\s\S]*?<\/main>/i;
  if (!main.test(shell) || !shell.includes('</head>')) return null;
  const title = escapeText(post.title);
  const summary = escapeText(post.summary);
  const fullTitle = title + ' | Vellivex';
  const url = canonicalOrigin + articlePath(post);
  const photoUrl = validPhoto(post) ? articlePath(post) + '/photo?v=' + post.sha256 : '';
  let figure = '';
  let photoTags = '';
  if (photoUrl) {
    const alt = escapeText(post.alt_text);
    const caption = post.caption ? `<figcaption class="fine">${escapeText(post.caption)}</figcaption>` : '';
    figure = `<figure class="blog-photo"><img src="${photoUrl}" alt="${alt}" decoding="async">${caption}</figure>`;
    photoTags = `<link rel="stylesheet" href="${photoStylesheet}"><meta property="og:image" content="${canonicalOrigin + photoUrl}"><meta property="og:image:alt" content="${alt}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${canonicalOrigin + photoUrl}"><meta name="twitter:image:alt" content="${alt}">`;
    shell = shell.replace(/<meta\s+(?:name="twitter:(?:card|image(?::alt)?)"|property="og:image(?::(?:alt|width|height|type|secure_url))?")[^>]*>/gi, '');
  }
  const tags = [
    `<title>${fullTitle}</title>`,
    `<meta name="description" content="${summary}">`,
    '<meta name="robots" content="index,follow">',
    `<link rel="canonical" href="${url}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${fullTitle}">`,
    `<meta property="og:description" content="${summary}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta name="twitter:title" content="${fullTitle}">`,
    `<meta name="twitter:description" content="${summary}">`,
    photoTags,
  ].join('');
  const content = `<div class="wrap page-head"><p class="eyebrow"><a href="/blog">Guides &amp; field notes</a></p><h1>${title}</h1><p class="lead">${summary}</p></div>
<article class="wrap narrow content"><p class="fine">Vellivex · ${dateLabel(post.published_at)}</p>${figure}<div class="guide-body">${articleBody(post.body)}</div><hr><p><a href="/blog">← All guides</a></p></article>`;
  return shell.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\s+(?:name="(?:robots|description|twitter:title|twitter:description)"|property="og:(?:title|description|url|type)")[^>]*>/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>/gi, '')
    .replace('</head>', () => tags + '</head>')
    .replace(main, (_, opening) => opening + content + '</main>');
}

function guideCard(post) {
  const path = articlePath(post);
  return `<article class="product"><h2><a href="${path}">${escapeText(post.title)}</a></h2><p>${escapeText(post.summary)}</p><p class="fine">Vellivex · ${dateLabel(post.published_at)}</p><a class="text-link" href="${path}">Read the post ↗</a></article>`;
}

function collectPosts(path, previous, posts) {
  // A previously published legacy URL always wins over any conflicting database record.
  const used = new Set();
  const references = path === '/blog' ? /href=["'](?:https:\/\/www\.vellivex\.com)?\/blog\/([a-z0-9-]+)\/?["']/g :
    /<(?:loc|link)>\s*https:\/\/www\.vellivex\.com\/blog\/([a-z0-9-]+)\/?\s*<\//g;
  for (const match of previous.matchAll(references)) used.add(match[1]);
  const additional = posts.filter(post => validSummary(post) && !used.has(post.slug));
  if (!additional.length) return previous;
  if (path === '/blog') {
    return previous.replace(/<section\b[^>]*class=["']products["'][^>]*>/i, opening => opening + additional.map(guideCard).join(''));
  }
  if (path === '/sitemap.xml') {
    const urls = additional.map(post => `<url><loc>${canonicalOrigin + articlePath(post)}</loc><lastmod>${new Date(post.updated_at).toISOString()}</lastmod></url>`);
    return previous.replace('</urlset>', () => urls.join('') + '</urlset>');
  }
  const items = additional.map(post => {
    const url = canonicalOrigin + articlePath(post);
    return `<item><title>${escapeText(post.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${escapeText(post.summary)}</description><pubDate>${new Date(post.published_at).toUTCString()}</pubDate></item>`;
  });
  return previous.replace(/<item\b|<\/channel>/, next => items.join('') + next);
}

function responseWithBody(original, content, status) {
  const headers = bodyHeaders(original);
  if (status === 200 && original.status === 404) headers.set('X-Robots-Tag', 'index, follow');
  return new Response(content, {status, headers});
}

export function withBlog(worker) {
  return {...worker, async fetch(request, env, ctx) {
    const previous = await worker.fetch(request, env, ctx);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const listing = collections.has(path);
    const match = /^\/blog\/([^/]+)(\/photo)?$/.exec(path);
    const slug = match?.[1];
    if (!publicOrigins.has(url.origin) || !['GET', 'HEAD'].includes(request.method)) return previous;
    if (path === photoStylesheet && previous.status === 404) {
      return assetResponse(previous, request.method === 'HEAD' ? null : photoCss, 'text/css; charset=utf-8');
    }
    if (!env?.BLOG_DB ||
        (!listing && !(slug?.length <= 100 && safeSlug.test(slug)))) return previous;
    if (listing ? previous.status !== 200 : previous.status !== 404) return previous;
    const type = previous.headers.get('Content-Type') || '';
    if ((slug || path === '/blog') ? !type.includes('text/html') : !type.includes('xml')) return previous;
    const encoding = previous.headers.get('Content-Encoding');
    if (encoding && encoding !== 'identity') return previous;

    try {
      if (match?.[2]) return await publishedPhoto(request, previous, url, env.BLOG_DB, slug);
      if (!listing) {
        const post = await env.BLOG_DB.prepare(`SELECT p.slug, p.title, p.summary, p.published_at, p.updated_at, p.body,
          f.content_type, f.alt_text, f.caption, f.byte_length, f.sha256
          FROM blog_posts p LEFT JOIN blog_photos f ON f.slug = p.slug
          WHERE p.slug = ? AND p.status = 'published'`).bind(slug).first();
        if (!validSummary(post) || !post.body?.trim()) return previous;
        if (request.method === 'HEAD') return responseWithBody(previous, null, 200);
        const rendered = articlePage(await previous.clone().text(), post);
        return rendered === null ? previous : responseWithBody(previous, rendered, 200);
      }
      if (request.method === 'HEAD') return responseWithBody(previous, null, 200);
      const {results} = await env.BLOG_DB.prepare(`SELECT ${fields} FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC, slug ASC`).all();
      if (!results?.length) return previous;
      const original = await previous.clone().text();
      const changed = collectPosts(path, original, results);
      return changed === original ? previous : responseWithBody(previous, changed, 200);
    } catch (error) {
      // The static publication remains available through a D1 outage. No private content is logged.
      console.error('Could not render published Vellivex blog data.');
      return previous;
    }
  }};
}
