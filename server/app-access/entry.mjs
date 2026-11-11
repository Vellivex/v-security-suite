// SPDX-License-Identifier: GPL-3.0-or-later
import {createAppAccessGate, markAuthorizedAppDocument} from './gate.mjs';
import {CENTRAL_ORIGIN, allowedAudience} from './registry.mjs';

// Wrap the currently deployed application. Existing capability handlers,
// named Durable Object exports and non-fetch event handlers stay in place.
export function withAppAccess(worker, {central, overrides = {}, transform, proxy, origins} = {}) {
  if (typeof worker?.fetch !== 'function') throw new TypeError('An existing worker is required');
  if (origins && (!Array.isArray(origins) || !origins.length || origins.some(origin => !allowedAudience(origin)))) throw new TypeError('Only registered app origins are permitted');
  const admittedOrigins = origins ? new Set(origins) : null;
  const gate = createAppAccessGate(central ? {broker: (request, env) => central.fetch(request, env)} : {});
  return {...worker, async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (central && (url.origin === 'https://app-access.internal' ||
        url.origin === CENTRAL_ORIGIN && (url.pathname === '/access' || url.pathname === '/access-ui.js' ||
        url.pathname === '/access.css' || url.pathname.startsWith('/api/app-access/') || url.pathname.startsWith('/__app_access/')))) {
      return central.fetch(request, env, ctx);
    }
    // Worker previews and unregistered custom hosts must not expose an
    // ungated copy through the original application's fallback dispatcher.
    if (!allowedAudience(url.origin) || admittedOrigins && !admittedOrigins.has(url.origin)) {
      return new Response('This app is available only at its Vellivex address.', {status: 403, headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'X-Vellivex-App-Access': 'required',
      }});
    }
    const admission = await gate.handle(request, env);
    if (admission) return admission;
    if (proxy) {
      const proxied = await proxy(request, env, ctx);
      if (proxied) return proxied;
    }
    let response = await worker.fetch(request, env, ctx);
    const asset = Object.hasOwn(overrides, url.pathname) ? overrides[url.pathname] : null;
    if (asset && ['GET', 'HEAD'].includes(request.method) && response.status === 200) {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', asset.type);
      headers.set('Cache-Control', 'no-store');
      headers.delete('Content-Length'); headers.delete('ETag'); headers.delete('Content-Encoding');
      void response.body?.cancel();
      response = new Response(request.method === 'HEAD' ? null : asset.body, {status: 200, headers});
    }
    if (transform) response = await transform(request, response);
    return markAuthorizedAppDocument(request, response);
  }};
}
