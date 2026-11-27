// かぎ家計簿 — 記録の追加・編集シート

import { confirmDialog, h, icon, openDialog, toast } from '../dom.js';
import { groupAmountInput } from '../format.js';
import { ImageError, drawReceipt, prepareReceiptImage } from '../image.js';
import {
  LIMITS,
  addTransaction,
  checkTransaction,
  daysInMonth,
  deleteTransaction,
  monthOf,
  newId,
  todayString,
  updateTransaction,
} from '../model.js';
import { categoryBadge, hueClass, messageBox, segmented } from './common.js';

/** 新しい記録の日付の初期値。今月なら今日、過去の月ならその月の末日、先の月なら 1 日。 */
function defaultDate(month) {
  const today = todayString();
  if (month === monthOf(today)) return today;
  if (month > monthOf(today)) return `${month}-01`;
  const [year, value] = month.split('-').map(Number);
  return `${month}-${String(daysInMonth(year, value)).padStart(2, '0')}`;
}

/** レシートの写真を大きく表示する。 */
function openReceiptViewer(bytes) {
  openDialog(
    (close) => {
      const canvas = h('canvas', { class: 'receipt-full', role: 'img', 'aria-label': 'レシートの写真' });
      const frame = h('div', { class: 'receipt-frame' }, canvas);
      drawReceipt(canvas, bytes).catch(() => close(null));
      const zoom = h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-label': '拡大する',
          'aria-pressed': 'false',
          on: {
            click: () => {
              const zoomed = frame.classList.toggle('is-zoomed');
              zoom.setAttribute('aria-pressed', String(zoomed));
            },
          },
        },
        icon('zoom'),
      );
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
          h('h2', { class: 'sheet-title' }, 'レシート'),
          zoom,
        ),
        frame,
      );
    },
    { className: 'dialog sheet', backdropClose: true },
  );
}

export function openEntry(app, existing = null) {
  const state = app.state;
  const draft = { type: existing === null ? 'expense' : existing.type, categoryId: existing === null ? null : existing.categoryId };
  // 支出・収入を切り替えても、それぞれで選んだカテゴリを覚えておく
  const chosen = { expense: null, income: null };
  chosen[draft.type] = draft.categoryId;
  // レシート写真: saved = 保存済みのもの、fresh = いま選んだ(まだ保存していない)もの
  const receipt = { savedId: existing === null ? null : existing.receiptId, bytes: null, fresh: false, removed: false };
  let busy = false;
  let amountInput = null;

  openDialog(
    (close) => {
      const error = messageBox();

      const amount = h('input', {
        class: 'amount-input',
        id: 'entry-amount',
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        enterkeyhint: 'done',
        placeholder: '0',
        'aria-label': '金額(円)',
        value: existing === null ? '' : groupAmountInput(String(existing.amount)),
      });
      const reformat = () => {
        const formatted = groupAmountInput(amount.value);
        if (formatted !== amount.value) amount.value = formatted;
      };
      amount.addEventListener('input', (event) => {
        if (!event.isComposing) reformat();
      });
      amount.addEventListener('compositionend', reformat);
      amountInput = amount;

      const date = h('input', {
        class: 'input',
        id: 'entry-date',
        type: 'date',
        min: `${LIMITS.yearMin}-01-01`,
        max: `${LIMITS.yearMax}-12-31`,
        required: true,
        value: existing === null ? defaultDate(app.month) : existing.date,
      });

      const memo = h('input', {
        class: 'input',
        id: 'entry-memo',
        type: 'text',
        maxlength: String(LIMITS.memoMax),
        // ブラウザの入力履歴やオンラインのスペルチェックに内容を渡さない
        autocomplete: 'off',
        spellcheck: 'false',
        enterkeyhint: 'done',
        placeholder: '例: スーパー、ランチ',
        value: existing === null ? '' : existing.memo,
      });

      // --- カテゴリ
      const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'カテゴリ' });
      let chipButtons = [];
      const markChosen = () => {
        for (const { id, button } of chipButtons) button.setAttribute('aria-pressed', String(id === draft.categoryId));
      };
      const renderChips = () => {
        const options = state.categories.filter(
          (category) =>
            category.type === draft.type && (!category.archived || (existing !== null && category.id === existing.categoryId)),
        );
        chipButtons = options.map((category) => ({
          id: category.id,
          button: h(
            'button',
            {
              class: `chip ${hueClass(category)}`,
              type: 'button',
              on: {
                click: () => {
                  draft.categoryId = category.id;
                  chosen[draft.type] = category.id;
                  markChosen();
                },
              },
            },
            categoryBadge(category),
            h('span', { class: 'chip-label' }, category.name),
          ),
        }));
        chips.replaceChildren(...chipButtons.map((item) => item.button));
        markChosen();
      };
      renderChips();

      // --- レシート写真
      const thumb = h('canvas', { class: 'receipt-thumb', role: 'img', 'aria-label': 'レシートの写真(タップで拡大)' });
      const thumbButton = h(
        'button',
        {
          class: 'receipt-thumb-btn',
          type: 'button',
          hidden: true,
          on: {
            click: () => {
              if (receipt.bytes !== null) openReceiptViewer(receipt.bytes);
            },
          },
        },
        thumb,
      );
      const receiptNote = h('p', { class: 'field-hint' }, '');
      const removeButton = h(
        'button',
        {
          class: 'btn btn-secondary btn-small',
          type: 'button',
          hidden: true,
          on: {
            click: () => {
              receipt.bytes = null;
              receipt.fresh = false;
              receipt.removed = true;
              showReceipt();
            },
          },
        },
        icon('trash', { size: 18 }),
        '写真を外す',
      );
      const showReceipt = () => {
        const has = receipt.bytes !== null;
        thumbButton.hidden = !has;
        removeButton.hidden = !has;
        if (has) {
          receiptNote.textContent = '';
          drawReceipt(thumb, receipt.bytes).catch(() => {
            thumbButton.hidden = true;
            receiptNote.textContent = '写真を表示できませんでした。';
          });
        }
      };
      const onPicked = async (input) => {
        app.endExternal();
        const file = input.files && input.files.length > 0 ? input.files[0] : null;
        input.value = '';
        if (file === null || app.state !== state) return;
        receiptNote.textContent = '写真を取り込んでいます…';
        try {
          receipt.bytes = await prepareReceiptImage(file);
          receipt.fresh = true;
          receipt.removed = false;
          showReceipt();
        } catch (failure) {
          receiptNote.textContent = failure instanceof ImageError ? failure.message : '写真を取り込めませんでした。';
        }
      };
      const picker = (capture) => {
        const input = h('input', {
          class: 'visually-hidden',
          type: 'file',
          accept: 'image/*',
          capture: capture ? 'environment' : null,
          tabindex: '-1',
          'aria-hidden': 'true',
        });
        input.addEventListener('change', () => onPicked(input));
        input.addEventListener('cancel', () => app.endExternal());
        return input;
      };
      const cameraInput = picker(true);
      const libraryInput = picker(false);
      const openPicker = (input) => {
        // カメラや写真の選択画面に切り替わるあいだは、「離れたらすぐロック」を一時的に猶予する
        app.beginExternal();
        input.click();
      };
      if (receipt.savedId !== null) {
        receiptNote.textContent = '写真を読み込んでいます…';
        app.vault.getReceipt(receipt.savedId).then(
          (bytes) => {
            if (receipt.fresh || receipt.removed) return;
            if (bytes === null) {
              receiptNote.textContent = 'この記録の写真は、この端末にはありません(写真はバックアップに含まれません)。';
              return;
            }
            receipt.bytes = bytes;
            showReceipt();
          },
          () => {
            receiptNote.textContent = '写真を読み込めませんでした。';
          },
        );
      }

      const save = h('button', { class: 'btn btn-primary btn-small', type: 'submit' }, '保存');
      const body = h('div', { class: 'sheet-body' });

      /** 記録を保存して閉じる。`obsoleteReceipt` は、もう使わなくなった写真の ID。 */
      const finish = async (message, obsoleteReceipt) => {
        busy = true;
        save.disabled = true;
        const saved = await app.commit();
        close(true);
        // 記録の保存が済んでから、使わなくなった写真を消す(先に消すと、保存に失敗したとき写真だけ失う)
        if (saved && obsoleteReceipt !== null) app.vault.deleteReceipt(obsoleteReceipt).catch(() => {});
        if (!app.vault.isUnlocked) return;
        app.render();
        if (saved) toast(message);
      };

      const onSubmit = async (event) => {
        event.preventDefault();
        if (busy || app.state !== state) return;
        const input = {
          type: draft.type,
          amount: amount.value,
          date: date.value,
          categoryId: draft.categoryId,
          memo: memo.value,
          receiptId: receipt.removed ? null : receipt.savedId,
        };
        const checked = checkTransaction(state, input);
        if (!checked.ok) {
          error.show(Object.values(checked.errors)[0]);
          body.scrollTop = 0;
          return;
        }
        busy = true;
        save.disabled = true;
        let obsolete = receipt.removed ? receipt.savedId : null;
        if (receipt.fresh && receipt.bytes !== null) {
          // 新しい写真は、記録より先に暗号化して保存する
          const id = newId();
          try {
            await app.vault.putReceipt(id, receipt.bytes);
          } catch {
            busy = false;
            save.disabled = false;
            if (app.state === state) {
              error.show('写真を保存できませんでした。端末の空き容量を確認してください。');
              body.scrollTop = 0;
            }
            return;
          }
          if (app.state !== state) return;
          obsolete = receipt.savedId;
          input.receiptId = id;
        }
        const result = existing === null ? addTransaction(state, input) : updateTransaction(state, existing.id, input);
        if (!result.ok) {
          busy = false;
          save.disabled = false;
          error.show(Object.values(result.errors)[0]);
          body.scrollTop = 0;
          return;
        }
        // 保存した記録が見える月に合わせる
        app.month = monthOf(result.value.date);
        await finish(existing === null ? '記録しました。' : '記録を更新しました。', obsolete);
      };

      const onDelete = async () => {
        if (busy || app.state !== state) return;
        const ok = await confirmDialog({
          title: 'この記録を削除しますか?',
          message: existing.receiptId === null ? '削除すると元に戻せません。' : '削除すると元に戻せません。レシートの写真も一緒に消えます。',
          confirmLabel: '削除する',
          danger: true,
        });
        if (!ok || busy || app.state !== state) return;
        deleteTransaction(state, existing.id);
        await finish('記録を削除しました。', existing.receiptId);
      };

      body.append(
        error.node,
        segmented({
          label: '支出か収入か',
          options: [
            { value: 'expense', label: '支出' },
            { value: 'income', label: '収入' },
          ],
          value: draft.type,
          onChange: (next) => {
            draft.type = next;
            draft.categoryId = chosen[next];
            renderChips();
          },
        }),
        h('div', { class: 'amount-field' }, h('label', { class: 'amount-prefix', for: 'entry-amount' }, '¥'), amount),
        h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'カテゴリ'), chips),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'entry-date' }, '日付'), date),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'entry-memo' }, 'メモ(なくてもかまいません)'), memo),
        h(
          'div',
          { class: 'field' },
          h('p', { class: 'field-label' }, 'レシートの写真(なくてもかまいません)'),
          thumbButton,
          h(
            'div',
            { class: 'receipt-actions' },
            h(
              'button',
              { class: 'btn btn-secondary btn-small', type: 'button', on: { click: () => openPicker(cameraInput) } },
              icon('camera', { size: 18 }),
              '撮影する',
            ),
            h(
              'button',
              { class: 'btn btn-secondary btn-small', type: 'button', on: { click: () => openPicker(libraryInput) } },
              icon('image', { size: 18 }),
              '写真から選ぶ',
            ),
            removeButton,
          ),
          receiptNote,
          cameraInput,
          libraryInput,
        ),
      );
      if (existing !== null) {
        body.append(
          h(
            'button',
            { class: 'btn btn-outline-danger btn-block', type: 'button', on: { click: onDelete } },
            icon('trash', { size: 20 }),
            'この記録を削除',
          ),
        );
      }

      return h(
        'form',
        { class: 'sheet-form', novalidate: true, on: { submit: onSubmit } },
        h(
          'header',
          { class: 'sheet-head' },
          h(
            'button',
            { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', on: { click: () => close(null) } },
            icon('close'),
          ),
          h('h2', { class: 'sheet-title' }, existing === null ? '記録を追加' : '記録を編集'),
          save,
        ),
        body,
      );
    },
    { className: 'dialog sheet' },
  );

  // 新しい記録は、すぐ金額を打てるようにする
  if (existing === null && amountInput !== null) amountInput.focus();
}
