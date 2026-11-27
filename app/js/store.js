// かぎ家計簿 — IndexedDB の薄いラッパー
//
// ここに保存するのは「暗号化済みの保管庫レコード」と「解錠失敗回数」だけ。
// 平文の家計簿データがこの層を通ることはない。

const STORE_NAME = 'kv';

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('failed to open database'));
    request.onblocked = () => reject(new Error('database is blocked'));
  });
}

/** データベースとの接続が切れていたことを表すエラーか(ブラウザ側の都合で、使っている途中でも起こりうる)。 */
function isConnectionError(error) {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidStateError' || error.name === 'UnknownError' || error.name === 'TransactionInactiveError')
  );
}

export async function openStore(name = 'kagi-kakeibo') {
  return new Store(name, await openDatabase(name));
}

class Store {
  #name;
  #db;

  constructor(name, db) {
    this.#name = name;
    this.#db = db;
  }

  /** 1 トランザクションで処理を実行する。完了(ディスクへの確定)を待って解決する。 */
  #transact(mode, body) {
    return new Promise((resolve, reject) => {
      let result;
      let failure = null;
      let tx;
      try {
        tx = this.#db.transaction(STORE_NAME, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      } catch (error) {
        reject(error);
        return;
      }
      const abort = (error) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          // すでに終了している
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('transaction aborted'));
      try {
        body(
          tx.objectStore(STORE_NAME),
          (value) => {
            result = value;
          },
          abort,
        );
      } catch (error) {
        abort(error);
      }
    });
  }

  /** 接続が切れていたら、開き直して 1 回だけやり直す。失敗したトランザクションは何も書き込んでいないので、やり直して問題ない。 */
  async #run(mode, body) {
    try {
      return await this.#transact(mode, body);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      try {
        this.#db.close();
      } catch {
        // すでに閉じている
      }
      this.#db = await openDatabase(this.#name);
      return this.#transact(mode, body);
    }
  }

  get(key) {
    return this.#run('readonly', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    });
  }

  put(key, value) {
    return this.#run('readwrite', (store) => {
      store.put(value, key);
    });
  }

  delete(key) {
    return this.#run('readwrite', (store) => {
      store.delete(key);
    });
  }

  /** 保存されているすべてのキー。 */
  keys() {
    return this.#run('readonly', (store, done) => {
      const request = store.getAllKeys();
      request.onsuccess = () => done(request.result);
    });
  }

  clear() {
    return this.#run('readwrite', (store) => {
      store.clear();
    });
  }

  /**
   * 読み出しと書き込みを 1 トランザクションで行う。
   * `change(現在の値)` が返した値を書き込み、例外を投げたら何も書かずに中断する。
   */
  update(key, change) {
    return this.#run('readwrite', (store, done, abort) => {
      const request = store.get(key);
      request.onsuccess = () => {
        let next;
        try {
          next = change(request.result);
        } catch (error) {
          abort(error);
          return;
        }
        if (next !== undefined) store.put(next, key);
        done(next);
      };
    });
  }

  close() {
    this.#db.close();
  }
}

export function deleteStore(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete database'));
    request.onblocked = () => resolve();
  });
}
