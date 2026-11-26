// かぎ家計簿 — 複数の画面で使う部品

import { WrongPassphraseError } from '../crypto.js';
import { h, icon } from '../dom.js';
import { formatMonth } from '../format.js';
import { currentMonth, shiftMonth } from '../model.js';
import { assessPassphrase } from '../passphrase.js';
import { FREE_ATTEMPTS, ThrottledError } from '../vault.js';
import { APP_NAME } from '../version.js';

// ---------------------------------------------------------------------------
// 実行環境
// ---------------------------------------------------------------------------

/** ホーム画面に追加したアプリとして動いているか。 */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function platformName() {
  const agent = navigator.userAgent;
  if (/Android/.test(agent)) return 'android';
  // iPad は Mac と名乗るので、タッチできる Mac として見分ける
  if (/iPhone|iPad|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'other';
}

export function isTouchPrimary() {
  return window.matchMedia('(pointer: coarse)').matches;
}

// ---------------------------------------------------------------------------
// 見出し・メッセージ
// ---------------------------------------------------------------------------

export function brand(tagline = null) {
  return h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('lock', { size: 30 })),
    h('h1', { class: 'brand-name' }, APP_NAME),
    tagline === null ? null : h('p', { class: 'brand-tagline' }, tagline),
  );
}

/** エラーやお知らせを出す枠。何も出していないときは隠れている。 */
export function messageBox() {
  const text = h('span');
  const node = h('div', { class: 'message is-error', role: 'alert', hidden: true }, icon('alert', { size: 18 }), text);
  return {
    node,
    show(message, kind = 'error') {
      text.textContent = message;
      node.className = `message is-${kind}`;
      node.hidden = false;
    },
    clear() {
      text.textContent = '';
      node.hidden = true;
    },
  };
}

export function paragraphs(lines, className = 'dialog-text') {
  return (Array.isArray(lines) ? lines : [lines]).map((line) => h('p', { class: className }, line));
}

// ---------------------------------------------------------------------------
// パスフレーズ
// ---------------------------------------------------------------------------

const PASSPHRASE_CONCEAL = 'kagi-conceal';
const PASSPHRASE_RESET = 'kagi-reset';

/**
 * 画面上のすべてのパスフレーズ欄に合図を送る。
 * `clear` が true なら入力内容も消し、false なら「表示」にしていたものを伏せ字に戻すだけ。
 */
export function resetPassphraseFields(clear) {
  for (const input of document.querySelectorAll('input.input-passphrase')) {
    input.dispatchEvent(new Event(clear ? PASSPHRASE_RESET : PASSPHRASE_CONCEAL));
  }
}

/** 表示・非表示を切り替えられるパスフレーズ入力欄。 */
export function passphraseField({ id, label, autocomplete, hint = null }) {
  const input = h('input', {
    class: 'input input-passphrase',
    id,
    name: id,
    type: 'password',
    autocomplete,
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false', // 表示に切り替えたとき、入力内容がスペルチェックの対象にならないようにする
    required: true,
  });
  let shown = false;
  const setShown = (next) => {
    shown = next;
    input.type = shown ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(shown));
    reveal.setAttribute('aria-label', shown ? 'パスフレーズを隠す' : 'パスフレーズを表示する');
    reveal.replaceChildren(icon(shown ? 'eye-off' : 'eye', { size: 20 }));
  };
  const reveal = h(
    'button',
    {
      class: 'reveal-btn',
      type: 'button',
      'aria-label': 'パスフレーズを表示する',
      'aria-pressed': 'false',
      on: { click: () => setShown(!shown) },
    },
    icon('eye', { size: 20 }),
  );
  // アプリを離れるときに App から送られる合図。打ちかけのパスフレーズを画面に残さない。
  input.addEventListener(PASSPHRASE_CONCEAL, () => {
    if (shown) setShown(false);
  });
  input.addEventListener(PASSPHRASE_RESET, () => {
    if (shown) setShown(false);
    if (input.value !== '') {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const node = h(
    'div',
    { class: 'field' },
    h('label', { class: 'field-label', for: id }, label),
    h('div', { class: 'input-wrap' }, input, reveal),
    hint === null ? null : h('p', { class: 'field-hint' }, hint),
  );
  return { node, input };
}

/**
 * パスワード管理アプリが保存先を区別できるようにするための、見えない「ユーザー名」欄。
 * 管理アプリに保存しておけば、Face ID や指紋で自動入力して解錠できる。
 */
export function usernameField() {
  return h('input', {
    class: 'visually-hidden',
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    value: APP_NAME,
    readOnly: true,
    tabindex: '-1',
    'aria-hidden': 'true',
  });
}

export function strengthMeter() {
  const label = h('span', { class: 'strength-label' });
  const detail = h('p', { class: 'field-hint strength-detail' });
  const node = h(
    'div',
    { class: 'strength', 'aria-live': 'polite', dataset: { level: 'none' } },
    h(
      'div',
      { class: 'strength-row' },
      h('div', { class: 'strength-bars', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
      label,
    ),
    detail,
  );
  return {
    node,
    update(value) {
      if (value === '') {
        node.dataset.level = 'none';
        label.textContent = '';
        detail.textContent = '';
        return null;
      }
      const result = assessPassphrase(value);
      node.dataset.level = String(result.level);
      label.textContent = `強さ: ${result.label}`;
      detail.textContent = result.ok ? '' : result.problems[0];
      return result;
    },
  };
}

function formatWait(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} 分` : `${Math.ceil(minutes / 60)} 時間`;
}

export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** パスフレーズの確認に失敗したときの説明文。それ以外のエラーなら null。 */
export function describeAuthError(error, label = 'パスフレーズ') {
  if (error instanceof ThrottledError) {
    return `まちがいが続いたため、いまは試せません。${formatWait(error.retryAt - Date.now())}ほど待ってからやり直してください。`;
  }
  if (error instanceof WrongPassphraseError) {
    if (error.retryAt > 0) {
      return `${label}が違います。${formatWait(error.retryAt - Date.now())}ほど待ってからやり直してください。`;
    }
    const left = FREE_ATTEMPTS + 1 - error.failures;
    if (error.failures > 0 && left > 0) {
      return `${label}が違います。あと ${left} 回まちがえると、しばらく試せなくなります。`;
    }
    return `${label}が違います。`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 共通の操作部品
// ---------------------------------------------------------------------------

/** 2〜3 択の切り替えボタン。画面を描き直す使い方のときは `focusKey` を渡すとフォーカスが保たれる。 */
export function segmented({ label, options, value, onChange, focusKey = null }) {
  let current = value;
  const buttons = options.map((option) =>
    h(
      'button',
      {
        class: 'segmented-option',
        type: 'button',
        'aria-pressed': String(option.value === current),
        dataset: focusKey === null ? null : { focusKey: `${focusKey}-${option.value}` },
        on: {
          click: () => {
            if (option.value === current) return;
            current = option.value;
            buttons.forEach((button, index) => {
              button.setAttribute('aria-pressed', String(options[index].value === current));
            });
            onChange(current);
          },
        },
      },
      option.label,
    ),
  );
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons);
}

/** 月の切り替え(前の月・次の月・今月へ)。 */
export function monthSwitcher(app) {
  const atStart = shiftMonth(app.month, -1) === app.month;
  const atEnd = shiftMonth(app.month, 1) === app.month;
  return h(
    'div',
    { class: 'month-switch' },
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'aria-label': '前の月',
        disabled: atStart,
        dataset: { focusKey: 'month-prev' },
        on: { click: () => app.setMonth(shiftMonth(app.month, -1)) },
      },
      icon('chevron-left'),
    ),
    h('h1', { class: 'month-label' }, formatMonth(app.month)),
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'aria-label': '次の月',
        disabled: atEnd,
        dataset: { focusKey: 'month-next' },
        on: { click: () => app.setMonth(shiftMonth(app.month, 1)) },
      },
      icon('chevron-right'),
    ),
    app.month === currentMonth()
      ? null
      : h(
          'button',
          {
            class: 'pill-btn',
            type: 'button',
            dataset: { focusKey: 'month-now' },
            on: { click: () => app.setMonth(currentMonth()) },
          },
          '今月へ',
        ),
  );
}

/** 記録 1 件の行。`onClick` を渡すとボタンになる。 */
export function transactionRow(app, transaction, onClick = null) {
  const category = app.state.categories.find((item) => item.id === transaction.categoryId);
  const isIncome = transaction.type === 'income';
  const children = [
    h('span', { class: isIncome ? 'badge badge-income' : 'badge', 'aria-hidden': 'true' }, category ? category.mark : '?'),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-title' }, category ? category.name : '(不明なカテゴリ)'),
      transaction.memo === '' ? null : h('span', { class: 'row-memo' }, transaction.memo),
    ),
    // 収入は色に加えて + の符号でも区別する
    h(
      'span',
      { class: isIncome ? 'row-amount pos' : 'row-amount' },
      app.money(transaction.amount, { signed: isIncome }),
    ),
  ];
  if (onClick === null) return h('div', { class: 'row' }, children);
  return h('button', { class: 'row row-button', type: 'button', on: { click: onClick } }, children);
}

/** ホーム画面への追加を案内する枠。すでにアプリとして動いていれば null。 */
export function installHint(app) {
  if (isStandalone()) return null;
  const platform = platformName();
  let steps = 'ブラウザのメニューから「インストール」または「ホーム画面に追加」を選びます。';
  if (platform === 'ios') steps = 'Safari の共有ボタン(四角から上向きの矢印)→「ホーム画面に追加」を選びます。';
  if (platform === 'android') steps = 'ブラウザのメニュー(︙)→「アプリをインストール」または「ホーム画面に追加」を選びます。';
  const node = h(
    'div',
    { class: 'hint-box' },
    h('p', { class: 'hint-title' }, icon('info', { size: 18 }), 'ホーム画面に追加して使いましょう'),
    h(
      'p',
      { class: 'hint-text' },
      'ブラウザのタブで使い続けると、しばらく開かなかったときなどにブラウザが記録を消してしまうことがあります。',
      platform === 'ios' ? 'また iPhone では、ホーム画面のアプリとブラウザとで記録が別々に保存されます。' : '',
    ),
    h('p', { class: 'hint-text' }, steps),
  );
  if (app.installPrompt !== null) {
    node.append(
      h(
        'button',
        {
          class: 'btn btn-secondary btn-block',
          type: 'button',
          on: {
            click: async () => {
              const prompt = app.installPrompt;
              app.installPrompt = null;
              if (prompt !== null) await prompt.prompt();
            },
          },
        },
        'ホーム画面に追加する',
      ),
    );
  }
  return node;
}
