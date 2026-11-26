// かぎ家計簿 — Service Worker(オフラインでも起動できるようにする)
//
// - アプリのファイル一式を、インストール時にまとめてキャッシュする。
// - 以後はキャッシュから配り、通信がなくても起動できる。
// - 家計簿のデータは扱わない(データは IndexedDB の暗号文だけ)。
// - 別のサイトあての通信や、GET 以外の通信は、ここですべて止める。

'use strict';

// --- BEGIN GENERATED (tools/update_sw.py) ---
const VERSION = '5540220018b38bd4';
const ASSETS = [
  './',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'js/app.js',
  'js/crypto.js',
  'js/dom.js',
  'js/format.js',
  'js/main.js',
  'js/model.js',
  'js/passphrase.js',
  'js/screens/analysis.js',
  'js/screens/common.js',
  'js/screens/dialogs.js',
  'js/screens/entry.js',
  'js/screens/home.js',
  'js/screens/lock.js',
  'js/screens/main.js',
  'js/screens/settings.js',
  'js/screens/setup.js',
  'js/store.js',
  'js/vault.js',
  'js/version.js',
  'manifest.webmanifest',
];
// --- END GENERATED ---

const CACHE_PREFIX = 'kagi-kakeibo-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 1 つでも取得に失敗したら全体を失敗にし、古い版のまま動かし続ける
      await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached !== undefined) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./');
        if (shell !== undefined) return shell;
      }
      return fetch(request);
    })(),
  );
});
