// かぎ家計簿 — はじめての設定(パスフレーズを決めて保管庫を作る)

import { h, icon, toast } from '../dom.js';
import { createInitialState } from '../model.js';
import { MIN_LENGTH, assessPassphrase } from '../passphrase.js';
import { brand, installHint, messageBox, passphraseField, strengthMeter, usernameField } from './common.js';
import { openRestore } from './dialogs.js';

const POINTS = [
  ['どこにも送信しません', '記録はこの端末の中だけに保存します。通信なしで動きます。'],
  ['すべて暗号化して保存します', '金額もメモも、保存するときは AES-256 で暗号化します。'],
  ['鍵を持つのはあなただけです', 'パスフレーズはどこにも保存されません。忘れると、誰にも復元できません。'],
];

export function renderSetup(app, { notice = null } = {}) {
  let busy = false;
  const first = passphraseField({
    id: 'new-passphrase',
    label: 'パスフレーズ',
    autocomplete: 'new-password',
    hint: `${MIN_LENGTH} 文字以上。関係のない言葉を 4 つほどつなげるか、パスワード管理アプリで作るのがおすすめです。`,
  });
  const second = passphraseField({ id: 'new-passphrase-confirm', label: 'もう一度入力', autocomplete: 'new-password' });
  const meter = strengthMeter();
  first.input.addEventListener('input', () => meter.update(first.input.value));

  const understood = h('input', { type: 'checkbox', id: 'understood' });
  const error = messageBox();
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'この内容ではじめる');

  const onSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const passphrase = first.input.value;
    const assessment = assessPassphrase(passphrase);
    if (!assessment.ok) {
      error.show(assessment.problems[0]);
      first.input.focus();
      return;
    }
    if (passphrase.normalize('NFKC') !== second.input.value.normalize('NFKC')) {
      error.show('2 つのパスフレーズが一致しません。');
      second.input.focus();
      return;
    }
    if (!understood.checked) {
      error.show('最後の確認にチェックを入れてください。');
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = '鍵を作っています…';
    error.clear();
    try {
      await app.vault.create(passphrase, createInitialState());
    } catch {
      busy = false;
      submit.disabled = false;
      submit.textContent = 'この内容ではじめる';
      error.show('保管庫を作れませんでした。ページを読み込み直して、もう一度お試しください。');
      return;
    }
    first.input.value = '';
    second.input.value = '';
    app.enter();
    toast('保管庫を作りました。');
  };

  const node = h(
    'main',
    { class: 'auth' },
    brand('端末の中だけに、暗号化して残す家計簿'),
    notice === null ? null : h('p', { class: 'message is-info' }, icon('check', { size: 18 }), h('span', null, notice)),
    h(
      'ul',
      { class: 'points' },
      POINTS.map(([title, text]) =>
        h(
          'li',
          { class: 'point' },
          icon('shield', { size: 22 }),
          h('div', null, h('p', { class: 'point-title' }, title), h('p', { class: 'point-text' }, text)),
        ),
      ),
    ),
    installHint(app),
    h(
      'form',
      { class: 'auth-form card', novalidate: true, on: { submit: onSubmit } },
      h('h2', { class: 'form-title' }, 'パスフレーズを決める'),
      usernameField(),
      first.node,
      meter.node,
      second.node,
      h(
        'label',
        { class: 'check', for: 'understood' },
        understood,
        h('span', null, 'パスフレーズを忘れると、記録を二度と読めなくなることを理解しました'),
      ),
      error.node,
      submit,
    ),
    h(
      'button',
      { class: 'btn-link', type: 'button', on: { click: () => openRestore(app, { mode: 'setup' }) } },
      'バックアップから復元する',
    ),
  );
  return { node, cleanup: null };
}
