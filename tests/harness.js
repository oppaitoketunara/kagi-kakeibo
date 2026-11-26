// ブラウザ上で動く、ごく小さなテスト実行器。

const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

function show(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function assert(condition, message = '条件を満たしていない') {
  if (!condition) throw new Error(message);
}

export function equal(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} 期待 ${show(expected)} / 実際 ${show(actual)}`.trim());
  }
}

export function deepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message} 期待 ${e} / 実際 ${a}`.trim());
}

export async function rejects(promise, ErrorClass = null, message = '') {
  try {
    await promise;
  } catch (error) {
    if (ErrorClass !== null && !(error instanceof ErrorClass)) {
      throw new Error(`${message} 想定外のエラー ${error?.name}: ${error?.message}`.trim());
    }
    return error;
  }
  throw new Error(`${message} エラーになるはずが成功した`.trim());
}

export function throws(fn, ErrorClass = null, message = '') {
  try {
    fn();
  } catch (error) {
    if (ErrorClass !== null && !(error instanceof ErrorClass)) {
      throw new Error(`${message} 想定外のエラー ${error?.name}: ${error?.message}`.trim());
    }
    return error;
  }
  throw new Error(`${message} エラーになるはずが成功した`.trim());
}

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${ms}ms 以内に終わらなかった`)), ms);
  });
}

export async function run() {
  const list = document.getElementById('results');
  const summary = document.getElementById('summary');
  const started = performance.now();
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of registry) {
    const item = document.createElement('li');
    const t0 = performance.now();
    try {
      await Promise.race([fn(), timeout(60_000)]);
      passed += 1;
      item.className = 'pass';
      item.textContent = `PASS ${name} (${Math.round(performance.now() - t0)}ms)`;
    } catch (error) {
      failed += 1;
      item.className = 'fail';
      item.textContent = `FAIL ${name} — ${error?.message ?? error}`;
    }
    list.append(item);
  }
  summary.textContent = `合計 ${registry.length} / 合格 ${passed} / 失敗 ${failed} (${Math.round(performance.now() - started)}ms)`;
  summary.className = failed > 0 ? 'fail' : 'pass';
  document.title = failed > 0 ? `失敗 ${failed} 件` : `全 ${passed} 件合格`;
}
