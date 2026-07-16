import { Window } from "happy-dom";

import { buildSkinMenuScript } from "../../src/skin-menu.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 7).toString("base64url");

export function deferredResponse() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

export function okResponse({ persistenceEnabled, revision }) {
  return jsonResponse(200, { ok: true, persistenceEnabled, revision });
}

export function errorResponse(status, body) {
  return jsonResponse(status, { ok: false, ...body });
}

export function sequenceFetch(responses, requests = []) {
  let index = 0;
  return async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (index >= responses.length) throw new Error("没有更多测试响应");
    const response = responses[index];
    index += 1;
    return typeof response === "function" ? response() : response;
  };
}

async function flushMicrotasks(window) {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

export async function menuWindow({
  persistenceEnabled = true,
  revision = 7,
  BroadcastChannelClass,
  entries = [{
    id: "miku-488137",
    name: "Miku 488137",
    accent: "#19c9e5",
    css: "html { color: #123456; }",
  }],
  fetch = async () => okResponse({
    persistenceEnabled: !persistenceEnabled,
    revision: revision + 1,
  }),
} = {}) {
  const window = new Window({ url: "app://-/index.html" });
  window.fetch = fetch;
  if (BroadcastChannelClass) window.BroadcastChannel = BroadcastChannelClass;
  const buildOptions = {
    styleId: "heige-codex-skin-style",
    menuId: "heige-codex-skin-menu",
    activeId: "miku-488137",
    entries,
    control: {
      available: true,
      persistenceEnabled,
      revision,
      endpoint: "http://127.0.0.1:43123/v1/persistence",
      token: CONTROL_TOKEN,
      launcherName: "HeiGe 皮肤启动器",
    },
  };
  const inject = () => window.eval(buildSkinMenuScript(buildOptions));
  inject();

  const query = (role) => window.document.querySelector(`[data-heige-role="${role}"]`);
  const page = {
    window,
    document: window.document,
    get trigger() { return window.document.querySelector("#heige-codex-skin-menu > button"); },
    get panel() { return query("menu-panel"); },
    get switch() { return query("persistence-switch"); },
    get confirmation() { return query("persistence-confirmation"); },
    get cancel() { return query("persistence-cancel"); },
    get confirm() { return query("persistence-confirm"); },
    get alert() { return query("persistence-alert"); },
    get themeId() { return window.document.documentElement.dataset.heigeCodexSkin ?? null; },
    get hidden() {
      return window.document.querySelector("#heige-codex-skin-menu > button").textContent === "";
    },
    get controlRevision() {
      return window.__heigeCodexSkin.getPersistenceState().revision;
    },
    async clickPersistenceSwitch() {
      query("persistence-switch").click();
      await flushMicrotasks(window);
    },
    async clickConfirmOff() {
      query("persistence-confirm").click();
      await flushMicrotasks(window);
    },
    async clickCancelOff() {
      query("persistence-cancel").click();
      await flushMicrotasks(window);
    },
    async enablePersistence() {
      await this.clickPersistenceSwitch();
      await flushMicrotasks(window);
    },
    async disablePersistence() {
      await this.clickPersistenceSwitch();
      await this.clickConfirmOff();
      await flushMicrotasks(window);
    },
    async keyPersistenceSwitch(key) {
      query("persistence-switch").dispatchEvent(new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
      await flushMicrotasks(window);
    },
    async pickTheme(id) {
      window.__heigeCodexSkin.setTheme(id);
      await flushMicrotasks(window);
    },
    async pickNative() {
      window.__heigeCodexSkin.clearTheme();
      await flushMicrotasks(window);
    },
    async hideMenu() {
      window.__heigeCodexSkin.setHidden(true);
      await flushMicrotasks(window);
    },
    async flush() {
      await flushMicrotasks(window);
    },
    async injectAgain() {
      inject();
      await flushMicrotasks(window);
      return window.__heigeCodexSkinRuntime;
    },
    close() {
      window.__heigeCodexSkinRuntime?.dispose?.();
      window.close();
    },
  };
  return page;
}
