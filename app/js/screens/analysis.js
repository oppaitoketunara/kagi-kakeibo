// かぎ家計簿 — 分析(カテゴリ別の内訳と、月ごとの推移)
//
// グラフの方針
//   - カテゴリ別: 名前のある項目どうしの比較なので、大きい順の横棒。棒はそのカテゴリの色(入力画面や一覧のバッジと同じ色)。
//     色だけでは見分けにくい組み合わせもあるので、必ず頭文字のバッジと名前を並べる。
//   - 月ごとの推移: 見ている月だけを強調色、ほかの月は灰色。
//   - 数値は必ず文字でも読める(行の金額、棒の上のラベル、表)。色やホバーだけに頼らない。

import { h, icon, openDialog } from '../dom.js';
import { formatAxisYen, formatCompactYen, formatDay, formatMonth, formatPercent, niceScale } from '../format.js';
import { monthlyTotals, summarizeMonth, transactionsOfMonth } from '../model.js';
import { categoryBadge, hueClass, monthSwitcher, segmented } from './common.js';

const TYPE_LABEL = { expense: '支出', income: '収入' };
const TREND_MONTHS = 6;

function openCategorySheet(app, row) {
  const items = transactionsOfMonth(app.state, app.month).filter((item) => item.categoryId === row.category.id);
  openDialog(
    (close) =>
      h(
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
          h('h2', { class: 'sheet-title' }, `${row.category.name}・${formatMonth(app.month)}`),
          h('span', { class: 'sheet-spacer' }),
        ),
        h(
          'div',
          { class: 'sheet-body' },
          h('p', { class: 'sheet-summary' }, `${items.length} 件・合計 ${app.money(row.total)}`),
          h(
            'ul',
            { class: 'rows card' },
            items.map((item) =>
              h(
                'li',
                null,
                h(
                  'div',
                  { class: 'row' },
                  h(
                    'span',
                    { class: 'row-main' },
                    h('span', { class: 'row-title' }, formatDay(item.date)),
                    item.memo === '' ? null : h('span', { class: 'row-memo' }, item.memo),
                  ),
                  h('span', { class: 'row-amount' }, app.money(item.amount)),
                ),
              ),
            ),
          ),
        ),
      ),
    { className: 'dialog sheet', backdropClose: true },
  );
}

/** カテゴリ別の内訳。大きい順の横棒で、行そのものに金額と割合を文字で出す。 */
function rankedBars(app, rows) {
  const largest = rows[0].total;
  return h(
    'ol',
    { class: 'rank' },
    rows.map((row) => {
      const bar = h('span', { class: 'rank-bar' });
      bar.style.width = `${(row.total / largest) * 100}%`;
      return h(
        'li',
        null,
        h(
          'button',
          { class: `rank-row ${hueClass(row.category)}`, type: 'button', on: { click: () => openCategorySheet(app, row) } },
          categoryBadge(row.category),
          h(
            'span',
            { class: 'rank-main' },
            h(
              'span',
              { class: 'rank-top' },
              h('span', { class: 'rank-name' }, row.category.name),
              h('span', { class: 'rank-figure' }, h('strong', null, app.money(row.total)), ` ${formatPercent(row.share)}`),
            ),
            h('span', { class: 'rank-track' }, bar),
          ),
        ),
      );
    }),
  );
}

/** 直近 6 か月の推移。見ている月(右端)だけを強調する縦棒グラフ。 */
function trendFigure(app, type) {
  const label = TYPE_LABEL[type];
  const masked = app.state.settings.maskAmounts;
  const points = monthlyTotals(app.state, app.month, type, TREND_MONTHS);
  const scale = niceScale(Math.max(...points.map((point) => point.total)));
  const hasData = points.some((point) => point.total > 0);

  const plot = h('div', { class: 'plot' });
  for (const tick of scale.ticks) {
    const line = h(
      'div',
      { class: tick === 0 ? 'grid-line is-baseline' : 'grid-line' },
      h('span', { class: 'tick-label' }, masked ? '' : formatAxisYen(tick, scale.top)),
    );
    line.style.bottom = `${(tick / scale.top) * 100}%`;
    plot.append(line);
  }

  const tooltip = h('div', { class: 'tooltip', hidden: true });
  let pinned = null;
  const showTip = (column, point) => {
    tooltip.replaceChildren(h('strong', null, app.money(point.total)), h('span', null, `${formatMonth(point.month)}の${label}`));
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    const center = column.offsetLeft + column.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(center, half), plot.clientWidth - half)}px`;
    tooltip.style.bottom = `calc(${(point.total / scale.top) * 100}% + 10px)`;
  };
  const hideTip = () => {
    tooltip.hidden = true;
  };

  const columns = h('div', { class: 'cols' });
  points.forEach((point, index) => {
    const isCurrent = index === points.length - 1;
    const bar = h('span', { class: isCurrent ? 'col-bar is-current' : 'col-bar' });
    bar.style.height = `${(point.total / scale.top) * 100}%`;
    const column = h(
      'button',
      {
        class: 'col',
        type: 'button',
        'aria-label': `${formatMonth(point.month)}の${label} ${app.money(point.total)}`,
        on: {
          pointerenter: () => showTip(column, point),
          pointerleave: () => {
            if (pinned !== column) hideTip();
          },
          focus: () => showTip(column, point),
          blur: () => {
            if (pinned !== column) hideTip();
          },
          click: () => {
            if (pinned === column) {
              pinned = null;
              hideTip();
            } else {
              pinned = column;
              showTip(column, point);
            }
          },
        },
      },
      // 数値のラベルは、見ている月の棒にだけ付ける(ほかの月は目盛り・表・タップで読める)
      isCurrent && point.total > 0 && !masked ? h('span', { class: 'col-value' }, formatCompactYen(point.total)) : null,
      bar,
    );
    columns.append(column);
  });
  plot.append(columns, tooltip);

  const axis = h(
    'div',
    { class: 'x-axis', 'aria-hidden': 'true' },
    points.map((point, index) => {
      const [year, month] = point.month.split('-').map(Number);
      return h(
        'span',
        { class: index === points.length - 1 ? 'x-label is-current' : 'x-label' },
        `${month}月`,
        index === 0 || month === 1 ? h('span', { class: 'x-year' }, String(year)) : null,
      );
    }),
  );

  const table = h(
    'table',
    { class: 'data-table', hidden: true },
    h('caption', { class: 'visually-hidden' }, `直近 ${TREND_MONTHS} か月の${label}`),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, '月'), h('th', { scope: 'col' }, label))),
    h(
      'tbody',
      null,
      points.map((point) =>
        h('tr', null, h('th', { scope: 'row' }, formatMonth(point.month)), h('td', null, app.money(point.total))),
      ),
    ),
  );
  const toggle = h(
    'button',
    {
      class: 'pill-btn',
      type: 'button',
      'aria-expanded': 'false',
      on: {
        click: () => {
          const willShow = table.hidden;
          table.hidden = !willShow;
          toggle.setAttribute('aria-expanded', String(willShow));
          toggle.replaceChildren(icon('table', { size: 16 }), willShow ? '表を閉じる' : '表で見る');
        },
      },
    },
    icon('table', { size: 16 }),
    '表で見る',
  );

  return h(
    'figure',
    { class: 'card block chart' },
    h(
      'figcaption',
      { class: 'chart-head' },
      h(
        'div',
        null,
        h('h2', { class: 'block-title' }, `月ごとの${label}`),
        h('p', { class: 'block-sub' }, `${formatMonth(points[0].month)} 〜 ${formatMonth(points[points.length - 1].month)}`),
      ),
      toggle,
    ),
    hasData
      ? h('div', { class: 'chart-frame' }, plot, axis)
      : h('p', { class: 'block-empty' }, `この期間の${label}の記録はありません。`),
    table,
  );
}

export function renderAnalysis(app) {
  const type = app.analysisType;
  const label = TYPE_LABEL[type];
  const summary = summarizeMonth(app.state, app.month);
  const rows = summary.breakdown[type];
  const count = rows.reduce((sum, row) => sum + row.count, 0);

  const header = h('header', { class: 'topbar' }, monthSwitcher(app));
  const main = h(
    'main',
    { class: 'content' },
    // 絞り込みは 1 か所にまとめ、下のすべての表示に同じ条件を当てる
    h(
      'div',
      { class: 'filters' },
      segmented({
        label: '表示する内容',
        focusKey: 'analysis-type',
        options: [
          { value: 'expense', label: '支出' },
          { value: 'income', label: '収入' },
        ],
        value: type,
        onChange: (next) => {
          app.analysisType = next;
          app.render();
        },
      }),
    ),
    h(
      'section',
      { class: 'card summary' },
      h('p', { class: 'eyebrow' }, `${formatMonth(app.month)}の${label}`),
      h('p', { class: 'hero' }, app.money(summary[type])),
      h('p', { class: 'summary-sub' }, `${count} 件の記録`),
    ),
    h(
      'section',
      { class: 'card block' },
      h('h2', { class: 'block-title block-title-padded' }, 'カテゴリ別'),
      rows.length === 0 ? h('p', { class: 'block-empty' }, `この月の${label}の記録はありません。`) : rankedBars(app, rows),
    ),
    trendFigure(app, type),
  );
  return { header, main };
}
