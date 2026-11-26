// かぎ家計簿 — ホーム(その月のまとめと記録の一覧)

import { h, icon } from '../dom.js';
import { formatDay, formatMonth, formatPercent } from '../format.js';
import { budgetStatus, currentMonth, summarizeMonth } from '../model.js';
import { monthSwitcher, transactionRow } from './common.js';
import { openEntry } from './entry.js';

const BACKUP_REMINDER_MIN_RECORDS = 10;
const BACKUP_REMINDER_DAYS = 30;

/** 予算に対する使用状況のメーター。色だけに頼らず、アイコンと文でも状態を伝える。 */
function budgetMeter(app, status) {
  const fill = h('span', { class: 'meter-fill' });
  fill.style.width = `${Math.min(100, status.ratio * 100)}%`;
  const used = `予算 ${app.money(status.budget)} の ${formatPercent(status.ratio)}`;
  let note = `残り ${app.money(status.remaining)}`;
  if (status.level === 'over') note = `${app.money(-status.remaining)} 超えています`;
  else if (status.level === 'warning') note = `残り ${app.money(status.remaining)}(残りわずか)`;
  return h(
    'div',
    { class: `meter meter-${status.level}` },
    h('div', { class: 'meter-track', role: 'img', 'aria-label': `${used}。${note}` }, fill),
    h(
      'div',
      { class: 'meter-text' },
      h('span', null, used),
      h('span', { class: 'meter-note' }, status.level === 'normal' ? null : icon('alert', { size: 16 }), note),
    ),
  );
}

function needsBackupReminder(state) {
  if (state.transactions.length < BACKUP_REMINDER_MIN_RECORDS) return false;
  const last = state.settings.lastBackupAt;
  if (last === null) return true;
  return Date.now() - Date.parse(last) > BACKUP_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}

function dayTotals(app, day) {
  const parts = [];
  if (day.income > 0) parts.push(`収入 ${app.money(day.income)}`);
  if (day.expense > 0) parts.push(`支出 ${app.money(day.expense)}`);
  return parts.join(' / ');
}

export function renderHome(app) {
  const state = app.state;
  const masked = state.settings.maskAmounts;
  const summary = summarizeMonth(state, app.month);
  const budget = budgetStatus(state.settings.monthlyBudget, summary.expense);
  const monthNumber = Number(app.month.slice(5));

  const header = h(
    'header',
    { class: 'topbar' },
    monthSwitcher(app),
    h(
      'div',
      { class: 'topbar-actions' },
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-label': '金額を隠す',
          'aria-pressed': String(masked),
          dataset: { focusKey: 'mask' },
          on: { click: () => app.toggleMask() },
        },
        icon(masked ? 'eye-off' : 'eye'),
      ),
      h(
        'button',
        { class: 'icon-btn', type: 'button', 'aria-label': '今すぐロックする', on: { click: () => app.lock() } },
        icon('lock'),
      ),
    ),
  );

  let balanceClass = null;
  if (!masked && summary.balance > 0) balanceClass = 'pos';
  if (!masked && summary.balance < 0) balanceClass = 'neg';

  const main = h(
    'main',
    { class: 'content' },
    h(
      'section',
      { class: 'card summary', 'aria-label': `${formatMonth(app.month)}のまとめ` },
      h('p', { class: 'eyebrow' }, app.month === currentMonth() ? '今月の支出' : `${monthNumber}月の支出`),
      h('p', { class: 'hero' }, app.money(summary.expense)),
      h(
        'dl',
        { class: 'stats' },
        h('div', { class: 'stat' }, h('dt', null, '収入'), h('dd', null, app.money(summary.income))),
        h(
          'div',
          { class: 'stat' },
          h('dt', null, '収支'),
          h('dd', { class: balanceClass }, app.money(summary.balance, { signed: true })),
        ),
      ),
      budget === null ? null : budgetMeter(app, budget),
    ),
  );

  if (needsBackupReminder(state)) {
    main.append(
      h(
        'button',
        { class: 'notice-row', type: 'button', on: { click: () => app.navigate('settings') } },
        icon('info', { size: 20 }),
        h(
          'span',
          null,
          state.settings.lastBackupAt === null
            ? 'まだバックアップがありません。端末の故障に備えて、設定から書き出しておきましょう。'
            : `最後のバックアップから ${BACKUP_REMINDER_DAYS} 日以上たっています。設定から書き出せます。`,
        ),
        icon('chevron-right', { size: 20 }),
      ),
    );
  }

  if (summary.days.length === 0) {
    main.append(
      h(
        'div',
        { class: 'empty' },
        h('p', { class: 'empty-title' }, 'この月の記録はまだありません'),
        h('p', { class: 'empty-text' }, '右下の + ボタンから記録を追加できます。'),
      ),
    );
  }

  for (const day of summary.days) {
    main.append(
      h(
        'section',
        { class: 'day' },
        h(
          'h2',
          { class: 'day-head' },
          h('span', null, formatDay(day.date)),
          h('span', { class: 'day-total' }, dayTotals(app, day)),
        ),
        h(
          'ul',
          { class: 'rows card' },
          day.items.map((item) => h('li', null, transactionRow(app, item, () => openEntry(app, item)))),
        ),
      ),
    );
  }

  return { header, main };
}
