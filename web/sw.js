// SPDX-License-Identifier: GPL-3.0-or-later
const CACHE='v-tools-0.1.0';
const FILES=['/apps/vault','/apps/relay','/apps/crypto.js','/app.js','/site.js','/style.css','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('v-tools-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!FILES.includes(url.pathname))return;event.respondWith(caches.match(url.pathname).then(cached=>cached||fetch(event.request)));});
