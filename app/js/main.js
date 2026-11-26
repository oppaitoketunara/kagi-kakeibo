// かぎ家計簿 — 起動

import { App } from './app.js';

// ほかのサイトの枠 (iframe) の中では動かさない。
// 配信元がヘッダー (frame-ancestors) を設定できない場合に備えた、クリックジャッキング対策の保険。
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error('かぎ家計簿は、ほかのページに埋め込んだ状態では動きません');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // 開発中 (localhost) は、編集前のファイルがキャッシュから出てこないよう既定では登録しない。
  // オフライン動作を試すときだけ ?sw=1 を付けて開く。
  if (LOCAL_HOSTS.has(location.hostname) && new URLSearchParams(location.search).get('sw') !== '1') {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    return;
  }

  let scriptUrl = './sw.js';
  if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
    // Trusted Types: スクリプトとして読み込める URL を、この 1 つだけに限定する。
    const policy = window.trustedTypes.createPolicy('kagi-sw', {
      createScriptURL: (input) => {
        if (input !== './sw.js') throw new TypeError('unexpected script URL');
        return input;
      },
    });
    scriptUrl = policy.createScriptURL('./sw.js');
  }
  await navigator.serviceWorker.register(scriptUrl, { scope: './', updateViaCache: 'none' });
}

registerServiceWorker().catch(() => {
  // オフライン対応が使えないだけで、アプリ自体は動く
});

new App(document.getElementById('app')).start();
