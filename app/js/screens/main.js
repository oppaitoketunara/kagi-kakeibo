// かぎ家計簿 — 解錠後の画面の枠(上部バー・本文・下部タブ)

import { h, icon } from '../dom.js';
import { renderAnalysis } from './analysis.js';
import { openEntry } from './entry.js';
import { renderHome } from './home.js';
import { renderSettings } from './settings.js';

const TABS = [
  { id: 'home', label: 'ホーム', icon: 'home', render: renderHome },
  { id: 'analysis', label: '分析', icon: 'chart', render: renderAnalysis },
  { id: 'settings', label: '設定', icon: 'sliders', render: renderSettings },
];

export function renderMain(app) {
  const current = TABS.find((tab) => tab.id === app.tab) ?? TABS[0];
  const { header, main } = current.render(app);
  return h(
    'div',
    { class: 'shell' },
    header,
    main,
    // 追加ボタンはホームだけに出す(分析の表やグラフに重ならないように)
    current.id !== 'home'
      ? null
      : h(
          'button',
          {
            class: 'fab',
            type: 'button',
            'aria-label': '記録を追加',
            dataset: { focusKey: 'fab' },
            on: { click: () => openEntry(app) },
          },
          icon('plus', { size: 28 }),
        ),
    h(
      'nav',
      { class: 'tabbar', 'aria-label': 'メインメニュー' },
      TABS.map((tab) =>
        h(
          'button',
          {
            class: 'tab',
            type: 'button',
            'aria-current': tab.id === current.id ? 'page' : null,
            dataset: { focusKey: `tab-${tab.id}` },
            on: { click: () => app.navigate(tab.id) },
          },
          icon(tab.icon),
          h('span', null, tab.label),
        ),
      ),
    ),
  );
}
