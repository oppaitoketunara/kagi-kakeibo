// かぎ家計簿 — 記録の追加・編集シート

import { confirmDialog, h, icon, openDialog, toast } from '../dom.js';
import { groupAmountInput } from '../format.js';
import {
  LIMITS,
  addTransaction,
  daysInMonth,
  deleteTransaction,
  monthOf,
  todayString,
  updateTransaction,
} from '../model.js';
import { messageBox, segmented } from './common.js';

/** 新しい記録の日付の初期値。今月なら今日、過去の月ならその月の末日、先の月なら 1 日。 */
function defaultDate(month) {
  const today = todayString();
  if (month === monthOf(today)) return today;
  if (month > monthOf(today)) return `${month}-01`;
  const [year, value] = month.split('-').map(Number);
  return `${month}-${String(daysInMonth(year, value)).padStart(2, '0')}`;
}

export function openEntry(app, existing = null) {
  const state = app.state;
  const draft = { type: existing === null ? 'expense' : existing.type, categoryId: existing === null ? null : existing.categoryId };
  // 支出・収入を切り替えても、それぞれで選んだカテゴリを覚えておく
  const chosen = { expense: null, income: null };
  chosen[draft.type] = draft.categoryId;
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
              class: 'chip',
              type: 'button',
              on: {
                click: () => {
                  draft.categoryId = category.id;
                  chosen[draft.type] = category.id;
                  markChosen();
                },
              },
            },
            h('span', { class: 'badge', 'aria-hidden': 'true' }, category.mark),
            h('span', { class: 'chip-label' }, category.name),
          ),
        }));
        chips.replaceChildren(...chipButtons.map((item) => item.button));
        markChosen();
      };
      renderChips();

      const save = h('button', { class: 'btn btn-primary btn-small', type: 'submit' }, '保存');
      const body = h('div', { class: 'sheet-body' });

      const finish = async (message) => {
        busy = true;
        save.disabled = true;
        const saved = await app.commit();
        close(true);
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
        };
        const result = existing === null ? addTransaction(state, input) : updateTransaction(state, existing.id, input);
        if (!result.ok) {
          error.show(Object.values(result.errors)[0]);
          body.scrollTop = 0;
          return;
        }
        // 保存した記録が見える月に合わせる
        app.month = monthOf(result.value.date);
        await finish(existing === null ? '記録しました。' : '記録を更新しました。');
      };

      const onDelete = async () => {
        if (busy || app.state !== state) return;
        const ok = await confirmDialog({
          title: 'この記録を削除しますか?',
          message: '削除すると元に戻せません。',
          confirmLabel: '削除する',
          danger: true,
        });
        if (!ok || busy || app.state !== state) return;
        deleteTransaction(state, existing.id);
        await finish('記録を削除しました。');
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
