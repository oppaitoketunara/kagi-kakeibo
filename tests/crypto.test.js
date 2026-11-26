import { assert, deepEqual, equal, rejects, test, throws } from './harness.js';
import {
  FORMAT,
  KDF_ITERATIONS,
  CorruptVaultError,
  UnsupportedVaultError,
  WrongPassphraseError,
  assertEnvelope,
  createKeys,
  decryptData,
  encryptData,
  envelopeFromJson,
  envelopeToJson,
  fromBase64,
  randomBytes,
  toBase64,
  unlockKeys,
} from '../app/js/crypto.js';

const PASS = 'correct horse 電池 ホチキス';
const utf8 = (text) => new TextEncoder().encode(text);
const fromUtf8 = (bytes) => new TextDecoder().decode(bytes);

// 鍵導出は重いので、使い回せる保管庫を 1 つだけ作る
let shared = null;
function fixture() {
  shared ??= (async () => {
    const keys = await createKeys(PASS);
    const data = await encryptData(keys.dek, utf8('{"hello":"世界"}'));
    return { keys, envelope: { format: FORMAT, version: 1, kdf: keys.kdf, wrappedKey: keys.wrappedKey, data } };
  })();
  return shared;
}

function clone(envelope) {
  return {
    format: envelope.format,
    version: envelope.version,
    kdf: { ...envelope.kdf, salt: envelope.kdf.salt.slice() },
    wrappedKey: { iv: envelope.wrappedKey.iv.slice(), ct: envelope.wrappedKey.ct.slice() },
    data: { iv: envelope.data.iv.slice(), ct: envelope.data.ct.slice() },
  };
}

test('base64: あらゆるバイト列を往復できる', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 70_000]) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) % 256;
    deepEqual(Array.from(fromBase64(toBase64(bytes))), Array.from(bytes), `長さ ${length}`);
  }
});

test('base64: 不正な文字列は拒否する', () => {
  for (const bad of ['abc', 'ab=c', 'a b=', '!!!!', 'あいうえ', null, 12, undefined]) {
    throws(() => fromBase64(bad), CorruptVaultError, show(bad));
  }
});

test('乱数: 毎回ちがう値になる', () => {
  equal(randomBytes(32).length, 32);
  assert(toBase64(randomBytes(32)) !== toBase64(randomBytes(32)));
});

test('暗号: 正しいパスフレーズで解錠して復号できる', async () => {
  const { envelope } = await fixture();
  equal(envelope.kdf.iterations, KDF_ITERATIONS);
  equal(envelope.kdf.salt.length, 32);
  equal(envelope.wrappedKey.ct.length, 48, 'AES-256 の鍵 32 バイト + 認証タグ 16 バイト');
  const dek = await unlockKeys(PASS, envelope);
  equal(fromUtf8(await decryptData(dek, envelope.data)), '{"hello":"世界"}');
});

test('暗号: ちがうパスフレーズでは解錠できない', async () => {
  const { envelope } = await fixture();
  await rejects(unlockKeys('correct horse 電池 ホチキズ', envelope), WrongPassphraseError);
});

test('暗号: 全角・半角がちがっても同じパスフレーズとして扱う (NFKC)', async () => {
  const keys = await createKeys('Ｐａｓｓフレーズ１２３ｶﾞ');
  const dek = await unlockKeys('Passフレーズ123ガ', keys);
  const data = await encryptData(keys.dek, utf8('ok'));
  equal(fromUtf8(await decryptData(dek, data)), 'ok');
});

test('暗号: データ鍵は JavaScript から取り出せない', async () => {
  const { keys } = await fixture();
  equal(keys.dek.extractable, false);
  await rejects(crypto.subtle.exportKey('raw', keys.dek));
  deepEqual([...keys.dek.usages].sort(), ['decrypt', 'encrypt']);
});

test('暗号: 同じ内容でも、暗号化のたびに IV と暗号文が変わる', async () => {
  const { keys } = await fixture();
  const a = await encryptData(keys.dek, utf8('同じ内容'));
  const b = await encryptData(keys.dek, utf8('同じ内容'));
  equal(a.iv.length, 12);
  assert(toBase64(a.iv) !== toBase64(b.iv), 'IV が同じ');
  assert(toBase64(a.ct) !== toBase64(b.ct), '暗号文が同じ');
});

test('暗号: 暗号文・IV が 1 ビットでも変わると復号を拒否する', async () => {
  const { keys, envelope } = await fixture();
  for (const field of ['ct', 'iv']) {
    for (const position of [0, envelope.data[field].length - 1]) {
      const tampered = clone(envelope);
      tampered.data[field][position] ^= 0x01;
      await rejects(decryptData(keys.dek, tampered.data), CorruptVaultError, `${field}[${position}]`);
    }
  }
  const truncated = clone(envelope);
  truncated.data.ct = truncated.data.ct.slice(0, -1);
  await rejects(decryptData(keys.dek, truncated.data), CorruptVaultError, '末尾を削った暗号文');
});

test('暗号: 鍵導出の条件や包んだ鍵を書き換えると解錠できない', async () => {
  const { envelope } = await fixture();
  const moreIterations = clone(envelope);
  moreIterations.kdf.iterations += 1;
  await rejects(unlockKeys(PASS, moreIterations), WrongPassphraseError, '反復回数');

  const otherSalt = clone(envelope);
  otherSalt.kdf.salt[0] ^= 0x01;
  await rejects(unlockKeys(PASS, otherSalt), WrongPassphraseError, 'ソルト');

  const otherKey = clone(envelope);
  otherKey.wrappedKey.ct[5] ^= 0x80;
  await rejects(unlockKeys(PASS, otherKey), WrongPassphraseError, '包んだ鍵');
});

test('暗号: 用途のちがう暗号文を取り違えさせられない (AAD)', async () => {
  const { keys, envelope } = await fixture();
  // 「包んだ鍵」をデータとして復号させようとしても、追加認証データがちがうので失敗する
  await rejects(decryptData(keys.dek, envelope.wrappedKey), CorruptVaultError);
});

test('形式: バックアップ用 JSON に変換して元に戻せる', async () => {
  const { envelope } = await fixture();
  const json = envelopeToJson(envelope);
  const parsed = JSON.parse(json);
  deepEqual(Object.keys(parsed).sort(), ['data', 'format', 'kdf', 'version', 'wrappedKey']);
  const restored = envelopeFromJson(json);
  const dek = await unlockKeys(PASS, restored);
  equal(fromUtf8(await decryptData(dek, restored.data)), '{"hello":"世界"}');
});

test('形式: おかしなバックアップは読み込まない', async () => {
  const { envelope } = await fixture();
  const base = JSON.parse(envelopeToJson(envelope));
  const variants = [
    ['空文字', '', CorruptVaultError],
    ['JSON でない', 'not json', CorruptVaultError],
    ['配列', '[]', CorruptVaultError],
    ['null', 'null', CorruptVaultError],
    ['別の形式名', JSON.stringify({ ...base, format: 'something-else' }), UnsupportedVaultError],
    ['未来の版', JSON.stringify({ ...base, version: 2 }), UnsupportedVaultError],
    ['弱い鍵導出', JSON.stringify({ ...base, kdf: { ...base.kdf, iterations: 1000 } }), UnsupportedVaultError],
    ['重すぎる鍵導出', JSON.stringify({ ...base, kdf: { ...base.kdf, iterations: 1e9 } }), UnsupportedVaultError],
    ['別のハッシュ', JSON.stringify({ ...base, kdf: { ...base.kdf, hash: 'SHA-1' } }), UnsupportedVaultError],
    ['短いソルト', JSON.stringify({ ...base, kdf: { ...base.kdf, salt: 'AAAA' } }), CorruptVaultError],
    ['IV の長さ', JSON.stringify({ ...base, data: { ...base.data, iv: 'AAAA' } }), CorruptVaultError],
    ['鍵の長さ', JSON.stringify({ ...base, wrappedKey: { ...base.wrappedKey, ct: 'AAAA' } }), CorruptVaultError],
    ['データなし', JSON.stringify({ ...base, data: undefined }), CorruptVaultError],
    ['base64 でない', JSON.stringify({ ...base, data: { ...base.data, ct: '***' } }), CorruptVaultError],
  ];
  for (const [label, text, ErrorClass] of variants) {
    throws(() => envelopeFromJson(text), ErrorClass, label);
  }
  throws(() => assertEnvelope(null), CorruptVaultError);
  throws(() => assertEnvelope({ ...envelope, kdf: { ...envelope.kdf, salt: Array.from(envelope.kdf.salt) } }), CorruptVaultError);
});

function show(value) {
  return typeof value === 'string' ? value : String(value);
}
