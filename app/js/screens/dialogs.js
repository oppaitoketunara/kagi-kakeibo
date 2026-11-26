// かぎ家計簿 — ファイルの書き出し・復元・パスフレーズの再確認

import { CorruptVaultError, UnsupportedVaultError, WrongPassphraseError } from '../crypto.js';
import { confirmDialog, h, icon, openDialog, toast } from '../dom.js';
import { InvalidStateError } from '../model.js';
import { ConflictError, readBackup } from '../vault.js';
import { describeAuthError, isTouchPrimary, messageBox, paragraphs, passphraseField } from './common.js';

const MAX_BACKUP_FILE_BYTES = 96 * 1024 * 1024;

/**
 * 文字列をファイルとして端末に渡す。
 * スマホでは共有シート(「ファイルに保存」など)、それ以外ではダウンロードを使う。
 * クリックの処理の中から、ほかの待ち合わせを挟まずに呼ぶこと(共有シートは利用者の操作の直後にしか開けない)。
 */
async function saveFile({ filename, mime, text }) {
  const blob = new Blob([text], { type: mime });
  if (isTouchPrimary() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') return false;
        // 共有できない環境だった。下のダウンロードに切り替える。
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** 用意できたファイルの説明と「保存」ボタンを出す。保存されたら true。 */
export function offerFile(app, { title, message, filename, mime, text, warning = null }) {
  const { closed } = openDialog((close) => {
    const save = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        on: {
          click: async () => {
            save.disabled = true;
            app.beginExternal();
            let saved = false;
            try {
              saved = await saveFile({ filename, mime, text });
            } finally {
              app.endExternal();
            }
            if (saved) close(true);
            else save.disabled = false;
          },
        },
      },
      icon('download', { size: 20 }),
      'ファイルを保存',
    );
    return h(
      'div',
      { class: 'dialog-body' },
      h('h2', { class: 'dialog-title' }, title),
      warning === null ? null : h('p', { class: 'message is-error' }, icon('alert', { size: 18 }), h('span', null, warning)),
      paragraphs(message),
      h('p', { class: 'file-name' }, filename),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, 'キャンセル'),
        save,
      ),
    );
  });
  return closed.then((value) => value === true);
}

/** 重要な操作の前に、もう一度パスフレーズを入力してもらう。確認できたら true。 */
export function confirmWithPassphrase(app, { title, message, confirmLabel = '確認する' }) {
  const { closed } = openDialog((close) => {
    const field = passphraseField({ id: 'confirm-passphrase', label: '現在のパスフレーズ', autocomplete: 'current-password' });
    const error = messageBox();
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel);
    let busy = false;
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
      error.clear();
      try {
        await app.vault.verifyPassphrase(passphrase);
      } catch (failure) {
        busy = false;
        submit.disabled = false;
        field.input.value = '';
        error.show(describeAuthError(failure) ?? '確認できませんでした。');
        return;
      }
      close(true);
    };
    return h(
      'form',
      { class: 'dialog-body', novalidate: true, on: { submit: onSubmit } },
      h('h2', { class: 'dialog-title' }, title),
      paragraphs(message),
      field.node,
      error.node,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, 'キャンセル'),
        submit,
      ),
    );
  });
  return closed.then((value) => value === true);
}

function describeBackupError(error) {
  if (error instanceof WrongPassphraseError) {
    return 'パスフレーズが違います。このバックアップを書き出したときのパスフレーズを入力してください。';
  }
  if (error instanceof UnsupportedVaultError) {
    return 'かぎ家計簿のバックアップではないか、このバージョンでは読み込めない形式です。';
  }
  if (error instanceof CorruptVaultError || error instanceof InvalidStateError) {
    return 'ファイルが壊れているため、読み込めませんでした。';
  }
  if (error instanceof ConflictError) return 'ほかのタブですでに保管庫が作られています。このページを読み込み直してください。';
  return 'ファイルを読み込めませんでした。';
}

/**
 * 暗号化バックアップから復元する。
 *   mode 'setup'   … まだ保管庫がない。バックアップのパスフレーズで新しい保管庫を作る。
 *   mode 'replace' … 解錠中。いまの記録を置き換える(パスフレーズはいまのまま)。
 */
export function openRestore(app, { mode }) {
  openDialog((close) => {
    let file = null;
    let busy = false;
    const fileName = h('p', { class: 'file-name' }, 'ファイルはまだ選ばれていません');
    const picker = h('input', {
      class: 'visually-hidden',
      type: 'file',
      accept: '.json,application/json',
      tabindex: '-1',
      'aria-hidden': 'true',
    });
    picker.addEventListener('change', () => {
      app.endExternal();
      file = picker.files && picker.files.length > 0 ? picker.files[0] : null;
      fileName.textContent = file === null ? 'ファイルはまだ選ばれていません' : file.name;
    });
    picker.addEventListener('cancel', () => app.endExternal());
    const choose = h(
      'button',
      {
        class: 'btn btn-secondary btn-block',
        type: 'button',
        on: {
          click: () => {
            app.beginExternal();
            picker.click();
          },
        },
      },
      icon('upload', { size: 20 }),
      'バックアップファイルを選ぶ',
    );
    const field = passphraseField({
      id: 'restore-passphrase',
      label: 'バックアップのパスフレーズ',
      autocomplete: 'current-password',
      hint: 'このバックアップを書き出したときに使っていたパスフレーズです。',
    });
    const error = messageBox();
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, '復元する');
    const reset = () => {
      busy = false;
      submit.disabled = false;
      submit.textContent = '復元する';
    };

    const onSubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      if (file === null) {
        error.show('バックアップファイルを選んでください。');
        return;
      }
      const passphrase = field.input.value;
      if (passphrase === '') {
        error.show('パスフレーズを入力してください。');
        return;
      }
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        error.show('ファイルが大きすぎます。かぎ家計簿のバックアップか確認してください。');
        return;
      }
      busy = true;
      submit.disabled = true;
      submit.textContent = '確認中…';
      error.clear();
      try {
        const restored = await readBackup(await file.text(), passphrase);
        if (mode === 'setup') {
          // 自動ロックの猶予はバックアップから引き継がず、いちばん安全な「すぐロック」から始める
          restored.settings.autoLockSec = 0;
          await app.vault.create(passphrase, restored);
          close(true);
          app.enter();
          toast('バックアップから復元しました。');
          return;
        }
        if (!app.vault.isUnlocked) return;
        const ok = await confirmDialog({
          title: 'いまの記録を置き換えます',
          message: [
            `いまの記録 ${app.state.transactions.length} 件を、バックアップの ${restored.transactions.length} 件で置き換えます。`,
            '置き換えたあと、いまの記録には戻せません。パスフレーズはいまのまま変わりません。',
          ],
          confirmLabel: '置き換える',
          danger: true,
        });
        if (!ok || !app.vault.isUnlocked) {
          reset();
          return;
        }
        // ロックや表示にかかわる設定は、バックアップの内容で勝手にゆるめない。いまの端末の設定を保つ。
        restored.settings.autoLockSec = app.state.settings.autoLockSec;
        restored.settings.maskAmounts = app.state.settings.maskAmounts;
        await app.vault.replaceState(restored);
        close(true);
        app.render();
        toast('バックアップから復元しました。');
      } catch (failure) {
        reset();
        if (mode === 'replace' && failure instanceof ConflictError) {
          close(false);
          app.lock('ほかのタブでデータが変更されたため、ロックしました。復元は行われていません。');
          return;
        }
        error.show(describeBackupError(failure));
      }
    };

    return h(
      'form',
      { class: 'dialog-body', novalidate: true, on: { submit: onSubmit } },
      h('h2', { class: 'dialog-title' }, 'バックアップから復元'),
      paragraphs(
        mode === 'setup'
          ? '暗号化バックアップのファイルと、そのパスフレーズが必要です。復元後は、そのパスフレーズで解錠します。'
          : '暗号化バックアップのファイルと、そのパスフレーズが必要です。',
      ),
      picker,
      choose,
      fileName,
      field.node,
      error.node,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, 'キャンセル'),
        submit,
      ),
    );
  });
}
