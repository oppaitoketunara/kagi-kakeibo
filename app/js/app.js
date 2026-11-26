// かぎ家計簿 — アプリ全体の進行役
//
// 画面の切り替え、保存、そして「いつロックするか」をここで決める。

import { clearToasts, closeAllDialogs, h, toast } from './dom.js';
import { MASKED_YEN, formatSignedYen, formatYen } from './format.js';
import { currentMonth, newId, setMaskAmounts } from './model.js';
import { brand, isStandalone, resetPassphraseFields } from './screens/common.js';
import { renderLock } from './screens/lock.js';
import { renderMain } from './screens/main.js';
import { renderSetup } from './screens/setup.js';
import { openStore } from './store.js';
import { ConflictError, LockedError, Vault } from './vault.js';

/** 開いたまま操作がないとき、この時間でロックする。 */
const IDLE_LOCK_MS = 3 * 60 * 1000;
/** ファイル選択や共有シートを開いているあいだ、「離れたらすぐロック」を猶予する最長時間。 */
const EXTERNAL_GRACE_MS = 2 * 60 * 1000;

const IDLE_NOTICE = 'しばらく操作がなかったため、ロックしました。';
const CONFLICT_NOTICE = 'ほかのタブでデータが変更されたため、ロックしました。もう一度解錠してください。';

export class App {
  constructor(root) {
    this.root = root;
    this.vault = null;
    this.tab = 'home';
    this.month = currentMonth();
    this.analysisType = 'expense';
    this.installPrompt = null;

    this.screenCleanup = null;
    this.instanceId = newId();
    this.channel = null;
    this.idleTimer = null;
    this.idleTouchedAt = 0;
    this.idleDeadline = null;
    this.hideTimer = null;
    this.lockDeadline = null;
    this.externalUntil = 0;
  }

  /** 復号済みの家計簿データ(ロック中は null)。 */
  get state() {
    return this.vault.state;
  }

  async start() {
    if (!window.isSecureContext || !globalThis.crypto?.subtle || !globalThis.indexedDB) {
      this.showFatal(
        'このアプリは、安全な接続 (https) で開いたときだけ動きます。',
        'アドレスが https:// で始まっているか確認してください。',
      );
      return;
    }
    let exists;
    try {
      this.vault = new Vault(await openStore());
      exists = await this.vault.exists();
    } catch {
      this.showFatal(
        'この環境では、データを端末に保存できません。',
        'プライベートブラウズを使っている場合は、通常のウィンドウで開き直してください。',
      );
      return;
    }
    this.installGuards();
    if (exists) this.showLock();
    else this.showSetup();
  }

  // -------------------------------------------------------------------------
  // 画面
  // -------------------------------------------------------------------------

  setScreen(node, cleanup = null) {
    if (this.screenCleanup !== null) this.screenCleanup();
    this.screenCleanup = cleanup;
    closeAllDialogs();
    this.root.replaceChildren(node);
    window.scrollTo(0, 0);
  }

  showFatal(title, detail) {
    this.setScreen(
      h('main', { class: 'auth auth-center' }, brand(), h('p', { class: 'fatal-title' }, title), h('p', { class: 'fatal-text' }, detail)),
    );
  }

  showSetup(notice = null) {
    const view = renderSetup(this, { notice });
    this.setScreen(view.node, view.cleanup);
  }

  showLock(notice = null) {
    const view = renderLock(this, { notice });
    this.setScreen(view.node, view.cleanup);
    view.focus();
  }

  /** 解錠または作成が済んだあとに呼ぶ。 */
  enter() {
    this.tab = 'home';
    this.month = currentMonth();
    this.analysisType = 'expense';
    this.idleTouchedAt = 0;
    this.idleDeadline = null;
    this.touchIdle();
    if (this.channel !== null) this.channel.postMessage({ type: 'unlocked', from: this.instanceId });
    // 端末の空き容量が減っても、ブラウザに勝手に消されにくくする(許可するかはブラウザが決める)
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
    this.setScreen(renderMain(this));
    // 鍵の計算を待つあいだにアプリを離れていた場合は、ここで改めて「離れた」ときの処理をする。
    // (離れた時点ではまだロック中だったので、何も起きていない)
    if (document.visibilityState === 'hidden') this.onHidden();
  }

  /** いまのタブを描き直す。スクロール位置と、操作していたボタンのフォーカスは保つ。 */
  render() {
    if (!this.vault.isUnlocked) return;
    const focusKey = document.activeElement?.dataset?.focusKey ?? null;
    const scrollY = window.scrollY;
    this.root.replaceChildren(renderMain(this));
    window.scrollTo(0, scrollY);
    if (focusKey !== null) {
      for (const candidate of this.root.querySelectorAll('[data-focus-key]')) {
        if (candidate.dataset.focusKey === focusKey) {
          candidate.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  navigate(tab) {
    if (this.tab !== tab) {
      this.tab = tab;
      this.render();
    }
    window.scrollTo(0, 0);
  }

  setMonth(month) {
    this.month = month;
    this.render();
  }

  /** 金額の表示。「金額を隠す」が有効なら伏せ字にする。 */
  money(amount, { signed = false } = {}) {
    if (this.state.settings.maskAmounts) return MASKED_YEN;
    return signed ? formatSignedYen(amount) : formatYen(amount);
  }

  async toggleMask() {
    setMaskAmounts(this.state, !this.state.settings.maskAmounts);
    this.render();
    await this.commit();
  }

  // -------------------------------------------------------------------------
  // 保存・ロック・消去
  // -------------------------------------------------------------------------

  /** いまの状態を暗号化して保存する。成功したら true。うまくいかなければ 1 回だけやり直す。 */
  async commit() {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.vault.save();
        return true;
      } catch (error) {
        if (error instanceof ConflictError) {
          this.lock(CONFLICT_NOTICE);
          return false;
        }
        if (error instanceof LockedError) return false;
      }
    }
    toast('保存できませんでした。この変更は、まだ端末に保存されていません。', { kind: 'error', duration: 8000 });
    return false;
  }

  lock(notice = null) {
    if (this.vault === null || !this.vault.isUnlocked) return;
    this.vault.lock();
    this.stopTimers();
    clearToasts();
    this.showLock(notice);
  }

  stopTimers() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.hideTimer);
    this.idleDeadline = null;
    this.lockDeadline = null;
    this.externalUntil = 0;
  }

  async wipe() {
    try {
      await this.vault.wipe();
    } catch {
      // 消去できなかった。保管庫は残っているので、ロック画面に戻す。
      this.stopTimers();
      clearToasts();
      this.showLock('消去できませんでした。もう一度お試しください。');
      return;
    }
    this.stopTimers();
    clearToasts();
    if (this.channel !== null) this.channel.postMessage({ type: 'wiped', from: this.instanceId });
    this.showSetup('すべてのデータを消去しました。');
  }

  /** ほかのタブで消去されたとき。こちらに残っている鍵と平文を手放し、いまの保管庫の有無に合わせた画面にする。 */
  async onWipedElsewhere() {
    this.vault.lock();
    this.stopTimers();
    clearToasts();
    let exists = false;
    try {
      exists = await this.vault.exists();
    } catch {
      exists = false;
    }
    if (exists) this.showLock('ほかのタブでデータが変更されたため、ロックしました。');
    else this.showSetup('ほかのタブで、すべてのデータが消去されました。');
  }

  /** ファイル選択や共有シートなど、アプリの外の画面を開く直前に呼ぶ。 */
  beginExternal() {
    this.externalUntil = Date.now() + EXTERNAL_GRACE_MS;
  }

  endExternal() {
    this.externalUntil = 0;
  }

  // -------------------------------------------------------------------------
  // 見張り: 画面を離れた・操作がない・ほかのタブで開かれた
  // -------------------------------------------------------------------------

  installGuards() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.onHidden();
      else this.onVisible();
    });
    window.addEventListener('pagehide', () => this.onHidden());
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.onVisible();
    });

    if (isStandalone()) {
      // ホーム画面のアプリとして動いているときは、アプリ切り替え画面や通知センターを開いた時点で内容を隠す
      window.addEventListener('blur', () => {
        resetPassphraseFields(false);
        this.setCover(this.vault.isUnlocked);
      });
      window.addEventListener('focus', () => {
        if (document.visibilityState === 'visible') this.setCover(false);
      });
    }

    for (const type of ['pointerdown', 'keydown', 'input', 'scroll']) {
      document.addEventListener(type, () => this.touchIdle(), { capture: true, passive: true });
    }
    // ページを操作しているなら、ファイル選択などの外の画面からはもう戻っている。猶予は残さない。
    // (猶予を始めるボタンでは、この処理のあとの click で改めて猶予が始まる)
    for (const type of ['pointerdown', 'keydown']) {
      document.addEventListener(type, () => this.endExternal(), { capture: true, passive: true });
    }

    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel('kagi-kakeibo');
      this.channel.addEventListener('message', (event) => {
        const data = event.data;
        if (data === null || typeof data !== 'object' || data.from === this.instanceId) return;
        if (data.type === 'unlocked') this.lock('ほかのタブで開かれたため、こちらはロックしました。');
        else if (data.type === 'wiped') this.onWipedElsewhere();
      });
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt = event;
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
    });

    // 画面キーボードの高さを CSS に伝える(入力シートの下端がキーボードに隠れないようにする)
    const viewport = window.visualViewport;
    if (viewport) {
      const update = () => {
        const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
        document.documentElement.style.setProperty('--keyboard', `${inset}px`);
      };
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      update();
    }
  }

  setCover(covered) {
    document.body.classList.toggle('is-covered', covered);
  }

  onHidden() {
    // 打ちかけのパスフレーズは、ロック中の画面でも残さない
    resetPassphraseFields(true);
    if (!this.vault.isUnlocked) return;
    this.setCover(true);
    const now = Date.now();
    const wait = Math.max(this.state.settings.autoLockSec * 1000, this.externalUntil - now);
    if (wait <= 0) {
      this.lock();
      return;
    }
    this.lockDeadline = now + wait;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.lock(), wait);
  }

  onVisible() {
    clearTimeout(this.hideTimer);
    // 隠れているあいだタイマーが止められていても、戻った時点の時刻で判定する
    if (this.vault.isUnlocked && this.lockDeadline !== null && Date.now() >= this.lockDeadline) this.lock();
    this.lockDeadline = null;
    this.endExternal();
    this.setCover(false);
    this.idleTouchedAt = 0;
    this.idleDeadline = null;
    this.touchIdle();
  }

  touchIdle() {
    if (this.vault === null || !this.vault.isUnlocked) return;
    const now = Date.now();
    // タイマーは端末のスリープ中は進まない。期限そのものを時刻で持ち、過ぎていたら操作を受け付ける前にロックする。
    if (this.idleDeadline !== null && now >= this.idleDeadline) {
      this.lock(IDLE_NOTICE);
      return;
    }
    if (now - this.idleTouchedAt < 5000) return;
    this.idleTouchedAt = now;
    this.idleDeadline = now + IDLE_LOCK_MS;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.lock(IDLE_NOTICE), IDLE_LOCK_MS);
  }
}
