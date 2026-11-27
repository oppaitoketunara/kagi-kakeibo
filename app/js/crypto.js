// かぎ家計簿 — 暗号まわりの基本部品
//
// ブラウザ標準の WebCrypto (SubtleCrypto) だけを使い、外部ライブラリには依存しない。
//
// 鍵の階層
//   パスフレーズ ──PBKDF2-HMAC-SHA-256──▶ KEK(鍵を包むための鍵)
//   KEK ──AES-256-GCM で包む──▶ DEK(データ鍵。乱数で生成)
//   DEK ──AES-256-GCM──▶ 家計簿データ
//
// KEK と DEK は「取り出し不可 (extractable: false)」の CryptoKey として扱うので、
// JavaScript からは鍵そのもののバイト列を読み出せない。

export const FORMAT = 'kagi-kakeibo-vault';
export const FORMAT_VERSION = 1;

/** 新しく鍵を作るときの PBKDF2-HMAC-SHA-256 の反復回数。OWASP Password Storage Cheat Sheet の推奨値。 */
export const KDF_ITERATIONS = 600_000;

// 読み込むときに受け付ける範囲。下限は「これより弱い保管庫は開かない」という固定の線で、
// 上の既定値を将来引き上げても、それ以前に作った保管庫やバックアップは開けるままにする。
const KDF_MIN_ITERATIONS = 600_000;
const KDF_MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const MAX_JSON_CHARS = 96 * 1024 * 1024;

const DEK_ALGORITHM = Object.freeze({ name: 'AES-GCM', length: 256 });
const encoder = new TextEncoder();

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase');
    this.name = 'WrongPassphraseError';
    /** これまでに連続して間違えた回数(保管庫の解錠時だけ設定される) */
    this.failures = 0;
    /** 次に試せる時刻(ミリ秒)。待ち時間がなければ 0 */
    this.retryAt = 0;
  }
}

export class CorruptVaultError extends Error {
  constructor(reason = 'corrupt vault') {
    super(reason);
    this.name = 'CorruptVaultError';
  }
}

export class UnsupportedVaultError extends Error {
  constructor(reason = 'unsupported vault') {
    super(reason);
    this.name = 'UnsupportedVaultError';
  }
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new CorruptVaultError('invalid base64');
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * パスフレーズを鍵導出用のバイト列にする。
 * 全角・半角や合成文字の違いで解錠できなくなるのを防ぐため NFKC で正規化する (NIST SP 800-63B)。
 */
function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('passphrase must be a non-empty string');
  }
  return encoder.encode(passphrase.normalize('NFKC'));
}

async function deriveKek(passphrase, salt, iterations) {
  const bytes = passphraseBytes(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    );
  } finally {
    bytes.fill(0);
  }
}

/** 鍵を包むときの追加認証データ。鍵導出の条件を書き換えられたら解錠に失敗するようにする。 */
function keyAad(kdf) {
  return encoder.encode(
    [FORMAT, `v${FORMAT_VERSION}`, 'key', kdf.name, kdf.hash, String(kdf.iterations), toBase64(kdf.salt)].join('|'),
  );
}

const DATA_AAD = encoder.encode([FORMAT, `v${FORMAT_VERSION}`, 'data'].join('|'));

function wrapParams(kdf, iv) {
  return { name: 'AES-GCM', iv, additionalData: keyAad(kdf), tagLength: 128 };
}

/** 新しいパスフレーズで鍵一式を作る。ソルトも DEK も毎回あたらしい乱数。 */
export async function createKeys(passphrase) {
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: randomBytes(SALT_BYTES) };
  const kek = await deriveKek(passphrase, kdf.salt, kdf.iterations);
  const fresh = await crypto.subtle.generateKey(DEK_ALGORITHM, true, ['encrypt', 'decrypt']);
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.wrapKey('raw', fresh, kek, wrapParams(kdf, iv)));
  // 包んだものを「取り出し不可」として開け直し、以後はそちらだけを使う。
  const dek = await crypto.subtle.unwrapKey('raw', ct, kek, wrapParams(kdf, iv), DEK_ALGORITHM, false, [
    'encrypt',
    'decrypt',
  ]);
  return { kdf, wrappedKey: { iv, ct }, dek };
}

/** パスフレーズで DEK を開ける。違っていれば WrongPassphraseError。 */
export async function unlockKeys(passphrase, header) {
  const { kdf, wrappedKey } = header;
  const kek = await deriveKek(passphrase, kdf.salt, kdf.iterations);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedKey.ct,
      kek,
      wrapParams(kdf, wrappedKey.iv),
      DEK_ALGORITHM,
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

/** 毎回あたらしい 96 ビットの乱数 IV で暗号化する。 */
export async function encryptData(dek, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: DATA_AAD, tagLength: 128 }, dek, plaintext),
  );
  return { iv, ct };
}

/** 復号する。1 ビットでも改ざんされていれば CorruptVaultError。 */
export async function decryptData(dek, data) {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.iv, additionalData: DATA_AAD, tagLength: 128 },
        dek,
        data.ct,
      ),
    );
  } catch {
    throw new CorruptVaultError('decryption failed');
  }
}

// ---------------------------------------------------------------------------
// 付属データ(レシート写真)用: 保管庫の中にしまってある鍵で、1 件ずつ暗号化する
// ---------------------------------------------------------------------------

/** 32 バイトの鍵を、取り出し不可の AES-256-GCM 鍵として読み込む。 */
export function importDataKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function contextAad(context) {
  return encoder.encode([FORMAT, `v${FORMAT_VERSION}`, context].join('|'));
}

/**
 * `context` (用途と ID) を結び付けて暗号化する。
 * 保存された暗号文を別の記録のものと入れ替えられても、復号に失敗して気づけるようにするため。
 */
export async function sealBytes(key, plaintext, context) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: contextAad(context), tagLength: 128 }, key, plaintext),
  );
  return { iv, ct };
}

export async function openBytes(key, box, context) {
  if (box === null || typeof box !== 'object' || !isBytes(box.iv, IV_BYTES) || !isBytes(box.ct, TAG_BYTES, MAX_DATA_BYTES)) {
    throw new CorruptVaultError('bad sealed data');
  }
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: box.iv, additionalData: contextAad(context), tagLength: 128 },
        key,
        box.ct,
      ),
    );
  } catch {
    throw new CorruptVaultError('decryption failed');
  }
}

function isBytes(value, min, max = min) {
  return value instanceof Uint8Array && value.length >= min && value.length <= max;
}

/** 保管庫レコード(またはバックアップ)の形を検査する。おかしければ例外。 */
export function assertEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') throw new CorruptVaultError('envelope is not an object');
  if (envelope.format !== FORMAT) throw new UnsupportedVaultError('unknown format');
  if (envelope.version !== FORMAT_VERSION) throw new UnsupportedVaultError('unsupported version');

  const { kdf, wrappedKey, data } = envelope;
  if (kdf === null || typeof kdf !== 'object' || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new UnsupportedVaultError('unsupported key derivation');
  }
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < KDF_MIN_ITERATIONS || kdf.iterations > KDF_MAX_ITERATIONS) {
    throw new UnsupportedVaultError('key derivation cost out of range');
  }
  if (!isBytes(kdf.salt, 16, 64)) throw new CorruptVaultError('bad salt');
  if (
    wrappedKey === null ||
    typeof wrappedKey !== 'object' ||
    !isBytes(wrappedKey.iv, IV_BYTES) ||
    !isBytes(wrappedKey.ct, KEY_BYTES + TAG_BYTES)
  ) {
    throw new CorruptVaultError('bad wrapped key');
  }
  if (
    data === null ||
    typeof data !== 'object' ||
    !isBytes(data.iv, IV_BYTES) ||
    !isBytes(data.ct, TAG_BYTES, MAX_DATA_BYTES)
  ) {
    throw new CorruptVaultError('bad data');
  }
}

/** バックアップファイル用の JSON 文字列にする(中身は暗号化されたまま)。 */
export function envelopeToJson(envelope) {
  assertEnvelope(envelope);
  return JSON.stringify({
    format: FORMAT,
    version: FORMAT_VERSION,
    kdf: {
      name: envelope.kdf.name,
      hash: envelope.kdf.hash,
      iterations: envelope.kdf.iterations,
      salt: toBase64(envelope.kdf.salt),
    },
    wrappedKey: { iv: toBase64(envelope.wrappedKey.iv), ct: toBase64(envelope.wrappedKey.ct) },
    data: { iv: toBase64(envelope.data.iv), ct: toBase64(envelope.data.ct) },
  });
}

/** バックアップファイルの文字列を検査しながら読み込む。 */
export function envelopeFromJson(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_JSON_CHARS) {
    throw new CorruptVaultError('backup size out of range');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CorruptVaultError('backup is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new CorruptVaultError('backup is not an object');
  if (raw.format !== FORMAT) throw new UnsupportedVaultError('unknown format');
  if (raw.version !== FORMAT_VERSION) throw new UnsupportedVaultError('unsupported version');

  const kdf = raw.kdf ?? {};
  const wrappedKey = raw.wrappedKey ?? {};
  const data = raw.data ?? {};
  const envelope = {
    format: raw.format,
    version: raw.version,
    kdf: { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations, salt: fromBase64(kdf.salt) },
    wrappedKey: { iv: fromBase64(wrappedKey.iv), ct: fromBase64(wrappedKey.ct) },
    data: { iv: fromBase64(data.iv), ct: fromBase64(data.ct) },
  };
  assertEnvelope(envelope);
  return envelope;
}
