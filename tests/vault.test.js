import { assert, deepEqual, equal, rejects, test } from './harness.js';
import { CorruptVaultError, UnsupportedVaultError, WrongPassphraseError } from '../app/js/crypto.js';
import { InvalidStateError, addTransaction, createInitialState } from '../app/js/model.js';
import { deleteStore, openStore } from '../app/js/store.js';
import {
  ConflictError,
  LockedError,
  NoVaultError,
  ThrottledError,
  Vault,
  decodePayload,
  encodePayload,
  readBackup,
  throttleDelayMs,
} from '../app/js/vault.js';

const PASS = 'たのしい家計簿 2026 secret';
const NEXT = 'あたらしい合言葉 long enough 42';
const WRONG = 'まちがいのパスフレーズです';

async function withStore(body) {
  const name = `kagi-kakeibo-test-${crypto.randomUUID()}`;
  const store = await openStore(name);
  try {
    await body(store);
  } finally {
    store.close();
    await deleteStore(name);
  }
}

function sample(memo = 'ひみつのメモXYZ', amount = 98765) {
  return { type: 'expense', amount, date: '2026-11-03', categoryId: 'exp-food', memo };
}

function indexOfBytes(haystack, needle) {
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

test('詰め物: 平文は 4096 バイト単位に切り上げられ、元に戻せる', () => {
  const small = encodePayload({ a: 1 });
  equal(small.length, 4096);
  deepEqual(decodePayload(small), { a: 1 });
  const big = encodePayload({ text: 'あ'.repeat(3000) });
  equal(big.length % 4096, 0);
  assert(big.length >= 9000);
  deepEqual(decodePayload(big), { text: 'あ'.repeat(3000) });
  let failed = false;
  try {
    decodePayload(new Uint8Array([0xff, 0xfe, 0x00]));
  } catch (error) {
    failed = error instanceof CorruptVaultError;
  }
  assert(failed, '壊れたデータを受け入れた');
});

test('待ち時間: 連続失敗回数に応じてのびる', () => {
  deepEqual(
    [0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 500].map((failures) => throttleDelayMs(failures) / 1000),
    [0, 0, 0, 30, 60, 120, 300, 900, 1800, 3600, 3600, 3600],
  );
});

test('保管庫: 作成 → ロック → 解錠で同じデータが戻る', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    equal(await vault.exists(), false);
    await rejects(vault.unlock(PASS), NoVaultError);
    await rejects(vault.save(), LockedError);

    await vault.create(PASS, createInitialState());
    equal(await vault.exists(), true);
    assert(vault.isUnlocked);
    const added = addTransaction(vault.state, sample());
    assert(added.ok);
    await vault.save();
    const before = JSON.stringify(vault.state);

    vault.lock();
    equal(vault.isUnlocked, false);
    equal(vault.state, null);
    await rejects(vault.save(), LockedError);

    await vault.unlock(PASS);
    equal(JSON.stringify(vault.state), before);
    equal(vault.kdfIterations, 600_000);
    await rejects(vault.create(PASS, createInitialState()), ConflictError, '既存の保管庫を上書きした');
  }));

test('保管庫: 保存されるのは暗号文だけ(金額・メモ・カテゴリ名が平文で残らない)', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    addTransaction(vault.state, sample('ひみつのメモXYZ', 98765));
    await vault.save();

    const record = await store.get('vault');
    deepEqual(Object.keys(record).sort(), ['data', 'format', 'kdf', 'tag', 'version', 'wrappedKey']);
    equal(record.data.ct.length % 4096, 16, '暗号文の長さ = 4096 の倍数 + 認証タグ');
    const stored = [record.data.ct, record.data.iv, record.wrappedKey.ct, record.kdf.salt, record.tag];
    for (const secret of ['ひみつのメモXYZ', '98765', '食費', 'exp-food', 'transactions', PASS]) {
      const needle = new TextEncoder().encode(secret);
      for (const bytes of stored) equal(indexOfBytes(bytes, needle), -1, `「${secret}」が見つかった`);
    }
    equal(await store.get('throttle'), undefined);
  }));

test('保管庫: 5 回まちがえると待ち時間が入り、時計を戻しても回避できない', () =>
  withStore(async (store) => {
    let clock = 1_800_000_000_000;
    const vault = new Vault(store, { now: () => clock });
    await vault.create(PASS, createInitialState());
    vault.lock();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = await rejects(vault.unlock(WRONG), WrongPassphraseError);
      equal(error.failures, attempt);
      equal(error.retryAt, 0);
    }
    const fifth = await rejects(vault.unlock(WRONG), WrongPassphraseError);
    equal(fifth.failures, 5);
    equal(fifth.retryAt, clock + 30_000);

    // 待ち時間中は、正しいパスフレーズでも受け付けない
    const blocked = await rejects(vault.unlock(PASS), ThrottledError);
    equal(blocked.retryAt, clock + 30_000);
    deepEqual(await vault.throttleState(), { failures: 5, retryAt: clock + 30_000 });

    // 時計を 1 時間戻しても、待ち時間は数え直しになるだけ
    clock -= 3_600_000;
    const rolledBack = await rejects(vault.unlock(PASS), ThrottledError);
    equal(rolledBack.retryAt, clock + 30_000);

    clock += 30_000;
    await vault.unlock(PASS);
    assert(vault.isUnlocked);
    deepEqual(await vault.throttleState(), { failures: 0, retryAt: 0 });
  }));

test('保管庫: パスフレーズ変更でソルト・鍵・暗号文がすべて作り直される', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    addTransaction(vault.state, sample());
    await vault.save();
    const oldBackup = await vault.exportBackup();
    const before = await store.get('vault');

    await rejects(vault.changePassphrase(WRONG, NEXT), WrongPassphraseError);
    await vault.changePassphrase(PASS, NEXT);
    const after = await store.get('vault');
    assert(!same(before.kdf.salt, after.kdf.salt), 'ソルトが同じ');
    assert(!same(before.wrappedKey.ct, after.wrappedKey.ct), '包んだ鍵が同じ');
    assert(!same(before.data.ct, after.data.ct), '暗号文が同じ');

    // 変更後もそのまま保存を続けられる
    addTransaction(vault.state, sample('変更後の記録', 120));
    await vault.save();
    await vault.verifyPassphrase(NEXT);
    await rejects(vault.verifyPassphrase(PASS), WrongPassphraseError);

    vault.lock();
    await rejects(vault.unlock(PASS), WrongPassphraseError);
    await vault.unlock(NEXT);
    equal(vault.state.transactions.length, 2);

    // 変更前に書き出したバックアップは、当時のパスフレーズで開く
    const restored = await readBackup(oldBackup, PASS);
    equal(restored.transactions.length, 1);
    await rejects(readBackup(oldBackup, NEXT), WrongPassphraseError);
  }));

test('保管庫: 別のタブが先に書き換えていたら、上書きせずに止まる', () =>
  withStore(async (store) => {
    const a = new Vault(store);
    const b = new Vault(store);
    await a.create(PASS, createInitialState());
    await b.unlock(PASS);

    addTransaction(a.state, sample('A の記録', 100));
    await a.save();
    addTransaction(b.state, sample('B の記録', 200));
    await rejects(b.save(), ConflictError);

    // 読み直せば A の内容が見え、そこから続けられる
    b.lock();
    await b.unlock(PASS);
    deepEqual(b.state.transactions.map((item) => item.memo), ['A の記録']);
    addTransaction(b.state, sample('B の記録', 200));
    await b.save();
  }));

test('保管庫: 保存の完了を待たずにロックしても、最後の変更まで書き込まれる', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    const saves = [];
    for (let n = 1; n <= 5; n += 1) {
      addTransaction(vault.state, sample(`記録${n}`, n * 100));
      saves.push(vault.save());
    }
    vault.lock();
    equal(vault.state, null);
    await Promise.all(saves);
    await vault.unlock(PASS);
    deepEqual(vault.state.transactions.map((item) => item.memo), ['記録1', '記録2', '記録3', '記録4', '記録5']);
  }));

test('バックアップ: 書き出し → 読み込みで同じデータが戻る。別のパスフレーズや壊れたファイルは拒否', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    addTransaction(vault.state, sample());
    await vault.save();

    const backup = await vault.exportBackup();
    equal(backup.includes('ひみつ'), false);
    equal(backup.includes('98765'), false);
    deepEqual(await readBackup(backup, PASS), vault.state);
    await rejects(readBackup(backup, WRONG), WrongPassphraseError);
    await rejects(readBackup('{"format":"x"}', PASS), UnsupportedVaultError);

    const broken = JSON.parse(backup);
    broken.data.ct = `${broken.data.ct.startsWith('A') ? 'B' : 'A'}${broken.data.ct.slice(1)}`;
    await rejects(readBackup(JSON.stringify(broken), PASS), CorruptVaultError);

    // 復元: 中身を検査してから入れ替える
    const other = createInitialState();
    addTransaction(other, sample('復元されたデータ', 5));
    await vault.replaceState(other);
    vault.lock();
    await vault.unlock(PASS);
    deepEqual(vault.state.transactions.map((item) => item.memo), ['復元されたデータ']);
    await rejects(Promise.resolve().then(() => vault.replaceState({ schema: 99 })), InvalidStateError);
  }));

test('保管庫: 消去するとすべてなくなる', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    vault.lock();
    await rejects(vault.unlock(WRONG), WrongPassphraseError);
    assert((await store.get('throttle')) !== undefined);
    await vault.wipe();
    equal(await vault.exists(), false);
    equal(await store.get('vault'), undefined);
    equal(await store.get('throttle'), undefined);
    equal(vault.isUnlocked, false);
  }));

test('保管庫: 解錠の計算中に消去しても、鍵と平文が残らない', () =>
  withStore(async (store) => {
    const vault = new Vault(store);
    await vault.create(PASS, createInitialState());
    addTransaction(vault.state, sample());
    await vault.save();
    vault.lock();
    const unlocking = vault.unlock(PASS); // 完了を待たずに…
    const wiping = vault.wipe(); // …消去する
    await unlocking;
    await wiping;
    equal(vault.isUnlocked, false, '消去のあとも解錠状態のままになっている');
    equal(vault.state, null);
    equal(await vault.exists(), false);
  }));

test('保管庫: 復元の書き込みに失敗したら、メモリ上の内容も元に戻る', () =>
  withStore(async (store) => {
    const a = new Vault(store);
    const b = new Vault(store);
    await a.create(PASS, createInitialState());
    addTransaction(a.state, sample('もとの記録', 100));
    await a.save();
    await b.unlock(PASS);
    const before = JSON.stringify(b.state);

    // a が先に書き換えたので、b の復元(置き換え)は衝突して失敗する
    addTransaction(a.state, sample('a のあとからの記録', 200));
    await a.save();
    const other = createInitialState();
    addTransaction(other, sample('バックアップの中身', 5));
    await rejects(b.replaceState(other), ConflictError);
    equal(JSON.stringify(b.state), before, '失敗したのに、メモリ上はバックアップの内容に置き換わっている');

    // ディスクは a の内容のまま
    b.lock();
    await b.unlock(PASS);
    deepEqual(b.state.transactions.map((item) => item.memo), ['もとの記録', 'a のあとからの記録']);
  }));

test('保管庫: パスフレーズの再確認は、ディスクではなく解錠中の保管庫に対して行う', () =>
  withStore(async (store) => {
    const mine = new Vault(store);
    await mine.create(PASS, createInitialState());

    // 別のタブが保管庫を消して、別のパスフレーズで作り直したとする
    const other = new Vault(store);
    await other.wipe();
    await other.create(NEXT, createInitialState());

    await rejects(mine.verifyPassphrase(NEXT), WrongPassphraseError, '作り直された保管庫のパスフレーズが通った');
    await mine.verifyPassphrase(PASS);
    await rejects(mine.changePassphrase(NEXT, 'さらに別のパスフレーズ 9876'), WrongPassphraseError);
    // こちらの古い内容で、作り直された保管庫を上書きすることもできない
    await rejects(mine.save(), ConflictError);
    await rejects(mine.changePassphrase(PASS, 'さらに別のパスフレーズ 9876'), ConflictError);
  }));

test('保管庫: 複数のタブから同時に試しても、待ち時間をすり抜けられない', () =>
  withStore(async (store) => {
    const clock = 1_900_000_000_000;
    const first = new Vault(store, { now: () => clock });
    await first.create(PASS, createInitialState());
    first.lock();
    for (let attempt = 1; attempt <= 4; attempt += 1) await rejects(first.unlock(WRONG), WrongPassphraseError);

    // 5 回目を、3 つのタブから同時に送る。通るのは 1 つだけで、残りは鍵の計算に進む前に止められる。
    const tabs = [first, new Vault(store, { now: () => clock }), new Vault(store, { now: () => clock })];
    const results = await Promise.all(tabs.map((tab) => tab.unlock(WRONG).then(() => 'unlocked', (error) => error.name)));
    deepEqual([...results].sort(), ['ThrottledError', 'ThrottledError', 'WrongPassphraseError']);
    deepEqual(await first.throttleState(), { failures: 5, retryAt: clock + 30_000 });
  }));

test('保管庫: 正しいパスフレーズなら、待ち時間が始まる回でもそのまま解錠できる', () =>
  withStore(async (store) => {
    const clock = 1_900_000_000_000;
    const vault = new Vault(store, { now: () => clock });
    await vault.create(PASS, createInitialState());
    vault.lock();
    for (let attempt = 1; attempt <= 4; attempt += 1) await rejects(vault.unlock(WRONG), WrongPassphraseError);
    await vault.unlock(PASS);
    assert(vault.isUnlocked);
    deepEqual(await vault.throttleState(), { failures: 0, retryAt: 0 });
  }));
