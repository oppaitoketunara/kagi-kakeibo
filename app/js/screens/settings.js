// かぎ家計簿 — 設定

import { confirmDialog, h, icon, openDialog, toast } from '../dom.js';
import { KDF_ITERATIONS } from '../crypto.js';
import { formatDateTime } from '../format.js';
import {
  AUTO_LOCK_CHOICES,
  LIMITS,
  addCategory,
  categoryUsage,
  deleteCategory,
  markBackedUp,
  renameCategory,
  setAutoLock,
  setCategoryArchived,
  setMaskAmounts,
  setMonthlyBudget,
  toCsv,
  todayString,
} from '../model.js';
import { MIN_LENGTH, assessPassphrase } from '../passphrase.js';
import { ConflictError } from '../vault.js';
import { APP_VERSION } from '../version.js';
import {
  describeAuthError,
  installHint,
  messageBox,
  paragraphs,
  passphraseField,
  segmented,
  strengthMeter,
  usernameField,
} from './common.js';
import { confirmWithPassphrase, offerFile, openRestore } from './dialogs.js';

const AUTO_LOCK_LABELS = { 0: 'アプリを離れたらすぐ', 30: '離れて 30 秒後', 60: '離れて 1 分後', 300: '離れて 5 分後' };

function section(title, ...children) {
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, title), h('div', { class: 'card list' }, children));
}

function actionRow({ title, description = null, iconName = 'chevron-right', danger = false, onClick }) {
  return h(
    'button',
    { class: danger ? 'list-row list-action is-danger' : 'list-row list-action', type: 'button', on: { click: onClick } },
    h(
      'span',
      { class: 'list-main' },
      h('span', { class: 'list-title' }, title),
      description === null ? null : h('span', { class: 'list-desc' }, description),
    ),
    icon(iconName, { size: 20 }),
  );
}

function infoRow(title, value) {
  return h('div', { class: 'list-row' }, h('span', { class: 'list-title' }, title), h('span', { class: 'list-value' }, value));
}

function formatBudget(value) {
  return value === null ? '' : value.toLocaleString('ja-JP');
}

// ---------------------------------------------------------------------------
// 書き出し・消去
// ---------------------------------------------------------------------------

async function exportBackup(app) {
  let text;
  try {
    text = await app.vault.exportBackup();
  } catch {
    toast('バックアップを作れませんでした。', { kind: 'error' });
    return;
  }
  const saved = await offerFile(app, {
    title: '暗号化バックアップ',
    message: [
      'すべての記録を、暗号化したまま 1 つのファイルに書き出します。',
      '復元には、いまのパスフレーズが必要です。あとでパスフレーズを変えても、このファイルは変える前のパスフレーズで開きます。',
      '端末の故障や機種変更に備えて、この端末の外に保管してください。',
    ],
    filename: `kagi-kakeibo-backup-${todayString()}.json`,
    mime: 'application/json',
    text,
  });
  if (!saved || !app.vault.isUnlocked) return;
  markBackedUp(app.state);
  await app.commit();
  app.render();
  toast('バックアップを書き出しました。');
}

async function exportCsv(app) {
  const proceed = await confirmDialog({
    title: 'CSV は暗号化されません',
    message: [
      'CSV ファイルには、すべての記録がそのまま読める形で入ります。ファイルを開ける人なら誰でも内容を読めます。',
      '表計算ソフトで集計したいときなど、必要な場合にだけ使い、用が済んだら削除してください。',
    ],
    confirmLabel: '続ける',
    danger: true,
  });
  if (!proceed || !app.vault.isUnlocked) return;
  const verified = await confirmWithPassphrase(app, {
    title: 'パスフレーズの確認',
    message: '記録をまとめて書き出す前に、パスフレーズをもう一度入力してください。',
  });
  if (!verified || !app.vault.isUnlocked) return;
  await offerFile(app, {
    title: 'CSV ファイル',
    warning: 'このファイルは暗号化されていません。',
    message: '保存する場所と、共有する相手に注意してください。',
    filename: `kagi-kakeibo-${todayString()}.csv`,
    mime: 'text/csv',
    text: toCsv(app.state),
  });
}

async function wipeAll(app) {
  const ok = await confirmDialog({
    title: 'すべてのデータを消去',
    message: [
      'この端末に保存されている記録と設定を、すべて消去します。',
      '暗号化バックアップを書き出していない記録は、二度と取り戻せません。',
    ],
    confirmLabel: 'すべて消去する',
    danger: true,
    checkLabel: '消去したデータは元に戻せないことを理解しました',
  });
  if (ok) await app.wipe();
}

// ---------------------------------------------------------------------------
// パスフレーズの変更
// ---------------------------------------------------------------------------

function openChangePassphrase(app) {
  openDialog((close, guard) => {
    const current = passphraseField({ id: 'current-passphrase', label: '現在のパスフレーズ', autocomplete: 'current-password' });
    const next = passphraseField({
      id: 'next-passphrase',
      label: '新しいパスフレーズ',
      autocomplete: 'new-password',
      hint: `${MIN_LENGTH} 文字以上。`,
    });
    const again = passphraseField({ id: 'next-passphrase-confirm', label: '新しいパスフレーズ(もう一度)', autocomplete: 'new-password' });
    const meter = strengthMeter();
    next.input.addEventListener('input', () => meter.update(next.input.value));
    const error = messageBox();
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, '変更する');
    const cancel = h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, 'キャンセル');
    let busy = false;
    // 変更の処理は途中で取り消せない。始まったら、結果が出るまでダイアログを閉じられないようにする。
    const setBusy = (value) => {
      busy = value;
      guard.busy = value;
      submit.disabled = value;
      cancel.disabled = value;
      submit.textContent = value ? '変更中…' : '変更する';
    };

    const onSubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      const currentValue = current.input.value;
      const nextValue = next.input.value;
      if (currentValue === '') {
        error.show('現在のパスフレーズを入力してください。');
        return;
      }
      const assessment = assessPassphrase(nextValue);
      if (!assessment.ok) {
        error.show(assessment.problems[0]);
        return;
      }
      if (nextValue.normalize('NFKC') !== again.input.value.normalize('NFKC')) {
        error.show('新しいパスフレーズが一致しません。');
        return;
      }
      if (nextValue.normalize('NFKC') === currentValue.normalize('NFKC')) {
        error.show('現在と同じパスフレーズです。');
        return;
      }
      setBusy(true);
      error.clear();
      try {
        await app.vault.changePassphrase(currentValue, nextValue);
      } catch (failure) {
        setBusy(false);
        if (!app.vault.isUnlocked) {
          // 処理の途中でロックされた。どちらのパスフレーズが有効かを、ロック画面で必ず伝える。
          app.showLock('パスフレーズは変更されていません。これまでのパスフレーズで解錠してください。');
          return;
        }
        if (failure instanceof ConflictError) {
          app.lock('ほかのタブでデータが変更されたため、ロックしました。パスフレーズは変更されていません。');
          return;
        }
        current.input.value = '';
        error.show(describeAuthError(failure, '現在のパスフレーズ') ?? '変更できませんでした。もう一度お試しください。');
        return;
      }
      setBusy(false);
      if (!app.vault.isUnlocked) {
        app.showLock('パスフレーズを変更しました。新しいパスフレーズで解錠してください。');
        return;
      }
      close(true);
      toast('パスフレーズを変更しました。');
    };

    return h(
      'form',
      { class: 'dialog-body', novalidate: true, on: { submit: onSubmit } },
      h('h2', { class: 'dialog-title' }, 'パスフレーズを変更'),
      paragraphs([
        '新しい鍵を作り、すべての記録を暗号化し直します。',
        '以前に書き出したバックアップは、以前のパスフレーズのままです。変更後に、新しいバックアップを書き出しておくことをおすすめします。',
      ]),
      usernameField(),
      current.node,
      next.node,
      meter.node,
      again.node,
      error.node,
      h('div', { class: 'dialog-actions' }, cancel, submit),
    );
  });
}

// ---------------------------------------------------------------------------
// カテゴリの編集
// ---------------------------------------------------------------------------

function editCategory(app, category, onChanged) {
  openDialog(
    (close) => {
      const used = categoryUsage(app.state, category.id);
      const input = h('input', {
        class: 'input',
        id: 'category-name',
        type: 'text',
        maxlength: String(LIMITS.categoryNameMax),
        autocomplete: 'off',
        spellcheck: 'false',
        value: category.name,
      });
      const error = messageBox();
      const apply = async (result) => {
        if (!result.ok) {
          error.show(result.error);
          return;
        }
        close(true);
        onChanged();
        await app.commit();
      };
      return h(
        'form',
        {
          class: 'dialog-body',
          novalidate: true,
          on: {
            submit: (event) => {
              event.preventDefault();
              if (app.vault.isUnlocked) apply(renameCategory(app.state, category.id, input.value));
            },
          },
        },
        h('h2', { class: 'dialog-title' }, 'カテゴリを編集'),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'category-name' }, '名前'), input),
        h('p', { class: 'dialog-text' }, used > 0 ? `${used} 件の記録で使われています。` : 'まだ記録では使われていません。'),
        error.node,
        h(
          'div',
          { class: 'dialog-actions is-stacked' },
          h('button', { class: 'btn btn-primary', type: 'submit' }, '名前を保存'),
          h(
            'button',
            {
              class: 'btn btn-secondary',
              type: 'button',
              on: {
                click: () => {
                  if (app.vault.isUnlocked) apply(setCategoryArchived(app.state, category.id, !category.archived));
                },
              },
            },
            category.archived ? '入力画面に表示する' : '入力画面から隠す',
          ),
          used > 0
            ? null
            : h(
                'button',
                {
                  class: 'btn btn-outline-danger',
                  type: 'button',
                  on: {
                    click: () => {
                      if (app.vault.isUnlocked) apply(deleteCategory(app.state, category.id));
                    },
                  },
                },
                '削除する',
              ),
          h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => close(false) } }, 'キャンセル'),
        ),
      );
    },
    { backdropClose: true },
  );
}

function openCategoryEditor(app) {
  let type = 'expense';
  openDialog(
    (close) => {
      const list = h('ul', { class: 'rows card' });
      const error = messageBox();
      const nameInput = h('input', {
        class: 'input',
        id: 'new-category',
        type: 'text',
        maxlength: String(LIMITS.categoryNameMax),
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: '例: ペット',
      });

      const refresh = () => {
        if (!app.vault.isUnlocked) return;
        list.replaceChildren(
          ...app.state.categories
            .filter((category) => category.type === type)
            .map((category) =>
              h(
                'li',
                null,
                h(
                  'button',
                  { class: 'row row-button', type: 'button', on: { click: () => editCategory(app, category, refresh) } },
                  h('span', { class: 'badge', 'aria-hidden': 'true' }, category.mark),
                  h(
                    'span',
                    { class: 'row-main' },
                    h('span', { class: 'row-title' }, category.name),
                    category.archived ? h('span', { class: 'row-memo' }, '入力画面には出ません') : null,
                  ),
                  icon('chevron-right', { size: 20 }),
                ),
              ),
            ),
        );
      };

      const onAdd = async (event) => {
        event.preventDefault();
        if (!app.vault.isUnlocked) return;
        const result = addCategory(app.state, type, nameInput.value);
        if (!result.ok) {
          error.show(result.error);
          return;
        }
        error.clear();
        nameInput.value = '';
        refresh();
        await app.commit();
      };

      refresh();
      return h(
        'div',
        { class: 'sheet-form' },
        h(
          'header',
          { class: 'sheet-head' },
          h(
            'button',
            { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', on: { click: () => close(null) } },
            icon('close'),
          ),
          h('h2', { class: 'sheet-title' }, 'カテゴリ'),
          h('span', { class: 'sheet-spacer' }),
        ),
        h(
          'div',
          { class: 'sheet-body' },
          segmented({
            label: 'カテゴリの種類',
            options: [
              { value: 'expense', label: '支出' },
              { value: 'income', label: '収入' },
            ],
            value: type,
            onChange: (next) => {
              type = next;
              error.clear();
              refresh();
            },
          }),
          list,
          h(
            'form',
            { class: 'inline-form', novalidate: true, on: { submit: onAdd } },
            h('label', { class: 'field-label', for: 'new-category' }, 'カテゴリを追加'),
            h('div', { class: 'inline-row' }, nameInput, h('button', { class: 'btn btn-secondary', type: 'submit' }, '追加')),
            error.node,
          ),
        ),
      );
    },
    { className: 'dialog sheet' },
  );
}

// ---------------------------------------------------------------------------
// 設定画面
// ---------------------------------------------------------------------------

export function renderSettings(app) {
  const state = app.state;
  const settings = state.settings;

  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', { class: 'topbar-title' }, '設定'),
    h(
      'div',
      { class: 'topbar-actions' },
      h(
        'button',
        { class: 'icon-btn', type: 'button', 'aria-label': '今すぐロックする', on: { click: () => app.lock() } },
        icon('lock'),
      ),
    ),
  );

  // --- セキュリティ ---
  const autoLock = h(
    'select',
    {
      class: 'select',
      id: 'auto-lock',
      on: {
        change: async () => {
          if (!setAutoLock(app.state, Number(autoLock.value))) return;
          if (await app.commit()) toast('自動ロックの設定を変更しました。');
        },
      },
    },
    AUTO_LOCK_CHOICES.map((seconds) => h('option', { value: String(seconds) }, AUTO_LOCK_LABELS[seconds])),
  );
  autoLock.value = String(settings.autoLockSec);

  const mask = h('input', {
    class: 'switch',
    type: 'checkbox',
    role: 'switch',
    id: 'mask-amounts',
    checked: settings.maskAmounts,
    on: {
      change: async () => {
        setMaskAmounts(app.state, mask.checked);
        await app.commit();
      },
    },
  });

  // --- 予算 ---
  const budgetInput = h('input', {
    class: 'input',
    id: 'budget',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: '設定なし',
    value: formatBudget(settings.monthlyBudget),
  });
  const budgetError = messageBox();
  const onBudgetSubmit = async (event) => {
    event.preventDefault();
    const result = setMonthlyBudget(app.state, budgetInput.value);
    if (!result.ok) {
      budgetError.show(result.error);
      return;
    }
    budgetError.clear();
    budgetInput.value = formatBudget(result.value);
    if (await app.commit()) toast(result.value === null ? '予算を外しました。' : '予算を保存しました。');
  };

  // --- バックアップ ---
  const persisted = h('span', { class: 'list-value' }, '確認中…');
  if (navigator.storage && typeof navigator.storage.persisted === 'function') {
    navigator.storage.persisted().then(
      (granted) => {
        persisted.textContent = granted ? '有効' : '未許可';
        persisted.className = granted ? 'list-value is-good' : 'list-value is-warn';
      },
      () => {
        persisted.textContent = '不明';
      },
    );
  } else {
    persisted.textContent = '不明';
  }

  const offline = 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;

  const main = h(
    'main',
    { class: 'content' },
    section(
      'セキュリティ',
      h(
        'div',
        { class: 'list-row is-column' },
        h('label', { class: 'list-title', for: 'auto-lock' }, '自動ロック'),
        autoLock,
        h('p', { class: 'list-desc' }, '開いたままでも、操作がない状態が 3 分続くとロックします。'),
      ),
      h(
        'label',
        { class: 'list-row', for: 'mask-amounts' },
        h(
          'span',
          { class: 'list-main' },
          h('span', { class: 'list-title' }, '金額を隠す'),
          h('span', { class: 'list-desc' }, '人目のある場所で、金額を伏せ字にします。'),
        ),
        mask,
      ),
      actionRow({ title: 'パスフレーズを変更', onClick: () => openChangePassphrase(app) }),
      actionRow({ title: '今すぐロック', iconName: 'lock', onClick: () => app.lock() }),
    ),
    section(
      '予算とカテゴリ',
      h(
        'form',
        { class: 'list-row is-column', novalidate: true, on: { submit: onBudgetSubmit } },
        h('label', { class: 'list-title', for: 'budget' }, '1 か月の予算(円)'),
        h('div', { class: 'inline-row' }, budgetInput, h('button', { class: 'btn btn-secondary', type: 'submit' }, '保存')),
        h('p', { class: 'list-desc' }, '空欄で保存すると、予算なしになります。'),
        budgetError.node,
      ),
      actionRow({
        title: 'カテゴリを編集',
        description: '追加・名前の変更・入力画面からの非表示',
        onClick: () => openCategoryEditor(app),
      }),
    ),
    section(
      'バックアップ',
      infoRow('最後のバックアップ', settings.lastBackupAt === null ? 'まだありません' : formatDateTime(settings.lastBackupAt)),
      h(
        'div',
        { class: 'list-row' },
        h(
          'span',
          { class: 'list-main' },
          h('span', { class: 'list-title' }, '端末内での保護'),
          h('span', { class: 'list-desc' }, '有効なら、空き容量が減ってもブラウザに消されにくくなります。'),
        ),
        persisted,
      ),
      actionRow({
        title: '暗号化バックアップを書き出す',
        description: '暗号化したままのファイル。機種変更や故障に備えます。',
        iconName: 'download',
        onClick: () => exportBackup(app),
      }),
      actionRow({
        title: 'バックアップから復元',
        description: 'いまの記録を、バックアップの内容で置き換えます。',
        iconName: 'upload',
        onClick: () => openRestore(app, { mode: 'replace' }),
      }),
      actionRow({
        title: 'CSV で書き出す',
        description: '表計算ソフト用。暗号化されません。',
        iconName: 'table',
        onClick: () => exportCsv(app),
      }),
    ),
    section(
      'データの消去',
      actionRow({ title: 'すべてのデータを消去', iconName: 'trash', danger: true, onClick: () => wipeAll(app) }),
    ),
    section(
      'このアプリについて',
      infoRow('バージョン', APP_VERSION),
      infoRow('記録の件数', `${state.transactions.length.toLocaleString('ja-JP')} 件`),
      infoRow('暗号化', 'AES-256-GCM'),
      infoRow('鍵の導出', `PBKDF2-SHA-256・${(app.vault.kdfIterations ?? KDF_ITERATIONS) / 10000} 万回`),
      infoRow('通信', 'なし(記録は送信されません)'),
      infoRow('オフライン', offline ? '対応済み' : '未準備'),
    ),
  );
  const hint = installHint(app);
  if (hint !== null) main.append(hint);

  return { header, main };
}
