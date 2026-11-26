// かぎ家計簿 — ロック画面

import { confirmDialog, h, icon } from '../dom.js';
import { brand, describeAuthError, formatCountdown, messageBox, passphraseField, usernameField } from './common.js';

export function renderLock(app, { notice = null } = {}) {
  let busy = false;
  let timer = null;

  const field = passphraseField({ id: 'unlock-passphrase', label: 'パスフレーズ', autocomplete: 'current-password' });
  const error = messageBox();
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '解錠する');

  const stopWaiting = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  /** まちがいが続いたあとの待ち時間。終わるまで入力を止めて残り時間を出す。 */
  const startWaiting = (retryAt) => {
    stopWaiting();
    const tick = () => {
      const left = retryAt - Date.now();
      if (left <= 0) {
        stopWaiting();
        field.input.disabled = false;
        submit.disabled = false;
        submit.textContent = '解錠する';
        error.clear();
        return;
      }
      field.input.disabled = true;
      submit.disabled = true;
      submit.textContent = `あと ${formatCountdown(left)} で再試行できます`;
    };
    timer = setInterval(tick, 500);
    tick();
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const passphrase = field.input.value;
    if (passphrase === '') {
      error.show('パスフレーズを入力してください。');
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = '確認中…';
    error.clear();
    try {
      await app.vault.unlock(passphrase);
    } catch (failure) {
      busy = false;
      field.input.value = '';
      submit.disabled = false;
      submit.textContent = '解錠する';
      const message = describeAuthError(failure);
      if (message === null) {
        error.show('保存データを読み取れませんでした。データが壊れているか、このバージョンでは開けない形式です。');
      } else {
        error.show(message);
        if (failure.retryAt > 0) startWaiting(failure.retryAt);
        else field.input.focus();
      }
      return;
    }
    field.input.value = '';
    app.enter();
  };

  const forgot = async () => {
    // 解錠の計算中は受け付けない(解錠と消去が入れ違いにならないように)
    if (busy) return;
    const ok = await confirmDialog({
      title: 'パスフレーズを忘れた場合',
      message: [
        'パスフレーズは、この端末にも開発者にも保存されていません。そのため、忘れてしまうと記録を読む方法はありません。',
        'すべてのデータを消去して、最初からやり直すことはできます。暗号化バックアップとそのパスフレーズがあれば、消去のあとで復元できます。',
      ],
      confirmLabel: 'すべて消去する',
      danger: true,
      checkLabel: '消去したデータは元に戻せないことを理解しました',
    });
    if (ok && !busy) await app.wipe();
  };

  const node = h(
    'main',
    { class: 'auth auth-center' },
    brand(),
    notice === null ? null : h('p', { class: 'message is-info' }, icon('lock', { size: 18 }), h('span', null, notice)),
    h(
      'form',
      { class: 'auth-form', novalidate: true, on: { submit: onSubmit } },
      usernameField(),
      field.node,
      error.node,
      submit,
    ),
    h('button', { class: 'btn-link', type: 'button', on: { click: forgot } }, 'パスフレーズを忘れた場合'),
  );

  app.vault.throttleState().then(
    ({ retryAt }) => {
      if (retryAt > 0 && node.isConnected) {
        error.show('まちがいが続いたため、しばらく試せません。');
        startWaiting(retryAt);
      }
    },
    () => {},
  );

  return {
    node,
    cleanup: stopWaiting,
    focus: () => field.input.focus({ preventScroll: true }),
  };
}
