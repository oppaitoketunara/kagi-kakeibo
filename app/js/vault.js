// かぎ家計簿 — 保管庫
//
// 家計簿データ全体を 1 つの暗号文として IndexedDB に保存する。
// 平文のデータと鍵は「解錠中」のあいだだけメモリ上にあり、lock() で参照を手放す。

import {
  FORMAT,
  FORMAT_VERSION,
  CorruptVaultError,
  WrongPassphraseError,
  assertEnvelope,
  createKeys,
  decryptData,
  encryptData,
  envelopeFromJson,
  envelopeToJson,
  randomBytes,
  unlockKeys,
} from './crypto.js';
import { validateState } from './model.js';

const VAULT_KEY = 'vault';
const THROTTLE_KEY = 'throttle';

/** 暗号文の長さから記録件数を推測しにくくするため、平文をこの単位に切り上げる。 */
const PAD_BLOCK = 4096;

/** この回数までは待ち時間なしで試せる。 */
export const FREE_ATTEMPTS = 4;
const DELAYS_SEC = [30, 60, 120, 300, 900, 1800, 3600];

export class LockedError extends Error {
  constructor() {
    super('vault is locked');
    this.name = 'LockedError';
  }
}

export class NoVaultError extends Error {
  constructor() {
    super('vault does not exist');
    this.name = 'NoVaultError';
  }
}

export class ConflictError extends Error {
  constructor() {
    super('vault was changed elsewhere');
    this.name = 'ConflictError';
  }
}

export class ThrottledError extends Error {
  constructor(retryAt) {
    super('too many failed attempts');
    this.name = 'ThrottledError';
    this.retryAt = retryAt;
  }
}

/** 連続失敗回数に応じた待ち時間。5 回目から 30 秒、以後のびていき最長 1 時間。 */
export function throttleDelayMs(failures) {
  if (failures <= FREE_ATTEMPTS) return 0;
  return DELAYS_SEC[Math.min(failures - FREE_ATTEMPTS, DELAYS_SEC.length) - 1] * 1000;
}

const encoder = new TextEncoder();

export function encodePayload(value) {
  const json = encoder.encode(JSON.stringify(value));
  const blocks = Math.max(1, Math.ceil(json.length / PAD_BLOCK));
  const padded = new Uint8Array(blocks * PAD_BLOCK).fill(0x20); // 末尾の空白は JSON として無視される
  padded.set(json);
  json.fill(0);
  return padded;
}

export function decodePayload(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CorruptVaultError('payload is not valid JSON');
  }
}

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function toRecord(session, data, tag) {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    kdf: session.kdf,
    wrappedKey: session.wrappedKey,
    data,
    // 保存のたびに変わる目印。別のタブが先に書き換えていないかを確かめるために使う。
    tag,
  };
}

export class Vault {
  #store;
  #now;
  /** 解錠中だけ存在する: { dek, kdf, wrappedKey, tag, state } */
  #session = null;
  /** 保管庫への読み書きを 1 つずつ順番に実行するための列 */
  #queue = Promise.resolve();

  constructor(store, { now = () => Date.now() } = {}) {
    this.#store = store;
    this.#now = now;
  }

  get isUnlocked() {
    return this.#session !== null;
  }

  /** 復号済みの家計簿データ。ロック中は null。 */
  get state() {
    return this.#session === null ? null : this.#session.state;
  }

  get kdfIterations() {
    return this.#session === null ? null : this.#session.kdf.iterations;
  }

  #enqueue(task) {
    const run = this.#queue.then(task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readEnvelope() {
    const envelope = await this.#store.get(VAULT_KEY);
    if (envelope === undefined) throw new NoVaultError();
    assertEnvelope(envelope);
    return envelope;
  }

  /**
   * パスフレーズを確かめて DEK を返す。`header` は { kdf, wrappedKey } を持つもの(保存レコードか、解錠中の鍵情報)。
   *
   * 待ち時間の確認と「失敗 1 回」の記録を、試す前に 1 つのトランザクションで行い、成功したら記録を消す。
   * こうしておけば、複数のタブから同時に試しても待ち時間をすり抜けられない。
   */
  async #authenticate(passphrase, header) {
    const now = this.#now();
    let blockedUntil = 0;
    const record = await this.#store.update(THROTTLE_KEY, (current) => {
      if (current !== undefined) {
        // 端末の時計が巻き戻されていたら、待ち時間を数え直す
        const rolledBack = now < current.setAt;
        const retryAt = rolledBack ? now + throttleDelayMs(current.failures) : current.retryAt;
        if (retryAt > now) {
          blockedUntil = retryAt;
          return rolledBack ? { failures: current.failures, setAt: now, retryAt } : undefined;
        }
      }
      const failures = (current?.failures ?? 0) + 1;
      return { failures, setAt: now, retryAt: now + throttleDelayMs(failures) };
    });
    if (blockedUntil > 0) throw new ThrottledError(blockedUntil);

    let dek;
    try {
      dek = await unlockKeys(passphrase, header);
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        error.failures = record.failures;
        error.retryAt = record.retryAt > now ? record.retryAt : 0;
      }
      throw error;
    }
    await this.#store.delete(THROTTLE_KEY);
    return dek;
  }

  exists() {
    return this.#enqueue(async () => (await this.#store.get(VAULT_KEY)) !== undefined);
  }

  /** 解錠の待ち時間の状況。`retryAt` は待ちがなければ 0。 */
  throttleState() {
    return this.#enqueue(async () => {
      const record = await this.#store.get(THROTTLE_KEY);
      if (record === undefined) return { failures: 0, retryAt: 0 };
      const now = this.#now();
      const retryAt = now < record.setAt ? now + throttleDelayMs(record.failures) : record.retryAt;
      return { failures: record.failures, retryAt: retryAt > now ? retryAt : 0 };
    });
  }

  /** 新しい保管庫を作って解錠状態にする。 */
  create(passphrase, initialState) {
    return this.#enqueue(async () => {
      const state = validateState(initialState);
      const keys = await createKeys(passphrase);
      const session = { dek: keys.dek, kdf: keys.kdf, wrappedKey: keys.wrappedKey, tag: randomBytes(16), state };
      const plaintext = encodePayload(state);
      try {
        const data = await encryptData(session.dek, plaintext);
        await this.#store.update(VAULT_KEY, (current) => {
          if (current !== undefined) throw new ConflictError();
          return toRecord(session, data, session.tag);
        });
      } finally {
        plaintext.fill(0);
      }
      await this.#store.delete(THROTTLE_KEY);
      this.#session = session;
    });
  }

  /** パスフレーズで解錠する。 */
  unlock(passphrase) {
    return this.#enqueue(async () => {
      const envelope = await this.#readEnvelope();
      const dek = await this.#authenticate(passphrase, envelope);
      const state = validateState(decodePayload(await decryptData(dek, envelope.data)));
      this.#session = { dek, kdf: envelope.kdf, wrappedKey: envelope.wrappedKey, tag: envelope.tag, state };
    });
  }

  /** 鍵と平文データへの参照を手放す。実行待ちの保存は、最後まで書き込まれる。 */
  lock() {
    this.#session = null;
  }

  /** 現在の状態を暗号化して保存する。呼んだ時点の内容が確定して書き込まれる。 */
  save() {
    const session = this.#session;
    if (session === null) return Promise.reject(new LockedError());
    const plaintext = encodePayload(session.state);
    return this.#enqueue(async () => {
      try {
        const data = await encryptData(session.dek, plaintext);
        const tag = randomBytes(16);
        await this.#store.update(VAULT_KEY, (current) => {
          if (current === undefined || !sameBytes(current.tag, session.tag)) throw new ConflictError();
          return toRecord(session, data, tag);
        });
        session.tag = tag;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  /**
   * 状態をまるごと置き換えて保存する(バックアップからの復元用)。
   * 書き込みに失敗したら、メモリ上の内容も元に戻す(画面とディスクが食い違ったままにしない)。
   */
  replaceState(nextState) {
    const session = this.#session;
    if (session === null) return Promise.reject(new LockedError());
    let next;
    try {
      next = validateState(nextState);
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = session.state;
    session.state = next;
    return this.save().catch((error) => {
      if (session.state === next) session.state = previous;
      throw error;
    });
  }

  /**
   * パスフレーズが正しいか確かめる(重要な操作の前の再確認用)。違えば例外。
   * ディスクの内容ではなく、いま解錠している保管庫そのものの鍵情報で確かめる。
   */
  verifyPassphrase(passphrase) {
    const session = this.#session;
    if (session === null) return Promise.reject(new LockedError());
    return this.#enqueue(async () => {
      await this.#authenticate(passphrase, session);
    });
  }

  /**
   * パスフレーズを変更する。
   * 鍵を包み直すだけでなく、ソルトもデータ鍵も作り直してデータ全体を暗号化し直す。
   */
  changePassphrase(currentPassphrase, nextPassphrase) {
    const session = this.#session;
    if (session === null) return Promise.reject(new LockedError());
    return this.#enqueue(async () => {
      await this.#authenticate(currentPassphrase, session);
      const keys = await createKeys(nextPassphrase);
      const next = { dek: keys.dek, kdf: keys.kdf, wrappedKey: keys.wrappedKey };
      const plaintext = encodePayload(session.state);
      try {
        const data = await encryptData(next.dek, plaintext);
        const tag = randomBytes(16);
        await this.#store.update(VAULT_KEY, (current) => {
          if (current === undefined || !sameBytes(current.tag, session.tag)) throw new ConflictError();
          return toRecord(next, data, tag);
        });
        session.dek = next.dek;
        session.kdf = next.kdf;
        session.wrappedKey = next.wrappedKey;
        session.tag = tag;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  /** 保存されている暗号文をそのままバックアップ用の JSON 文字列にする。 */
  exportBackup() {
    return this.#enqueue(async () => envelopeToJson(await this.#readEnvelope()));
  }

  /** 保管庫と失敗回数の記録をすべて消す。 */
  wipe() {
    this.lock();
    return this.#enqueue(async () => {
      // 消去より前から順番待ちだった解錠が、鍵を持ち込んだままにならないようにする
      this.#session = null;
      await this.#store.clear();
    });
  }
}

/** バックアップファイルを復号し、検査済みの状態を返す。保管庫には触れない。 */
export async function readBackup(text, passphrase) {
  const envelope = envelopeFromJson(text);
  const dek = await unlockKeys(passphrase, envelope);
  return validateState(decodePayload(await decryptData(dek, envelope.data)));
}
