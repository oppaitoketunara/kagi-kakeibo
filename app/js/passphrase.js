// かぎ家計簿 — パスフレーズの強さの判定
//
// 暗号文を手に入れた相手は、端末の外で好きなだけパスフレーズを試せる。
// 守りの強さはパスフレーズそのものの推測しにくさで決まるので、弱すぎるものは受け付けない。
// ここでの「強さ」は目安であり、厳密な計算ではない。

export const MIN_LENGTH = 10;
export const DIGITS_ONLY_MIN_LENGTH = 16;

const COMMON = new Set([
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'passphrase', 'pass', 'qwerty', 'qwertyuiop', 'asdfghjkl',
  'zxcvbnm', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'iloveyou', 'letmein', 'welcome', 'admin', 'administrator',
  'login', 'master', 'dragon', 'monkey', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'pokemon',
  'doraemon', 'sakura', 'kakeibo', 'himitsu', 'secret', 'changeme', 'trustno1', 'abc', 'abcd', 'test', 'aaa',
  'ぱすわーど', 'パスワード', 'かけいぼ', '家計簿', 'ひみつ',
]);

const LEVELS = ['弱い', 'ふつう', '強い', 'とても強い'];

// 半角の空白・記号 (ASCII の 0x20-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7E)
function isAsciiSymbol(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x20 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

const isAsciiDigit = (char) => char >= '0' && char <= '9';

/** 前後に付け足した半角の数字・記号を取り除く(password123! → password)。かな・漢字はそのまま。 */
function stripEdges(chars) {
  let start = 0;
  let end = chars.length;
  while (start < end && (isAsciiDigit(chars[start]) || isAsciiSymbol(chars[start]))) start += 1;
  while (end > start && (isAsciiDigit(chars[end - 1]) || isAsciiSymbol(chars[end - 1]))) end -= 1;
  return chars.slice(start, end).join('');
}

function isStraightRun(codes) {
  if (codes.length < 2) return false;
  const step = codes[1] - codes[0];
  if (step !== 1 && step !== -1) return false;
  for (let index = 2; index < codes.length; index += 1) {
    if (codes[index] - codes[index - 1] !== step) return false;
  }
  return true;
}

function isRepeatedUnit(chars) {
  for (let size = 1; size <= Math.floor(chars.length / 2); size += 1) {
    let repeated = true;
    for (let index = size; index < chars.length; index += 1) {
      if (chars[index] !== chars[index % size]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return true;
  }
  return false;
}

function estimateBits(text, chars) {
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/[0-9]/.test(text)) pool += 10;
  if (chars.some(isAsciiSymbol)) pool += 33;
  if (chars.some((char) => char.codePointAt(0) > 0x7f)) pool += 80;
  if (pool === 0) return 0;
  // となり合う同じ文字・連番は、推測しやすいぶん半分に数える
  let effective = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const step = index === 0 ? null : chars[index].codePointAt(0) - chars[index - 1].codePointAt(0);
    effective += step === 0 || step === 1 || step === -1 ? 0.5 : 1;
  }
  return Math.round(effective * Math.log2(pool));
}

/**
 * パスフレーズを評価する。
 * 戻り値: { ok, problems: string[], level: 0..3, label, bits }
 */
export function assessPassphrase(input) {
  const text = (typeof input === 'string' ? input : '').normalize('NFKC');
  const chars = Array.from(text);
  const problems = [];

  if (chars.length < MIN_LENGTH) {
    problems.push(`${MIN_LENGTH} 文字以上にしてください(あと ${MIN_LENGTH - chars.length} 文字)。`);
  } else {
    const lower = text.toLowerCase();
    const core = stripEdges(Array.from(lower));
    if (/^[0-9]+$/.test(text) && chars.length < DIGITS_ONLY_MIN_LENGTH) {
      problems.push(`数字だけの場合は ${DIGITS_ONLY_MIN_LENGTH} 桁以上にするか、文字を混ぜてください。`);
    }
    if (new Set(chars).size < 5) problems.push('同じ文字の繰り返しが多すぎます。');
    else if (isRepeatedUnit(chars)) problems.push('同じ並びの繰り返しは使えません。');
    if (isStraightRun(chars.map((char) => char.codePointAt(0)))) {
      problems.push('1234… や abcd… のような連続した並びは使えません。');
    }
    if (COMMON.has(lower) || COMMON.has(core)) problems.push('よく使われる言葉がもとになっていて、推測されやすいです。');
  }

  const bits = estimateBits(text, chars);
  let level = 0;
  if (problems.length === 0) {
    if (bits >= 90) level = 3;
    else if (bits >= 65) level = 2;
    else level = 1;
  }
  return { ok: problems.length === 0, problems, level, label: LEVELS[level], bits };
}
