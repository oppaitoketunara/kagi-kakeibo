import { assert, deepEqual, equal, test, throws } from './harness.js';
import {
  CATEGORY_COLORS,
  InvalidStateError,
  LIMITS,
  activeCategories,
  addCategory,
  addMonths,
  addTransaction,
  budgetStatus,
  checkTransaction,
  cleanText,
  createInitialState,
  csvCell,
  currentMonth,
  deleteCategory,
  deleteTransaction,
  isValidDate,
  isValidMonth,
  markBackedUp,
  monthlyTotals,
  parseAmount,
  renameCategory,
  setAutoLock,
  setCategoryArchived,
  setCategoryColor,
  setMaskAmounts,
  setMonthlyBudget,
  shiftMonth,
  summarizeMonth,
  toCsv,
  todayString,
  updateTransaction,
  validateState,
} from '../app/js/model.js';

const at = (iso) => new Date(iso);

// 見えない文字はソースに直接書かず、コードポイントから作る
const NUL = String.fromCodePoint(0x0000);
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);

function filled() {
  const state = createInitialState(at('2026-01-01T00:00:00.000Z'));
  const rows = [
    ['expense', 1200, '2026-11-03', 'exp-food', 'ランチ', '2026-11-03T03:00:00.000Z'],
    ['expense', 800, '2026-11-03', 'exp-food', 'コーヒー', '2026-11-03T05:00:00.000Z'],
    ['expense', 5000, '2026-11-10', 'exp-transport', '定期', '2026-11-10T01:00:00.000Z'],
    ['income', 250000, '2026-11-25', 'inc-salary', '', '2026-11-25T01:00:00.000Z'],
    ['expense', 3000, '2026-10-31', 'exp-food', '先月', '2026-10-31T01:00:00.000Z'],
    ['expense', 700, '2026-12-01', 'exp-daily', '来月', '2026-12-01T01:00:00.000Z'],
  ];
  for (const [type, amount, date, categoryId, memo, stamp] of rows) {
    const result = addTransaction(state, { type, amount, date, categoryId, memo }, at(stamp));
    assert(result.ok, JSON.stringify(result.errors));
  }
  return state;
}

test('金額: 全角・カンマ・円記号まじりでも読め、範囲外や小数は拒否する', () => {
  deepEqual(
    ['1200', '１，２００', '¥1,200', '￥１２００', ' 1 200 ', '999999999', 5].map(parseAmount),
    [1200, 1200, 1200, 1200, 1200, 999999999, 5],
  );
  for (const bad of ['', '0', '-5', '1.5', '1e3', '１２a', '1000000000', 'abc', null, undefined, 0, -1, 1.5, NaN, Infinity, 1e9, {}]) {
    equal(parseAmount(bad), null, String(bad));
  }
});

test('日付: 実在する日付だけを受け付ける', () => {
  for (const good of ['2026-11-26', '2024-02-29', '2000-01-01', '2100-12-31']) assert(isValidDate(good), good);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-31', '2026-11-00', '1999-12-31', '2101-01-01', '2026-1-5', '2026/11/26', '', null, 20261126]) {
    assert(!isValidDate(bad), String(bad));
  }
  assert(isValidMonth('2026-11'));
  assert(!isValidMonth('2026-13'));
  equal(todayString(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  equal(currentMonth(new Date(2026, 10, 30)), '2026-11');
});

test('月の移動: 年をまたぎ、範囲の端で止まる', () => {
  equal(shiftMonth('2026-11', 1), '2026-12');
  equal(shiftMonth('2026-12', 1), '2027-01');
  equal(shiftMonth('2026-01', -1), '2025-12');
  equal(shiftMonth('2026-03', -14), '2025-01');
  equal(shiftMonth('2000-01', -1), '2000-01');
  equal(shiftMonth('2100-12', 1), '2100-12');
  equal(addMonths('2000-01', -1), '1999-12');
});

test('文字の掃除: 制御文字・向きを変える文字を取り除き、長さを切りそろえる', () => {
  equal(cleanText('  ランチ\n\tカレー  ', 100), 'ランチ カレー');
  equal(cleanText(`a${NUL}b${RLO}c${ZWSP}d${BOM}`, 100), 'abcd');
  equal(cleanText('全角　スペース', 100), '全角 スペース');
  equal(cleanText('😀😀😀😀', 2), '😀😀');
  equal(cleanText('x'.repeat(300), LIMITS.memoMax).length, 100);
  equal(cleanText(null, 10), '');
  equal(cleanText(123, 10), '');
  // 桁違いに長い文字列(細工したバックアップなど)でも、すぐに切り捨てて処理する
  const started = performance.now();
  equal(cleanText('あ'.repeat(5_000_000), LIMITS.memoMax), 'あ'.repeat(100));
  assert(performance.now() - started < 500, '巨大な文字列の処理に時間がかかりすぎている');
});

test('取引: 追加・更新・削除と入力の検査', () => {
  const state = createInitialState();
  const bad = checkTransaction(state, { type: 'gift', amount: '0', date: '2026-02-30', categoryId: 'nope' });
  assert(!bad.ok);
  deepEqual(Object.keys(bad.errors).sort(), ['amount', 'category', 'date', 'type']);

  // 収入なのに支出カテゴリ、という組み合わせは通さない
  assert(!checkTransaction(state, { type: 'income', amount: 100, date: '2026-11-01', categoryId: 'exp-food' }).ok);

  const added = addTransaction(state, { type: 'expense', amount: '１，２００', date: '2026-11-03', categoryId: 'exp-food', memo: ` ランチ${RLO} ` });
  assert(added.ok);
  equal(added.value.amount, 1200);
  equal(added.value.memo, 'ランチ');
  assert(/^[A-Za-z0-9_-]{1,64}$/.test(added.value.id));
  equal(state.transactions.length, 1);

  const updated = updateTransaction(state, added.value.id, { type: 'income', amount: 5000, date: '2026-11-04', categoryId: 'inc-side', memo: '' });
  assert(updated.ok);
  equal(state.transactions[0].type, 'income');
  equal(state.transactions[0].amount, 5000);
  equal(state.transactions[0].id, added.value.id);
  assert(!updateTransaction(state, 'missing', { type: 'income', amount: 1, date: '2026-11-04', categoryId: 'inc-side' }).ok);
  assert(!updateTransaction(state, added.value.id, { type: 'income', amount: -1, date: '2026-11-04', categoryId: 'inc-side' }).ok);
  equal(state.transactions[0].amount, 5000, '検査に落ちた更新が反映された');

  equal(deleteTransaction(state, 'missing'), false);
  equal(deleteTransaction(state, added.value.id), true);
  equal(state.transactions.length, 0);
});

test('集計: 月の合計・日ごとのまとまり・カテゴリ別内訳', () => {
  const summary = summarizeMonth(filled(), '2026-11');
  equal(summary.income, 250000);
  equal(summary.expense, 7000);
  equal(summary.balance, 243000);
  equal(summary.count, 4);
  deepEqual(summary.days.map((day) => [day.date, day.expense, day.income, day.items.length]), [
    ['2026-11-25', 0, 250000, 1],
    ['2026-11-10', 5000, 0, 1],
    ['2026-11-03', 2000, 0, 2],
  ]);
  deepEqual(summary.days[2].items.map((item) => item.memo), ['コーヒー', 'ランチ'], '同じ日は新しい順');
  deepEqual(summary.breakdown.expense.map((row) => [row.category.name, row.total, row.count]), [
    ['交通', 5000, 1],
    ['食費', 2000, 2],
  ]);
  equal(Math.round(summary.breakdown.expense[0].share * 1000), 714);
  deepEqual(summary.breakdown.income.map((row) => [row.category.name, row.total, row.share]), [['給与', 250000, 1]]);

  const empty = summarizeMonth(filled(), '2025-01');
  deepEqual([empty.income, empty.expense, empty.balance, empty.count, empty.days.length], [0, 0, 0, 0, 0]);
});

test('集計: 月ごとの推移は年をまたいで直近 6 か月', () => {
  const state = filled();
  deepEqual(monthlyTotals(state, '2026-12', 'expense', 6), [
    { month: '2026-07', total: 0 },
    { month: '2026-08', total: 0 },
    { month: '2026-09', total: 0 },
    { month: '2026-10', total: 3000 },
    { month: '2026-11', total: 7000 },
    { month: '2026-12', total: 700 },
  ]);
  deepEqual(monthlyTotals(state, '2027-02', 'income', 4).map((point) => point.month), ['2026-11', '2026-12', '2027-01', '2027-02']);
  equal(monthlyTotals(state, '2026-11', 'income', 1)[0].total, 250000);
});

test('予算: 使用率に応じて 通常 / 注意 / 超過 になる', () => {
  equal(budgetStatus(null, 100), null);
  equal(budgetStatus(0, 100), null);
  deepEqual(budgetStatus(10000, 7999), { budget: 10000, expense: 7999, remaining: 2001, ratio: 0.7999, level: 'normal' });
  equal(budgetStatus(10000, 8000).level, 'warning');
  equal(budgetStatus(10000, 10000).level, 'warning');
  const over = budgetStatus(10000, 10001);
  equal(over.level, 'over');
  equal(over.remaining, -1);
});

test('設定: 予算・自動ロック・金額の表示', () => {
  const state = createInitialState();
  deepEqual(setMonthlyBudget(state, '１５０，０００'), { ok: true, value: 150000 });
  equal(state.settings.monthlyBudget, 150000);
  assert(!setMonthlyBudget(state, '0').ok);
  assert(!setMonthlyBudget(state, 'たくさん').ok);
  equal(state.settings.monthlyBudget, 150000);
  deepEqual(setMonthlyBudget(state, ''), { ok: true, value: null });
  equal(state.settings.monthlyBudget, null);

  equal(state.settings.autoLockSec, 0, '初期値は「すぐロック」');
  equal(setAutoLock(state, 60), true);
  equal(setAutoLock(state, 86400), false);
  equal(state.settings.autoLockSec, 60);

  setMaskAmounts(state, true);
  equal(state.settings.maskAmounts, true);
  markBackedUp(state, at('2026-11-26T12:00:00.000Z'));
  equal(state.settings.lastBackupAt, '2026-11-26T12:00:00.000Z');
});

test('カテゴリ: 追加・名前変更・非表示・削除のルール', () => {
  const state = filled();
  const added = addCategory(state, 'expense', ' ペット ');
  assert(added.ok);
  equal(added.value.name, 'ペット');
  equal(added.value.mark, 'ペ');
  assert(!addCategory(state, 'expense', 'ペット').ok, '同名を許した');
  assert(addCategory(state, 'income', 'ペット').ok, '種別がちがえば同名でもよい');
  assert(!addCategory(state, 'expense', '   ').ok);
  assert(!addCategory(state, 'gift', 'x').ok);
  equal(addCategory(state, 'expense', 'あ'.repeat(40)).value.name.length, LIMITS.categoryNameMax);

  assert(renameCategory(state, added.value.id, 'どうぶつ').ok);
  equal(state.categories.find((item) => item.id === added.value.id).mark, 'ど');
  assert(!renameCategory(state, added.value.id, '食費').ok);
  assert(renameCategory(state, added.value.id, 'どうぶつ').ok, '自分自身と同じ名前は可');

  assert(!deleteCategory(state, 'exp-food').ok, '使用中のカテゴリを削除できた');
  assert(deleteCategory(state, added.value.id).ok);
  assert(setCategoryArchived(state, 'exp-food', true).ok);
  assert(!activeCategories(state, 'expense').some((item) => item.id === 'exp-food'));
  equal(summarizeMonth(state, '2026-11').breakdown.expense.length, 2, '非表示にしても過去の集計には残る');

  // 収入カテゴリを 1 つだけ残すと、それ以上は隠せないし消せない
  const single = createInitialState();
  for (const id of ['inc-bonus', 'inc-side', 'inc-other']) assert(deleteCategory(single, id).ok);
  assert(!setCategoryArchived(single, 'inc-salary', true).ok);
  assert(!deleteCategory(single, 'inc-salary').ok);
});

test('状態の検査: 正しいデータは通り、知らない項目は捨てる', () => {
  const state = filled();
  const copy = JSON.parse(JSON.stringify(state));
  copy.unknown = { evil: true };
  copy.transactions[0].extra = '<script>';
  copy.settings.somethingNew = 1;
  const clean = validateState(copy);
  deepEqual(clean, state);
  assert(!('unknown' in clean));
  assert(!('extra' in clean.transactions[0]));
  assert(clean !== copy && clean.transactions !== copy.transactions);
});

test('状態の検査: おかしなデータは受け付けない', () => {
  const base = () => JSON.parse(JSON.stringify(filled()));
  const mutations = {
    '配列': () => [],
    'null': () => null,
    '未知の版': (s) => ({ ...s, schema: 2 }),
    '作成日時なし': (s) => ({ ...s, createdAt: 'yesterday' }),
    '設定なし': (s) => ({ ...s, settings: null }),
    '予算が文字列': (s) => ({ ...s, settings: { ...s.settings, monthlyBudget: '100' } }),
    '予算が負': (s) => ({ ...s, settings: { ...s.settings, monthlyBudget: -1 } }),
    'バックアップ日時が不正': (s) => ({ ...s, settings: { ...s.settings, lastBackupAt: 12345 } }),
    'カテゴリが配列でない': (s) => ({ ...s, categories: {} }),
    'カテゴリ ID の重複': (s) => ({ ...s, categories: [...s.categories, s.categories[0]] }),
    'カテゴリ ID に記号': (s) => ({ ...s, categories: [{ ...s.categories[0], id: '<img>' }, ...s.categories.slice(1)] }),
    'カテゴリ名が空': (s) => ({ ...s, categories: [{ ...s.categories[0], name: ` ${ZWSP} ` }, ...s.categories.slice(1)] }),
    'カテゴリの種別が不正': (s) => ({ ...s, categories: [{ ...s.categories[0], type: 'gift' }, ...s.categories.slice(1)] }),
    '収入カテゴリが全部非表示': (s) => ({ ...s, categories: s.categories.map((c) => (c.type === 'income' ? { ...c, archived: true } : c)) }),
    'カテゴリが多すぎる': (s) => ({ ...s, categories: Array.from({ length: 81 }, (_, i) => ({ id: `c${i}`, type: i % 2 ? 'income' : 'expense', name: `c${i}`, mark: 'c', archived: false })), transactions: [] }),
    '取引が配列でない': (s) => ({ ...s, transactions: 'none' }),
    '取引 ID の重複': (s) => ({ ...s, transactions: [s.transactions[0], s.transactions[0]] }),
    '金額が 0': (s) => ({ ...s, transactions: [{ ...s.transactions[0], amount: 0 }] }),
    '金額が小数': (s) => ({ ...s, transactions: [{ ...s.transactions[0], amount: 10.5 }] }),
    '金額が文字列': (s) => ({ ...s, transactions: [{ ...s.transactions[0], amount: '1200' }] }),
    '金額が大きすぎる': (s) => ({ ...s, transactions: [{ ...s.transactions[0], amount: 1e12 }] }),
    '存在しない日付': (s) => ({ ...s, transactions: [{ ...s.transactions[0], date: '2026-02-31' }] }),
    '存在しないカテゴリ': (s) => ({ ...s, transactions: [{ ...s.transactions[0], categoryId: 'ghost' }] }),
    '種別とカテゴリの食い違い': (s) => ({ ...s, transactions: [{ ...s.transactions[0], type: 'income' }] }),
    '種別なし': (s) => ({ ...s, transactions: [{ ...s.transactions[0], type: undefined, categoryId: 'ghost' }] }),
    'メモが文字列でない': (s) => ({ ...s, transactions: [{ ...s.transactions[0], memo: { toString: 1 } }] }),
    '時刻が不正': (s) => ({ ...s, transactions: [{ ...s.transactions[0], updatedAt: 'now' }] }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    throws(() => validateState(mutate(base())), InvalidStateError, label);
  }
  // 文字の掃除は「拒否」ではなく「取り除いて受け入れる」
  const dirty = base();
  dirty.transactions[0].memo = `メモ${RLO}${NUL}`;
  equal(validateState(dirty).transactions[0].memo, 'メモ');
});

test('CSV: 引用符・改行を正しく扱い、数式として実行されないようにする', () => {
  equal(csvCell('ランチ'), '"ランチ"');
  equal(csvCell('彼は"安い"と言った'), '"彼は""安い""と言った"');
  equal(csvCell('=HYPERLINK("http://example.invalid","x")'), '"\'=HYPERLINK(""http://example.invalid"",""x"")"');
  for (const start of ['+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']) {
    assert(csvCell(`${start}cmd`).startsWith('"\''), `${JSON.stringify(start)} で始まる値`);
  }
  equal(csvCell(1200), '"1200"');

  const state = filled();
  addTransaction(state, { type: 'expense', amount: 1, date: '2026-11-26', categoryId: 'exp-other', memo: '=1+1' });
  const csv = toCsv(state);
  assert(csv.startsWith(`${BOM}"日付","種別","カテゴリ","金額","メモ"\r\n`));
  assert(csv.endsWith('\r\n'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  equal(lines.length, 8);
  equal(lines[1], '"2026-10-31","支出","食費","3000","先月"', '古い順');
  equal(lines[5], '"2026-11-25","収入","給与","250000",""');
  equal(lines[6], '"2026-11-26","支出","その他","1","\'=1+1"');
});

test('カテゴリの色: 既定の色が付き、追加したものは使われていない色から始まる', () => {
  const state = createInitialState();
  for (const category of state.categories) assert(CATEGORY_COLORS.includes(category.color), category.name);
  const expenseColors = state.categories.filter((item) => item.type === 'expense').map((item) => item.color);
  equal(new Set(expenseColors).size, expenseColors.length, '支出カテゴリの既定の色が重なっている');

  const added = addCategory(state, 'expense', 'ペット');
  assert(added.ok);
  assert(!expenseColors.includes(added.value.color), `すでに使われている色になった: ${added.value.color}`);

  assert(setCategoryColor(state, added.value.id, 'pink').ok);
  equal(state.categories.find((item) => item.id === added.value.id).color, 'pink');
  assert(!setCategoryColor(state, added.value.id, 'url(javascript:alert(1))').ok, '色の名前以外を受け付けた');
  assert(!setCategoryColor(state, 'missing', 'pink').ok);
});

test('以前の版のデータ: 色・写真の項目がなくても読み込め、足りないものは補われる', () => {
  const old = JSON.parse(JSON.stringify(filled()));
  delete old.mediaKey;
  for (const category of old.categories) delete category.color;
  for (const item of old.transactions) delete item.receiptId;
  old.categories.push({ id: 'custom-1', type: 'expense', name: '自作', mark: '自', archived: false });
  old.categories[0].color = 'not-a-color';
  const state = validateState(old);
  equal(state.categories.find((item) => item.id === 'exp-daily').color, 'teal', '既定カテゴリは既定の色');
  equal(state.categories[0].color, 'orange', '知らない色の名前は既定の色に戻す');
  assert(CATEGORY_COLORS.includes(state.categories.find((item) => item.id === 'custom-1').color));
  assert(state.transactions.every((item) => item.receiptId === null));
  assert(/^[A-Za-z0-9+/]{43}=$/.test(state.mediaKey), '写真用の鍵が作られていない');
  assert(validateState(old).mediaKey !== state.mediaKey, '写真用の鍵が毎回同じ');
  equal(validateState(state).mediaKey, state.mediaKey, '一度できた鍵は保たれる');
});

test('レシートの参照: ID の形をしたものだけを受け付ける', () => {
  const state = createInitialState();
  const base = { type: 'expense', amount: 100, date: '2026-11-03', categoryId: 'exp-food', memo: '' };
  equal(addTransaction(state, base).value.receiptId, null);
  equal(addTransaction(state, { ...base, receiptId: 'abc-123' }).value.receiptId, 'abc-123');
  equal(addTransaction(state, { ...base, receiptId: '../../vault' }).value.receiptId, null);
  equal(addTransaction(state, { ...base, receiptId: { toString: () => 'x' } }).value.receiptId, null);
  const copy = JSON.parse(JSON.stringify(state));
  copy.transactions[0].receiptId = 'vault:../x';
  throws(() => validateState(copy), InvalidStateError);
});
