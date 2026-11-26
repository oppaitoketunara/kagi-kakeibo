// かぎ家計簿 — データモデル
//
// 状態 (state) はただの JSON オブジェクト。ここにある関数だけがそれを検査・変更・集計する。
// 画面にもストレージにも依存しない。

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  amountMax: 999_999_999,
  memoMax: 100,
  categoryNameMax: 12,
  maxCategories: 80,
  maxTransactions: 200_000,
  yearMin: 2000,
  yearMax: 2100,
});

/** 自動ロックまでの秒数として選べる値。0 は「アプリを離れたらすぐ」。 */
export const AUTO_LOCK_CHOICES = Object.freeze([0, 30, 60, 300]);

export class InvalidStateError extends Error {
  constructor(reason) {
    super(`invalid state: ${reason}`);
    this.name = 'InvalidStateError';
  }
}

const TYPES = Object.freeze(['expense', 'income']);

const DEFAULT_CATEGORIES = Object.freeze([
  ['exp-food', 'expense', '食費', '食'],
  ['exp-daily', 'expense', '日用品', '日'],
  ['exp-housing', 'expense', '住居', '住'],
  ['exp-utility', 'expense', '水道・光熱', '光'],
  ['exp-telecom', 'expense', '通信', '通'],
  ['exp-transport', 'expense', '交通', '交'],
  ['exp-medical', 'expense', '医療', '医'],
  ['exp-education', 'expense', '教育', '教'],
  ['exp-leisure', 'expense', '娯楽', '娯'],
  ['exp-clothing', 'expense', '衣服・美容', '衣'],
  ['exp-social', 'expense', '交際', '際'],
  ['exp-insurance', 'expense', '保険', '保'],
  ['exp-tax', 'expense', '税金', '税'],
  ['exp-other', 'expense', 'その他', '他'],
  ['inc-salary', 'income', '給与', '給'],
  ['inc-bonus', 'income', '賞与', '賞'],
  ['inc-side', 'income', '副業', '副'],
  ['inc-other', 'income', 'その他', '他'],
]);

export function createInitialState(now = new Date()) {
  return {
    schema: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    settings: { autoLockSec: 0, monthlyBudget: null, maskAmounts: false, lastBackupAt: null },
    categories: DEFAULT_CATEGORIES.map(([id, type, name, mark]) => ({ id, type, name, mark, archived: false })),
    transactions: [],
  };
}

export function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// 入力の正規化と検査
// ---------------------------------------------------------------------------

// 入力から取り除く文字(コードポイントの範囲)。表示を乱したり、見た目の偽装に使えたりするもの。
// 見えない文字をソースコードに直接書かずに済むよう、数値で持つ。
const UNSAFE_RANGES = Object.freeze([
  [0x0000, 0x001f], // C0 制御文字
  [0x007f, 0x009f], // DEL と C1 制御文字
  [0x200b, 0x200b], // ゼロ幅スペース
  [0x200e, 0x200f], // 左右の向きの印
  [0x2028, 0x202e], // 行・段落の区切り、向きの埋め込みと上書き
  [0x2066, 0x2069], // 向きの分離
  [0xfeff, 0xfeff], // BOM
]);

function isUnsafeChar(char) {
  const code = char.codePointAt(0);
  return UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);
}

// 掃除の前に、まず桁違いに長い入力を切り捨てる(細工したバックアップの巨大な文字列でメモリを使い切らないように)
const RAW_TEXT_LIMIT = 4096;

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const bounded = value.length > RAW_TEXT_LIMIT ? value.slice(0, RAW_TEXT_LIMIT) : value;
  const wellFormed = typeof bounded.toWellFormed === 'function' ? bounded.toWellFormed() : bounded;
  const text = Array.from(wellFormed.normalize('NFC').replace(/\s+/g, ' '))
    .filter((char) => !isUnsafeChar(char))
    .join('')
    .trim();
  return Array.from(text).slice(0, maxLength).join('').trim();
}

function isAmount(value) {
  return Number.isInteger(value) && value >= 1 && value <= LIMITS.amountMax;
}

/** 入力文字列(全角数字・カンマ・円記号まじりでもよい)を 1 円以上の整数にする。だめなら null。 */
export function parseAmount(input) {
  if (typeof input === 'number') return isAmount(input) ? input : null;
  if (typeof input !== 'string') return null;
  const digits = input.normalize('NFKC').replace(/[¥\\,\s]/g, '');
  if (!/^[0-9]{1,9}$/.test(digits)) return null;
  const amount = Number(digits);
  return isAmount(amount) ? amount : null;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' 形式で、実在する日付かどうか。 */
export function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < LIMITS.yearMin || year > LIMITS.yearMax || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function isValidMonth(value) {
  return typeof value === 'string' && isValidDate(`${value}-01`);
}

const pad2 = (value) => String(value).padStart(2, '0');

/** 端末の現地時間での日付文字列。 */
export function toDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayString(now = new Date()) {
  return toDateString(now);
}

export function currentMonth(now = new Date()) {
  return todayString(now).slice(0, 7);
}

export function monthOf(dateString) {
  return dateString.slice(0, 7);
}

function monthIndex(month) {
  const [year, value] = month.split('-').map(Number);
  return year * 12 + (value - 1);
}

function monthFromIndex(index) {
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** 月を前後に動かす(範囲の制限なし)。 */
export function addMonths(month, delta) {
  return monthFromIndex(monthIndex(month) + delta);
}

/** 月を前後に動かす。扱える範囲 (2000-01〜2100-12) の外には出ない。 */
export function shiftMonth(month, delta) {
  const min = LIMITS.yearMin * 12;
  const max = LIMITS.yearMax * 12 + 11;
  return monthFromIndex(Math.min(Math.max(monthIndex(month) + delta, min), max));
}

function isId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstMark(name) {
  return Array.from(name)[0];
}

// ---------------------------------------------------------------------------
// 取引
// ---------------------------------------------------------------------------

/** 入力を検査して正規化する。{ ok: true, value } か { ok: false, errors } を返す。 */
export function checkTransaction(state, input) {
  const errors = {};
  const type = input?.type;
  if (!TYPES.includes(type)) errors.type = '支出か収入かを選んでください。';
  const amount = parseAmount(input?.amount);
  if (amount === null) errors.amount = '金額は 1〜999,999,999 円の整数で入力してください。';
  const date = input?.date;
  if (!isValidDate(date)) errors.date = '日付が正しくありません。';
  const category = state.categories.find((item) => item.id === input?.categoryId);
  if (category === undefined || category.type !== type) errors.category = 'カテゴリを選んでください。';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { type, amount, date, categoryId: category.id, memo: cleanText(input.memo ?? '', LIMITS.memoMax) },
  };
}

export function addTransaction(state, input, now = new Date()) {
  const checked = checkTransaction(state, input);
  if (!checked.ok) return checked;
  if (state.transactions.length >= LIMITS.maxTransactions) {
    return { ok: false, errors: { form: '記録できる件数の上限に達しました。' } };
  }
  const stamp = now.toISOString();
  const transaction = { id: newId(), ...checked.value, createdAt: stamp, updatedAt: stamp };
  state.transactions.push(transaction);
  return { ok: true, value: transaction };
}

export function updateTransaction(state, id, input, now = new Date()) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (transaction === undefined) return { ok: false, errors: { form: 'この記録は見つかりませんでした。' } };
  const checked = checkTransaction(state, input);
  if (!checked.ok) return checked;
  Object.assign(transaction, checked.value, { updatedAt: now.toISOString() });
  return { ok: true, value: transaction };
}

export function deleteTransaction(state, id) {
  const index = state.transactions.findIndex((item) => item.id === id);
  if (index === -1) return false;
  state.transactions.splice(index, 1);
  return true;
}

function newestFirst(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return 0;
}

export function transactionsOfMonth(state, month) {
  return state.transactions.filter((item) => item.date.startsWith(`${month}-`)).sort(newestFirst);
}

/** 1 か月分の合計・日ごとのまとまり・カテゴリ別の内訳。 */
export function summarizeMonth(state, month) {
  const items = transactionsOfMonth(state, month);
  const totals = { income: 0, expense: 0 };
  const perCategory = new Map();
  const days = [];
  for (const item of items) {
    totals[item.type] += item.amount;
    const entry = perCategory.get(item.categoryId) ?? { total: 0, count: 0 };
    entry.total += item.amount;
    entry.count += 1;
    perCategory.set(item.categoryId, entry);
    let day = days[days.length - 1];
    if (day === undefined || day.date !== item.date) {
      day = { date: item.date, income: 0, expense: 0, items: [] };
      days.push(day);
    }
    day[item.type] += item.amount;
    day.items.push(item);
  }
  const breakdown = (type) =>
    state.categories
      .filter((category) => category.type === type && perCategory.has(category.id))
      .map((category) => {
        const { total, count } = perCategory.get(category.id);
        return { category, total, count, share: totals[type] > 0 ? total / totals[type] : 0 };
      })
      .sort((a, b) => b.total - a.total);
  return {
    month,
    income: totals.income,
    expense: totals.expense,
    balance: totals.income - totals.expense,
    count: items.length,
    days,
    breakdown: { expense: breakdown('expense'), income: breakdown('income') },
  };
}

/** `endMonth` までの直近 `count` か月の合計(古い月から順)。 */
export function monthlyTotals(state, endMonth, type, count = 6) {
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) months.push(addMonths(endMonth, -back));
  const totals = new Map(months.map((month) => [month, 0]));
  for (const item of state.transactions) {
    if (item.type !== type) continue;
    const month = monthOf(item.date);
    if (totals.has(month)) totals.set(month, totals.get(month) + item.amount);
  }
  return months.map((month) => ({ month, total: totals.get(month) }));
}

/** 予算に対する使用状況。予算が未設定なら null。 */
export function budgetStatus(budget, expense) {
  if (!isAmount(budget)) return null;
  const ratio = expense / budget;
  let level = 'normal';
  if (ratio > 1) level = 'over';
  else if (ratio >= 0.8) level = 'warning';
  return { budget, expense, remaining: budget - expense, ratio, level };
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** 月の予算を設定する。空文字や null なら「予算なし」。 */
export function setMonthlyBudget(state, input) {
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    state.settings.monthlyBudget = null;
    return { ok: true, value: null };
  }
  const amount = parseAmount(input);
  if (amount === null) return { ok: false, error: '予算は 1〜999,999,999 円の整数で入力してください。' };
  state.settings.monthlyBudget = amount;
  return { ok: true, value: amount };
}

export function setAutoLock(state, seconds) {
  if (!AUTO_LOCK_CHOICES.includes(seconds)) return false;
  state.settings.autoLockSec = seconds;
  return true;
}

export function setMaskAmounts(state, masked) {
  state.settings.maskAmounts = masked === true;
}

export function markBackedUp(state, now = new Date()) {
  state.settings.lastBackupAt = now.toISOString();
}

// ---------------------------------------------------------------------------
// カテゴリ
// ---------------------------------------------------------------------------

export function activeCategories(state, type) {
  return state.categories.filter((category) => category.type === type && !category.archived);
}

export function categoryUsage(state, id) {
  let count = 0;
  for (const item of state.transactions) {
    if (item.categoryId === id) count += 1;
  }
  return count;
}

function checkCategoryName(state, type, rawName, exceptId = null) {
  const name = cleanText(rawName, LIMITS.categoryNameMax);
  if (name === '') return { ok: false, error: 'カテゴリ名を入力してください。' };
  const clash = state.categories.some((item) => item.type === type && item.name === name && item.id !== exceptId);
  if (clash) return { ok: false, error: '同じ名前のカテゴリがすでにあります。' };
  return { ok: true, value: name };
}

export function addCategory(state, type, rawName) {
  if (!TYPES.includes(type)) return { ok: false, error: '種別が正しくありません。' };
  if (state.categories.length >= LIMITS.maxCategories) return { ok: false, error: 'カテゴリの数が上限です。' };
  const checked = checkCategoryName(state, type, rawName);
  if (!checked.ok) return checked;
  const category = { id: newId(), type, name: checked.value, mark: firstMark(checked.value), archived: false };
  state.categories.push(category);
  return { ok: true, value: category };
}

export function renameCategory(state, id, rawName) {
  const category = state.categories.find((item) => item.id === id);
  if (category === undefined) return { ok: false, error: 'カテゴリが見つかりません。' };
  const checked = checkCategoryName(state, category.type, rawName, id);
  if (!checked.ok) return checked;
  category.name = checked.value;
  category.mark = firstMark(checked.value);
  return { ok: true, value: category };
}

/** 使わなくなったカテゴリを入力画面から隠す(過去の記録はそのまま残る)。 */
export function setCategoryArchived(state, id, archived) {
  const category = state.categories.find((item) => item.id === id);
  if (category === undefined) return { ok: false, error: 'カテゴリが見つかりません。' };
  if (archived && !category.archived && activeCategories(state, category.type).length <= 1) {
    return { ok: false, error: '使えるカテゴリが 1 つは必要です。' };
  }
  category.archived = archived === true;
  return { ok: true, value: category };
}

/** 記録で一度も使っていないカテゴリだけ削除できる。 */
export function deleteCategory(state, id) {
  const index = state.categories.findIndex((item) => item.id === id);
  if (index === -1) return { ok: false, error: 'カテゴリが見つかりません。' };
  const category = state.categories[index];
  if (categoryUsage(state, id) > 0) return { ok: false, error: '記録で使っているカテゴリは削除できません。' };
  if (!category.archived && activeCategories(state, category.type).length <= 1) {
    return { ok: false, error: '使えるカテゴリが 1 つは必要です。' };
  }
  state.categories.splice(index, 1);
  return { ok: true, value: category };
}

// ---------------------------------------------------------------------------
// 状態全体の検査
// ---------------------------------------------------------------------------

/**
 * 復号した(あるいはバックアップから読んだ)データを検査し、
 * 知っている項目だけを写し取った新しい状態を返す。おかしければ InvalidStateError。
 */
export function validateState(raw) {
  const fail = (reason) => {
    throw new InvalidStateError(reason);
  };
  if (!isPlainObject(raw)) fail('not an object');
  if (raw.schema !== SCHEMA_VERSION) fail('unsupported schema');
  if (!isTimestamp(raw.createdAt)) fail('createdAt');

  const rawSettings = isPlainObject(raw.settings) ? raw.settings : fail('settings');
  const budget = rawSettings.monthlyBudget ?? null;
  if (budget !== null && !isAmount(budget)) fail('settings.monthlyBudget');
  const lastBackupAt = rawSettings.lastBackupAt ?? null;
  if (lastBackupAt !== null && !isTimestamp(lastBackupAt)) fail('settings.lastBackupAt');
  const settings = {
    autoLockSec: AUTO_LOCK_CHOICES.includes(rawSettings.autoLockSec) ? rawSettings.autoLockSec : 0,
    monthlyBudget: budget,
    maskAmounts: rawSettings.maskAmounts === true,
    lastBackupAt,
  };

  if (!Array.isArray(raw.categories) || raw.categories.length > LIMITS.maxCategories) fail('categories');
  const typeOfCategory = new Map();
  const categories = raw.categories.map((item) => {
    if (!isPlainObject(item) || !isId(item.id) || typeOfCategory.has(item.id)) fail('category.id');
    if (!TYPES.includes(item.type)) fail('category.type');
    const name = cleanText(item.name, LIMITS.categoryNameMax);
    if (name === '') fail('category.name');
    const mark = typeof item.mark === 'string' ? cleanText(item.mark, 1) : '';
    typeOfCategory.set(item.id, item.type);
    return { id: item.id, type: item.type, name, mark: mark === '' ? firstMark(name) : mark, archived: item.archived === true };
  });
  for (const type of TYPES) {
    if (!categories.some((category) => category.type === type && !category.archived)) fail(`no active ${type} category`);
  }

  if (!Array.isArray(raw.transactions) || raw.transactions.length > LIMITS.maxTransactions) fail('transactions');
  const seen = new Set();
  const transactions = raw.transactions.map((item) => {
    if (!isPlainObject(item) || !isId(item.id) || seen.has(item.id)) fail('transaction.id');
    seen.add(item.id);
    if (!TYPES.includes(item.type)) fail('transaction.type');
    if (typeOfCategory.get(item.categoryId) !== item.type) fail('transaction.categoryId');
    if (!isAmount(item.amount)) fail('transaction.amount');
    if (!isValidDate(item.date)) fail('transaction.date');
    if (typeof item.memo !== 'string') fail('transaction.memo');
    if (!isTimestamp(item.createdAt) || !isTimestamp(item.updatedAt)) fail('transaction.timestamps');
    return {
      id: item.id,
      type: item.type,
      amount: item.amount,
      date: item.date,
      categoryId: item.categoryId,
      memo: cleanText(item.memo, LIMITS.memoMax),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  return { schema: SCHEMA_VERSION, createdAt: raw.createdAt, settings, categories, transactions };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * CSV の 1 セル。表計算ソフトで開いたときに数式として実行されないよう、
 * 危険な文字で始まる値には先頭に ' を付ける(CSV インジェクション対策)。
 */
export function csvCell(value) {
  let text = String(value);
  if (/^[=+\-@\t\r＝＋－＠]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const BOM = String.fromCodePoint(0xfeff);

/** 全記録を CSV にする(BOM 付き UTF-8・CRLF。Excel でそのまま開ける)。 */
export function toCsv(state) {
  const names = new Map(state.categories.map((category) => [category.id, category.name]));
  const rows = [...state.transactions]
    .sort((a, b) => -newestFirst(a, b))
    .map((item) => [
      item.date,
      item.type === 'income' ? '収入' : '支出',
      names.get(item.categoryId) ?? '',
      String(item.amount),
      item.memo,
    ]);
  const lines = [['日付', '種別', 'カテゴリ', '金額', 'メモ'], ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
