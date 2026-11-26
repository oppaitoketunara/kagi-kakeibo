// かぎ家計簿 — 表示用の整形(金額・日付・グラフの目盛り)

const number = new Intl.NumberFormat('ja-JP');
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 「金額を隠す」のときに金額の代わりに出す文字列 */
export const MASKED_YEN = '¥•••••';

export function formatYen(amount) {
  return amount < 0 ? `−¥${number.format(-amount)}` : `¥${number.format(amount)}`;
}

/** プラスのときに + を付ける(収入・収支用)。色だけに頼らず符号でも区別できるようにする。 */
export function formatSignedYen(amount) {
  return amount > 0 ? `+¥${number.format(amount)}` : formatYen(amount);
}

export function formatMonth(month) {
  const [year, value] = month.split('-');
  return `${Number(year)}年${Number(value)}月`;
}

export function formatDay(date) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${month}月${day}日(${weekday})`;
}

export function formatPercent(ratio) {
  if (ratio > 0 && ratio < 0.005) return '1%未満';
  return `${Math.round(ratio * 100)}%`;
}

export function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 入力中の金額を「12,345」の形に整える(全角数字もそのまま打てる)。
 * 取り除くのは桁区切り・空白・円記号だけ。小数点やマイナスなど数字以外が混じっていたら、勝手に直さず
 * そのまま返す(「1,980.00」を貼り付けたときに 198,000 円として保存してしまわないように。保存時にエラーになる)。
 */
export function groupAmountInput(text) {
  const plain = text.normalize('NFKC').replace(/[¥\\,\s]/g, '');
  if (!/^[0-9]*$/.test(plain)) return text;
  const digits = plain.replace(/^0+/, '');
  if (digits.length > 9) return text;
  return digits === '' ? '' : number.format(Number(digits));
}

function oneDecimal(value) {
  return String(Math.round(value * 10) / 10);
}

/** グラフの棒の上に置く短い金額表記(¥18.3万 など)。 */
export function formatCompactYen(amount) {
  if (amount >= 1e8) return `¥${oneDecimal(amount / 1e8)}億`;
  if (amount >= 1e4) return `¥${oneDecimal(amount / 1e4)}万`;
  return formatYen(amount);
}

/** グラフの縦軸の目盛り。軸の最大値に合わせて単位(万・億)をそろえる。 */
export function formatAxisYen(value, top) {
  if (value === 0) return '0';
  if (top >= 1e8) return `${oneDecimal(value / 1e8)}億`;
  if (top >= 1e4) return `${oneDecimal(value / 1e4)}万`;
  return number.format(value);
}

/** 最大値から、きりのよい目盛り(0 を含む 3〜5 本)を決める。 */
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = Math.max(1, [1, 2, 5, 10].find((step) => step * power >= rough) * power);
  const top = Math.ceil(max / unit) * unit;
  const ticks = [];
  for (let value = 0; value <= top; value += unit) ticks.push(value);
  return { top, ticks };
}
