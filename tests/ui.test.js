import { assert, deepEqual, equal, test, throws } from './harness.js';
import { append, confirmDialog, h, icon } from '../app/js/dom.js';
import {
  formatAxisYen,
  formatCompactYen,
  formatDay,
  formatMonth,
  formatPercent,
  formatSignedYen,
  formatYen,
  groupAmountInput,
  niceScale,
} from '../app/js/format.js';
import { DIGITS_ONLY_MIN_LENGTH, MIN_LENGTH, assessPassphrase } from '../app/js/passphrase.js';

test('画面部品: 入力された文字は HTML として解釈されない', () => {
  const attack = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';
  const node = h('div', { class: 'row', title: attack }, attack, h('span', { text: attack }));
  document.body.append(node);
  equal(node.querySelector('img'), null);
  equal(node.querySelector('script'), null);
  equal(node.firstChild.nodeType, Node.TEXT_NODE);
  equal(node.firstChild.data, attack);
  equal(node.querySelector('span').textContent, attack);
  equal(node.getAttribute('title'), attack);
  equal(window.__pwned, undefined);
  node.remove();
});

test('画面部品: スクリプトや URL として働く属性は設定できない', () => {
  for (const key of ['onclick', 'onerror', 'ONLOAD', 'innerHTML', 'outerHTML', 'srcdoc', 'style', 'href', 'src', 'action', 'formaction']) {
    throws(() => h('a', { [key]: 'javascript:alert(1)' }), TypeError, key);
  }
  const button = h('button', { type: 'button', disabled: true, 'aria-label': 'x', dataset: { focusKey: 'k' } });
  equal(button.disabled, true);
  equal(button.dataset.focusKey, 'k');
  deepEqual(append(h('p'), ['a', null, false, undefined, '', ['b', [h('b', null, 'c')]]]).textContent, 'abc');
});

test('画面部品: アイコンは固定のパスだけから作られる', () => {
  const svg = icon('lock');
  equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert(svg.querySelectorAll('path').length >= 1);
  equal(svg.getAttribute('aria-hidden'), 'true');
  throws(() => icon('<script>'), RangeError);
});

test('画面部品: 確認ダイアログはチェックを入れるまで実行できない', async () => {
  const pending = confirmDialog({ title: '消去', message: ['本当に?'], confirmLabel: '消去する', danger: true, checkLabel: '理解しました' });
  const dialog = document.querySelector('#overlays dialog');
  assert(dialog !== null && dialog.open);
  const [cancel, confirm] = dialog.querySelectorAll('.dialog-actions button');
  equal(confirm.disabled, true);
  const box = dialog.querySelector('input[type="checkbox"]');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  equal(confirm.disabled, false);
  confirm.click();
  equal(await pending, true);
  equal(document.querySelector('#overlays dialog'), null);

  const second = confirmDialog({ title: 't', message: 'm' });
  document.querySelector('#overlays dialog .dialog-actions button').click();
  equal(await second, false);
  assert(cancel !== undefined);
});

test('表示: 金額・日付・割合', () => {
  equal(formatYen(0), '¥0');
  equal(formatYen(1234567), '¥1,234,567');
  equal(formatYen(-500), '−¥500');
  equal(formatSignedYen(500), '+¥500');
  equal(formatSignedYen(-500), '−¥500');
  equal(formatSignedYen(0), '¥0');
  equal(formatMonth('2026-01'), '2026年1月');
  equal(formatDay('2026-11-26'), '11月26日(木)');
  equal(formatDay('2024-02-29'), '2月29日(木)');
  deepEqual([0, 0.001, 0.004, 0.005, 0.286, 1].map(formatPercent), ['0%', '1%未満', '1%未満', '1%', '29%', '100%']);
});

test('表示: グラフの目盛りと短い金額表記', () => {
  deepEqual(niceScale(183400), { top: 200000, ticks: [0, 100000, 200000] });
  deepEqual(niceScale(320000), { top: 400000, ticks: [0, 200000, 400000] });
  deepEqual(niceScale(45000), { top: 60000, ticks: [0, 20000, 40000, 60000] });
  deepEqual(niceScale(10000), { top: 10000, ticks: [0, 5000, 10000] });
  deepEqual(niceScale(7), { top: 10, ticks: [0, 5, 10] });
  deepEqual(niceScale(12), { top: 15, ticks: [0, 5, 10, 15] });
  deepEqual(niceScale(1), { top: 1, ticks: [0, 1] });
  deepEqual(niceScale(0), { top: 1, ticks: [0] });
  for (const max of [1, 3, 99, 1234, 98765, 4321000, 999999999]) {
    const scale = niceScale(max);
    assert(scale.top >= max, `top < max (${max})`);
    assert(scale.ticks.length >= 2 && scale.ticks.length <= 5, `目盛りの数 ${scale.ticks.length} (${max})`);
    assert(scale.ticks.every(Number.isInteger), `整数でない目盛り (${max})`);
  }
  deepEqual([0, 5000, 10000].map((tick) => formatAxisYen(tick, 10000)), ['0', '0.5万', '1万']);
  deepEqual([0, 500, 1000].map((tick) => formatAxisYen(tick, 1000)), ['0', '500', '1,000']);
  equal(formatAxisYen(200000000, 400000000), '2億');
  deepEqual([8400, 183400, 200000, 123456789].map(formatCompactYen), ['¥8,400', '¥18.3万', '¥20万', '¥1.2億']);
});

test('金額の入力: 桁区切りだけを整え、数字以外が混じった値は勝手に書き換えない', () => {
  deepEqual(
    ['', '0', '007', '1980', '１２３４５', '1,2345', '¥1 980', '999999999'].map(groupAmountInput),
    ['', '', '7', '1,980', '12,345', '12,345', '1,980', '999,999,999'],
  );
  // 小数点・マイナス・指数・文字が入ったものはそのまま残す(保存時に「金額が正しくない」と伝えるため)。
  // 「1,980.00」を 198,000 円にしてしまったり、「-500」を 500 円にしてしまったりしない。
  for (const raw of ['1,980.00', '-500', '1.5', '1e3', '12a', '1234567890']) {
    equal(groupAmountInput(raw), raw, raw);
  }
});

test('パスフレーズ: 弱いものは受け付けない', () => {
  equal(MIN_LENGTH, 10);
  equal(DIGITS_ONLY_MIN_LENGTH, 16);
  const rejected = [
    'short',
    'abcdefghi',
    '1234567890',
    '0987654321',
    '9999999999',
    '123456789012345',
    'aaaaaaaaaaaa',
    'abababababab',
    'abcabcabcabc',
    'abcdefghijkl',
    'password123',
    'Password!!!!',
    'qwertyuiop',
    '1q2w3e4r5t',
    'iloveyou1234',
    'パスワード12345',
    'ｐａｓｓｗｏｒｄ１２３',
    '',
    null,
  ];
  for (const candidate of rejected) {
    const result = assessPassphrase(candidate);
    assert(!result.ok, `受け付けてしまった: ${candidate}`);
    equal(result.level, 0, String(candidate));
    assert(result.problems.length > 0);
  }
});

test('パスフレーズ: 十分に長く推測しにくいものは受け付け、強さの目安を返す', () => {
  const accepted = [
    ['8305127946021735', 1],
    ['ぬるい麦茶と青い自転車', 2],
    ['correct horse battery staple', 3],
    ['Tr7#kq9!Zm2$xw', 2],
    ['Tr7#kq9!Zm2$xv4&Lp', 3],
    ['mizuiro-jitensha', 2],
  ];
  for (const [candidate, minLevel] of accepted) {
    const result = assessPassphrase(candidate);
    assert(result.ok, `拒否された: ${candidate} (${result.problems.join(' ')})`);
    assert(result.level >= minLevel, `${candidate}: level ${result.level} < ${minLevel} (${result.bits}bit)`);
    equal(result.problems.length, 0);
  }
  const weak = assessPassphrase('kxmvqpzrwt');
  assert(weak.ok && weak.level === 1, '英小文字 10 文字は「ふつう」');
});
