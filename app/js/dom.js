// かぎ家計簿 — 画面を組み立てるための安全な部品
//
// 方針: 文字列を HTML として解釈させる API は一切使わない。
// 利用者が入力した文字(メモやカテゴリ名)は、必ずテキストノードとして画面に入れる。

const SVG_NS = 'http://www.w3.org/2000/svg';

// 文字列を HTML・スクリプト・URL として解釈する属性は、この部品からは設定させない
const BLOCKED_KEYS = /^(on.+|innerhtml|outerhtml|srcdoc|style|href|src|action|formaction)$/i;
const BOOLEAN_PROPS = new Set(['checked', 'disabled', 'hidden', 'readOnly', 'required', 'selected', 'open']);

/**
 * 要素を作る。
 *   h('button', { class: 'btn', type: 'button', on: { click: fn } }, 'ラベル')
 * 子に渡した文字列は、すべてただの文字として扱われる。
 */
export function h(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props !== null) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'on') {
        for (const [type, listener] of Object.entries(value)) node.addEventListener(type, listener);
      } else if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key === 'value') {
        node.value = value;
      } else if (key === 'dataset') {
        for (const [name, data] of Object.entries(value)) node.dataset[name] = data;
      } else if (BOOLEAN_PROPS.has(key)) {
        node[key] = Boolean(value);
      } else if (BLOCKED_KEYS.test(key)) {
        throw new TypeError(`h(): "${key}" は安全のため指定できません`);
      } else if (value !== false) {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  return append(node, children);
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

const ICON_PATHS = {
  home: ['M4 11.2 12 4l8 7.2V19a1 1 0 0 1-1 1h-4.2v-5.6H9.2V20H5a1 1 0 0 1-1-1z'],
  chart: ['M5 20v-9', 'M12 20V4', 'M19 20v-6'],
  sliders: [
    'M4 7h9',
    'M19 7h1',
    'M4 17h1',
    'M11 17h9',
    'M13 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    'M5 17a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  lock: [
    'M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11z',
    'M8 11V8a4 4 0 0 1 8 0v3',
  ],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  eye: [
    'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z',
    'M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  ],
  'eye-off': [
    'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z',
    'M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    'M4 4l16 16',
  ],
  trash: ['M5 7h14', 'M10 7V4.5h4V7', 'M7 7l.8 12.5h8.4L17 7'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 20h14'],
  upload: ['M12 15V4', 'M7.5 8.5 12 4l4.5 4.5', 'M5 20h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 4 2.8 20h18.4L12 4z', 'M12 10v4.5', 'M12 17.2v.1'],
  shield: ['M12 3l7 3v5.2c0 4.6-3.2 8.2-7 9.8-3.8-1.6-7-5.2-7-9.8V6l7-3z', 'M9 12l2.2 2.2L15 10.4'],
  table: ['M4 6h16v12H4z', 'M4 10h16', 'M4 14h16', 'M10 6v12'],
  info: ['M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0', 'M12 11v5.5', 'M12 7.8v.1'],
  tag: ['M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5z', 'M8 8v.1'],
  camera: [
    'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
    'M9 13.5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  ],
  image: ['M4 5h16v14H4z', 'M4 16l4.5-4.5 4 4 2.5-2.5L20 17', 'M15 9.5v.1'],
  zoom: ['M4 10.5a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0', 'M15.5 15.5 20 20', 'M10.5 8v5', 'M8 10.5h5'],
};

/** 線画アイコン。パスはこのファイル内の固定データだけを使う。 */
export function icon(name, { size = 24 } = {}) {
  const paths = ICON_PATHS[name];
  if (paths === undefined) throw new RangeError(`unknown icon: ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const data of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// お知らせ(トースト)
// ---------------------------------------------------------------------------

function toastHost() {
  return document.getElementById('toasts');
}

/** 画面下に短いお知らせを出す。金額などの中身は載せない。 */
export function toast(message, { kind = 'info', duration = 2800 } = {}) {
  const host = toastHost();
  const node = h('div', { class: `toast toast-${kind}` }, message);
  host.append(node);
  if (typeof host.showPopover === 'function') {
    // ダイアログより手前に出すため、最前面のレイヤーに載せ直す
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // popover が使えない環境では通常の固定表示のまま
    }
  }
  setTimeout(() => {
    node.remove();
    if (host.childElementCount === 0 && typeof host.hidePopover === 'function') {
      try {
        if (host.matches(':popover-open')) host.hidePopover();
      } catch {
        // 上と同じ
      }
    }
  }, duration);
}

export function clearToasts() {
  toastHost().replaceChildren();
}

// ---------------------------------------------------------------------------
// ダイアログ
// ---------------------------------------------------------------------------

function overlayHost() {
  return document.getElementById('overlays');
}

/**
 * モーダルダイアログを開く。
 * `build(close, guard)` が中身のノードを返す。`close(値)` で閉じると `closed` がその値で解決する。
 * Esc・戻るボタン・ロックで閉じられたときは null で解決する。
 * 途中でやめられない処理のあいだは `guard.busy = true` にしておくと、Esc や戻るボタンでは閉じなくなる。
 */
export function openDialog(build, { className = 'dialog', backdropClose = false } = {}) {
  const dialog = h('dialog', { class: className });
  const guard = { busy: false };
  let settled = false;
  let settle;
  const closed = new Promise((resolve) => {
    settle = resolve;
  });
  // 後始末は close イベントを待たず、その場で行う。
  // (close イベントは次の描画まで届かないので、画面が隠れている間のロックでは当てにできない)
  const close = (value = null) => {
    if (settled) return;
    settled = true;
    openDialogs.delete(close);
    if (dialog.open) dialog.close();
    dialog.remove();
    settle(value);
  };
  // Esc や端末の「戻る」など、ブラウザ側から閉じられたとき
  dialog.addEventListener('close', () => close(null));
  dialog.addEventListener('cancel', (event) => {
    if (guard.busy) event.preventDefault();
  });
  if (backdropClose) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && !guard.busy) close(null);
    });
  }
  append(dialog, [build(close, guard)]);
  openDialogs.add(close);
  overlayHost().append(dialog);
  dialog.showModal();
  return { dialog, close, closed };
}

const openDialogs = new Set();

/** 開いているダイアログをすべて閉じる(ロック時に呼ぶ)。待っている側には null が返る。 */
export function closeAllDialogs() {
  for (const close of Array.from(openDialogs)) close(null);
  overlayHost().replaceChildren();
}

/** 確認ダイアログ。`checkLabel` を渡すと、チェックを入れるまで実行ボタンを押せない。 */
export function confirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
  danger = false,
  checkLabel = null,
}) {
  const { closed } = openDialog(
    (close) => {
      const confirm = h(
        'button',
        {
          class: danger ? 'btn btn-danger' : 'btn btn-primary',
          type: 'button',
          disabled: checkLabel !== null,
          on: { click: () => close(true) },
        },
        confirmLabel,
      );
      const check =
        checkLabel === null
          ? null
          : h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                on: {
                  change: (event) => {
                    confirm.disabled = !event.target.checked;
                  },
                },
              }),
              h('span', null, checkLabel),
            );
      const lines = Array.isArray(message) ? message : [message];
      return h(
        'div',
        { class: 'dialog-body' },
        h('h2', { class: 'dialog-title' }, title),
        lines.map((line) => h('p', { class: 'dialog-text' }, line)),
        check,
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, cancelLabel),
          confirm,
        ),
      );
    },
    { backdropClose: true },
  );
  return closed.then((value) => value === true);
}
