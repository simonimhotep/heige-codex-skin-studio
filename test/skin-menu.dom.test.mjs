import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredResponse,
  errorResponse,
  menuWindow,
  okResponse,
  sequenceFetch,
} from "./helpers/menu-window.mjs";

class SharedBroadcastChannel {
  static channels = new Map();
  static messages = [];

  static reset() {
    this.channels.clear();
    this.messages = [];
  }

  constructor(name) {
    this.name = name;
    this.listeners = new Set();
    this.closed = false;
    const channels = SharedBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    SharedBroadcastChannel.channels.set(name, channels);
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(value) {
    if (this.closed) throw new Error("channel closed");
    const message = structuredClone(value);
    SharedBroadcastChannel.messages.push(message);
    for (const peer of SharedBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const listener of peer.listeners) listener({ data: structuredClone(message) });
      });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    SharedBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function webpVp8x(width, height) {
  const result = Buffer.alloc(30);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(22, 4);
  result.write("WEBPVP8X", 8, "ascii");
  result.writeUInt32LE(10, 16);
  result.writeUIntLE(width - 1, 24, 3);
  result.writeUIntLE(height - 1, 27, 3);
  return result;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
  ]);
}

function installSuccessfulImagePipeline(page, {
  decodedWidth,
  decodedHeight,
  drawCalls = [],
} = {}) {
  const originalGetContext = page.window.HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = page.window.HTMLCanvasElement.prototype.toDataURL;
  page.window.FileReader = class ImmediateReader {
    readAsDataURL(file) {
      Promise.resolve(file.bytes ?? file.arrayBuffer()).then((value) => {
        this.result = "data:" + file.type + ";base64," + Buffer.from(value).toString("base64");
        queueMicrotask(() => this.onload?.());
      }, () => queueMicrotask(() => this.onerror?.()));
    }
    abort() { this.onabort?.(); }
  };
  page.window.Image = class ImmediateImage {
    constructor() {
      this.width = decodedWidth;
      this.height = decodedHeight;
      this.naturalWidth = decodedWidth;
      this.naturalHeight = decodedHeight;
    }
    set src(value) {
      this._src = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  };
  page.window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      drawImage: (_image, _x, _y, width, height) => drawCalls.push({ width, height }),
      getImageData: (_x, _y, width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    };
  };
  page.window.HTMLCanvasElement.prototype.toDataURL = () => {
    const factor = Math.max(
      1,
      Math.ceil(decodedWidth / 2048),
      Math.ceil(decodedHeight / 2048),
      Math.ceil(Math.sqrt((decodedWidth / 4_000_000) * decodedHeight)),
    );
    return "data:image/webp;base64," + webpVp8x(
      Math.max(1, Math.ceil(decodedWidth / factor)),
      Math.max(1, Math.ceil(decodedHeight / factor)),
    ).toString("base64");
  };
  return () => {
    page.window.HTMLCanvasElement.prototype.getContext = originalGetContext;
    page.window.HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  };
}

async function upload(page, { bytes, name = "upload.png", type = "image/png", size = bytes.byteLength, arrayBuffer } = {}) {
  const picker = page.document.querySelector('input[type="file"]');
  const file = {
    name,
    type,
    size,
    arrayBuffer: arrayBuffer ?? (async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    bytes,
  };
  Object.defineProperty(picker, "files", { configurable: true, value: [file] });
  picker.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  for (let index = 0; index < 24; index += 1) await page.flush();
}

test("switch exposes accessible state and permanent re-enable guidance", async (t) => {
  const page = await menuWindow({ persistenceEnabled: true, revision: 7 });
  t.after(() => page.close());
  assert.equal(page.switch.getAttribute("role"), "switch");
  assert.equal(page.switch.getAttribute("tabindex"), "0");
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.match(page.document.body.textContent, /关闭后本次继续使用；下次启动恢复原生界面/);
  assert.match(page.document.body.textContent, /HeiGe 皮肤启动器/);
  assert.match(page.document.body.textContent, /启用 HeiGe 皮肤/);
});

test("off is painted only after the controller ACK", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({ fetch: () => pending.promise });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  assert.equal(page.confirmation.hidden, false);
  await page.clickConfirmOff();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(page.switch.getAttribute("aria-busy"), "true");
  pending.resolve(okResponse({ persistenceEnabled: false, revision: 8 }));
  await page.flush();
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  assert.equal(page.switch.getAttribute("aria-busy"), "false");
});

test("cancel keeps persistence on without contacting the controller", async (t) => {
  let calls = 0;
  const page = await menuWindow({ fetch: async () => { calls += 1; } });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  await page.clickCancelOff();
  assert.equal(page.confirmation.hidden, true);
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(calls, 0);
});

test("network failure rolls back and shows a safe real error", async (t) => {
  const page = await menuWindow({ fetch: async () => { throw new Error("控制器不可用"); } });
  t.after(() => page.close());
  await page.disablePersistence();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.match(page.alert.textContent, /控制器不可用/);
  assert.equal(page.alert.getAttribute("role"), "alert");
});

test("a compensated enable failure syncs revision without painting on", async (t) => {
  const requests = [];
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 3,
    fetch: sequenceFetch([
      errorResponse(503, {
        code: "BACKGROUND_START_FAILED",
        message: "后台控制器启动失败，常驻仍为关闭",
        persistenceEnabled: false,
        revision: 5,
      }),
      okResponse({ persistenceEnabled: true, revision: 6 }),
    ], requests),
  });
  t.after(() => page.close());
  await page.enablePersistence();
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  assert.equal(page.controlRevision, 5);
  assert.match(page.alert.textContent, /后台控制器启动失败/);
  await page.enablePersistence();
  assert.equal(requests[1].revision, 5);
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
});

test("malformed and mismatched ACKs never change the painted state", async (t) => {
  for (const response of [
    okResponse({ persistenceEnabled: true, revision: 8 }),
    okResponse({ persistenceEnabled: false, revision: 7 }),
    { ok: true, status: 200, async json() { return { ok: true, persistenceEnabled: false, revision: "8" }; } },
  ]) {
    const page = await menuWindow({ fetch: async () => response });
    t.after(() => page.close());
    await page.disablePersistence();
    assert.equal(page.switch.getAttribute("aria-checked"), "true");
    assert.match(page.alert.textContent, /响应无效/);
  }
});

test("Enter and Space operate the switch while repeated pending input is ignored", async (t) => {
  const pending = deferredResponse();
  let calls = 0;
  const page = await menuWindow({
    persistenceEnabled: false,
    fetch: () => { calls += 1; return pending.promise; },
  });
  t.after(() => page.close());
  await page.keyPersistenceSwitch("Enter");
  await page.keyPersistenceSwitch(" ");
  assert.equal(calls, 1);
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  pending.resolve(okResponse({ persistenceEnabled: true, revision: 8 }));
  await page.flush();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
});

test("persistence state and token are never written to localStorage", async (t) => {
  const page = await menuWindow({ persistenceEnabled: false, revision: 2 });
  t.after(() => page.close());
  await page.enablePersistence();
  const entries = Array.from({ length: page.window.localStorage.length }, (_, index) => {
    const key = page.window.localStorage.key(index);
    return [key, page.window.localStorage.getItem(key)];
  });
  assert.equal(entries.some(([key, value]) => /persist|token|control/i.test(`${key}:${value}`)), false);
  const controlToken = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(entries.some(([, value]) => value.includes(controlToken)), false);
});

test("reinjection disposes the previous generation and invalidates its API", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const firstRuntime = page.window.__heigeCodexSkinRuntime;
  const firstApi = page.window.__heigeCodexSkin;
  const secondRuntime = await page.injectAgain();
  assert.equal(firstRuntime.signal.aborted, true);
  assert.equal(firstRuntime.channel.closed, true);
  assert.notEqual(secondRuntime.generation, firstRuntime.generation);
  assert.throws(() => firstApi.setTheme("miku-488137"), /disposed/i);
  assert.equal(page.document.querySelectorAll("#heige-codex-skin-menu").length, 1);
});

test("runtime disposal is idempotent and removes only its owned globals and DOM", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const runtime = page.window.__heigeCodexSkinRuntime;
  assert.equal(runtime.dispose(), true);
  assert.equal(runtime.dispose(), false);
  assert.equal(runtime.signal.aborted, true);
  assert.equal(runtime.channel.closed, true);
  assert.equal(page.document.getElementById("heige-codex-skin-menu"), null);
  assert.equal(page.document.getElementById("heige-codex-skin-style"), null);
  assert.equal(page.window.__heigeCodexSkin, undefined);
  assert.equal(page.window.__heigeCodexSkinRuntime, undefined);
});

test("a stale persistence response cannot mutate the new generation", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({ fetch: () => pending.promise });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  await page.clickConfirmOff();
  const firstRuntime = page.window.__heigeCodexSkinRuntime;
  await page.injectAgain();
  pending.resolve(okResponse({ persistenceEnabled: false, revision: 8 }));
  await page.flush();
  assert.equal(firstRuntime.signal.aborted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.window.__heigeCodexSkinRuntime.status())), {
    generation: page.window.__heigeCodexSkinRuntime.generation,
    themeId: "miku-488137",
    menu: true,
    mode: "active",
    persistenceEnabled: true,
    revision: 7,
  });
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(page.alert.hidden, true);
});

test("a stale Image callback rejects and cannot overwrite the new generation", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const images = [];
  page.window.Image = class DelayedImage {
    constructor() {
      this.width = 80;
      this.height = 40;
      this.onload = null;
      this.onerror = null;
      this.src = "";
      images.push(this);
    }
  };
  const oldApi = page.window.__heigeCodexSkin;
  const imported = oldApi.importFromDataUrl("data:image/png;base64," + png(80, 40).toString("base64"), "old");
  const rejected = assert.rejects(imported, (error) => error.name === "AbortError" && /disposed/i.test(error.message));
  const staleOnload = images[0].onload;
  await page.injectAgain();
  staleOnload();
  await rejected;
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("dispose aborts an active FileReader and its stale callback becomes inert", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let reader;
  page.window.FileReader = class DelayedReader {
    constructor() {
      reader = this;
      this.result = "data:image/png;base64,old";
      this.abortCalls = 0;
    }
    readAsDataURL() {}
    abort() { this.abortCalls += 1; }
  };
  const picker = page.document.querySelector('input[type="file"]');
  Object.defineProperty(picker, "files", {
    configurable: true,
    value: [{
      name: "old.png",
      type: "image/png",
      size: png(80, 40).byteLength,
      arrayBuffer: async () => {
        const bytes = png(80, 40);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    }],
  });
  picker.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.flush();
  const staleOnload = reader.onload;
  await page.injectAgain();
  assert.equal(reader.abortCalls, 1);
  staleOnload();
  await page.flush();
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("browser upload rejects byte and dimension bombs before decode", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  let readerCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  page.window.FileReader = class CountingReader { constructor() { readerCalls += 1; } };

  await upload(page, {
    bytes: png(10, 10),
    size: (8 * 1024 * 1024) + 1,
  });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /8 MiB|8388608/);
  assert.equal(page.document.querySelector('[data-heige-role="menu-panel"]').style.display, "block");
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);

  await upload(page, { bytes: png(8000, 8000, 1024) });
  assert.match(alert.textContent, /像素|pixel/i);
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
});

test("browser upload rejects MIME mismatch before FileReader or Image", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  let readerCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  page.window.FileReader = class CountingReader { constructor() { readerCalls += 1; } };
  await upload(page, { bytes: png(100, 100), name: "wrong.jpg", type: "image/jpeg" });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /MIME|JPEG|PNG/i);
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);
});

test("browser upload timeout settles visibly without decoding", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  const originalSetTimeout = page.window.setTimeout;
  const originalClearTimeout = page.window.clearTimeout;
  let timerId = 0;
  page.window.setTimeout = (callback) => {
    timerId += 1;
    queueMicrotask(callback);
    return timerId;
  };
  page.window.clearTimeout = () => {};
  try {
    await upload(page, {
      bytes: png(100, 100),
      arrayBuffer: () => new Promise(() => {}),
    });
    const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
    assert.match(alert.textContent, /超时|timeout/i);
    assert.equal(alert.getAttribute("aria-busy"), "false");
    assert.equal(imageCalls, 0);
  } finally {
    page.window.setTimeout = originalSetTimeout;
    page.window.clearTimeout = originalClearTimeout;
  }
});

test("validated upload scales within both canvas budgets and persists", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 4000,
    decodedHeight: 1000,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(4000, 1000), name: "wide.png" });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.equal(alert.getAttribute("aria-busy"), "false");
  assert.match(alert.textContent, /已应用并保存/);
  assert.deepEqual(drawCalls[0], { width: 2000, height: 500 });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.match(page.window.localStorage.getItem("heigeCodexCustomTheme"), /data:image\/webp/);
});

test("vertical boundary images keep the palette canvas below 48 pixels per side", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 81,
    decodedHeight: 8100,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(81, 8100), name: "vertical.png" });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.ok(drawCalls[1].width <= 48);
  assert.ok(drawCalls[1].height <= 48);
});

for (const fixture of [
  { name: "photo.jpg", type: "image/jpeg", bytes: jpeg(320, 180), width: 320, height: 180 },
  { name: "photo.webp", type: "image/webp", bytes: webpVp8x(320, 180), width: 320, height: 180 },
]) {
  test("browser upload validates " + fixture.type + " headers before decode", async (t) => {
    const page = await menuWindow();
    t.after(() => page.close());
    const restore = installSuccessfulImagePipeline(page, {
      decodedWidth: fixture.width,
      decodedHeight: fixture.height,
    });
    t.after(restore);
    await upload(page, fixture);
    assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
    assert.match(
      page.document.querySelector('[data-heige-role="upload-alert"]').textContent,
      /已应用并保存/,
    );
  });
}

test("browser upload derives MIME from a valid extension when File.type is empty", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 100,
    decodedHeight: 100,
  });
  t.after(restore);
  await upload(page, { bytes: png(100, 100), name: "photo.png", type: "" });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.match(
    page.document.querySelector('[data-heige-role="upload-alert"]').textContent,
    /已应用并保存/,
  );
});

test("decoded dimensions must match the validated header before canvas allocation", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 101,
    decodedHeight: 100,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(100, 100) });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /尺寸与 header 不一致/);
  assert.equal(drawCalls.length, 0);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
});

test("storage quota failure keeps only the current generation and says restart will not retain it", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 100,
    decodedHeight: 100,
  });
  t.after(restore);
  const originalSetItem = page.window.localStorage.setItem.bind(page.window.localStorage);
  Object.defineProperty(page.window.localStorage, "setItem", {
    configurable: true,
    value(key, value) {
      if (key === "heigeCodexCustomTheme") throw new page.window.DOMException("quota", "QuotaExceededError");
      return originalSetItem(key, value);
    },
  });
  t.after(() => {
    Object.defineProperty(page.window.localStorage, "setItem", {
      configurable: true,
      value: originalSetItem,
    });
  });
  await upload(page, { bytes: png(100, 100) });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /本次已应用.*重启后不会保留/);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("theme native hidden and persistence ACK synchronize to a second renderer", async (t) => {
  SharedBroadcastChannel.reset();
  const entries = [
    {
      id: "miku-488137",
      name: "Miku 488137",
      accent: "#19c9e5",
      css: "html { color: #123456; }",
    },
    {
      id: "night-city",
      name: "Night City",
      accent: "#4455aa",
      css: "html { color: #eeeeee; }",
    },
  ];
  const left = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel, entries });
  const right = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel, entries });
  t.after(() => { left.close(); right.close(); SharedBroadcastChannel.reset(); });

  await left.pickTheme("night-city");
  await right.flush();
  assert.equal(right.themeId, "night-city");
  assert.equal(right.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");

  await left.pickNative();
  await right.flush();
  assert.equal(right.themeId, null);

  await left.hideMenu();
  await right.flush();
  assert.equal(right.hidden, true);
  assert.equal(right.window.localStorage.getItem("heigeCodexSkinMenuHidden"), "1");

  await left.disablePersistence();
  await right.flush();
  assert.equal(right.switch.getAttribute("aria-checked"), "false");
  assert.equal(right.controlRevision, left.controlRevision);
  const persistenceMessage = SharedBroadcastChannel.messages.find(({ kind }) => kind === "persistence");
  assert.deepEqual(Object.keys(persistenceMessage).sort(), [
    "kind", "schemaVersion", "senderGeneration", "sequence", "value",
  ]);
  assert.doesNotMatch(JSON.stringify(persistenceMessage), /token|endpoint|43123/i);
});

test("broadcast protocol rejects loops stale sequences unknown fields and malformed values", async (t) => {
  SharedBroadcastChannel.reset();
  const page = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { page.close(); SharedBroadcastChannel.reset(); });
  const attacker = new SharedBroadcastChannel("heige-codex-skin-v2");
  t.after(() => attacker.close());
  const senderGeneration = "a".repeat(32);

  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 2,
    kind: "theme",
    value: "__heige_native__",
  });
  await page.flush();
  assert.equal(page.themeId, null);

  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 1,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 3,
    kind: "menu-hidden",
    value: "yes",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 4,
    kind: "theme",
    value: "miku-488137",
    token: "must-not-be-accepted",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: page.window.__heigeCodexSkin.generation,
    sequence: 99,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 2,
    senderGeneration: "b".repeat(32),
    sequence: 1,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: "c".repeat(32),
    sequence: 1,
    kind: "unknown",
    value: true,
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: "d".repeat(32),
    sequence: 1,
    kind: "persistence",
    value: { enabled: false, revision: 99, endpoint: "http://attacker.invalid" },
  });
  await page.flush();
  assert.equal(page.themeId, null, "stale and extra-field messages are inert");
  assert.equal(page.hidden, false, "malformed hidden value is inert");
  assert.equal(SharedBroadcastChannel.messages.length, 8, "remote changes never echo back");
});

test("storage compatibility events update theme and hidden state without broadcast loops", async (t) => {
  SharedBroadcastChannel.reset();
  const page = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { page.close(); SharedBroadcastChannel.reset(); });
  const storageEvent = (key, newValue) => {
    const event = new page.window.Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      newValue: { value: newValue },
    });
    page.window.dispatchEvent(event);
  };
  storageEvent("heigeCodexSkinSelected", "__heige_native__");
  storageEvent("heigeCodexSkinMenuHidden", "1");
  await page.flush();
  assert.equal(page.themeId, null);
  assert.equal(page.hidden, true);
  assert.equal(SharedBroadcastChannel.messages.length, 0);
});
