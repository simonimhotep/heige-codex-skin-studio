import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkinMenuScript,
  CSS_SENTINELS,
  previewFromGeneratedCss,
} from "../src/skin-menu.mjs";
import { THEME_CENTER_STYLE } from "../src/theme-center-style.mjs";

const base = {
  styleId: "heige-codex-skin-style",
  menuId: "heige-codex-skin-menu",
};

test("extracts one validated hero data URL from generated theme CSS", () => {
  const hero = "data:image/webp;base64,QUJDRA==";
  const css = `#root { background:
    linear-gradient(#fff, transparent),
    url(${JSON.stringify(hero)}) right center / cover no-repeat fixed !important;
  }`;
  assert.equal(previewFromGeneratedCss(css), hero);
  assert.equal(previewFromGeneratedCss("html { color: red; }"), null);
  assert.equal(previewFromGeneratedCss("#root{background:url(https://example.com/x.webp)}"), null);
});

test("embeds validated theme colors without adding a duplicate preview field", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "miku-488137",
    entries: [{
      id: "miku-488137",
      name: "Miku",
      accent: "#19c9e5",
      colors: {
        accent: "#19c9e5",
        secondary: "#ed6ec1",
        surface: "#f5f6fc",
        text: "#122c60",
      },
      css: `#root{background:url("data:image/webp;base64,QUJDRA==")}`,
    }],
  });
  assert.match(script, /"secondary":"#ed6ec1"/);
  assert.doesNotMatch(script, /"preview":/);
});

test("ships the responsive Aurora Gallery dialog without animation", () => {
  assert.match(THEME_CENTER_STYLE, /data-heige-role="theme-center"/);
  assert.match(THEME_CENTER_STYLE, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(THEME_CENTER_STYLE, /@media \(max-width:979px\)/);
  assert.match(THEME_CENTER_STYLE, /@media \(max-width:679px\)/);
  assert.doesNotMatch(THEME_CENTER_STYLE, /https?:\/\//);
  assert.doesNotMatch(THEME_CENTER_STYLE, /@keyframes|animation:/);
});

test("embeds every theme and the active id as JSON data", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "miku-488137",
    entries: [
      { id: "miku-488137", name: "Miku 488137", accent: "#19c9e5", css: "#root{}" },
      { id: "night-city", name: "Night City", accent: "#7a5cff", css: "#root{background:black}" },
    ],
  });

  assert.match(script, /"miku-488137"/);
  assert.match(script, /"night-city"/);
  assert.match(script, /"activeId":"miku-488137"/);
  assert.match(script, /heige-codex-skin-menu/);
  assert.match(script, /\\u539f\\u751f\\u754c\\u9762/);
});

test("keeps hostile names as inert JSON instead of executable code", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "evil",
    entries: [{ id: "evil", name: '";alert(1);//', accent: "not-a-color", css: "#root{}" }],
  });

  assert.ok(script.includes(String.raw`\";alert(1);//`), "name must stay inside a JSON string");
  assert.match(script, /"accent":"#24c9d7"/);
});

test("ships the custom upload flow with the sentinel css template", () => {
  const cssTemplate = `#root { background: url("${CSS_SENTINELS.hero}"); color: ${CSS_SENTINELS.text}; }`;
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    cssTemplate,
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });

  assert.match(script, /heigeCodexCustomTheme/, "custom theme must persist via localStorage");
  assert.match(script, /custom-upload/);
  assert.match(script, /HEIGEHEROSENTINEL/, "css template must ride along for client-side builds");
  assert.match(script, /extractPalette/, "palette extraction must ship");
  assert.match(script, /__heigeCodexSkin/, "scriptable hook must be exposed");
  assert.match(script, /deleteCustom/, "custom theme must be deletable");
  assert.match(script, /removeItem/, "delete must clear persisted storage");
});

test("centers the menu at the top clear of window controls on every platform", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });

  assert.match(script, /left:\s*50%/, "menu must anchor to the horizontal center");
  assert.match(script, /translateX\(-50%\)/, "menu must center on its own width");
  assert.doesNotMatch(script, /right:1?\d+px/, "no corner offset may remain");
  assert.match(script, /-webkit-app-region:no-drag/, "controls must opt out of the titlebar drag region");
});

test("ships a hide control that collapses the button into a dot", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });

  assert.match(script, /\\u9690\\u85cf\\u6b64\\u6309\\u94ae/, "hide row label must ship");
  assert.match(script, /heigeCodexSkinMenuHidden/, "hidden state must persist via localStorage");
  assert.match(script, /width:10px;height:10px/, "mini dot must stay tiny");
  assert.match(script, /setHidden/, "hide must be scriptable");
});

test("rejects empty menus and unknown active themes", () => {
  assert.throws(() => buildSkinMenuScript({ ...base, activeId: null, entries: [] }));
  assert.throws(() =>
    buildSkinMenuScript({
      ...base,
      activeId: "missing",
      entries: [{ id: "real", name: "Real", accent: "#123456", css: "#root{}" }],
    }),
  );
});

test("keeps local selection metadata for compatibility events and quick images", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(script, /heigeCodexSkinSelected/, "selection key must ship");
  assert.match(script, /readSelected\(\)/, "quick-image restore must read persisted selection");
  assert.match(script, /writeSelected/, "picks must persist");
});

test("guards script API against use after the skin is removed", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(script, /style\.isConnected/, "mutations must no-op once detached");
});

test("clamps degenerate upload dimensions and reports failures", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(script, /width: Math\.max\(1, Math\.ceil\(width \/ factor\)\)/, "width must have a floor");
  assert.match(script, /height: Math\.max\(1, Math\.ceil\(height \/ factor\)\)/, "height must have a floor");
  assert.match(script, /reader\.onerror/, "file read errors must be handled");
});

test("preferStored is encoded only for background quick-image recovery", () => {
  const stored = buildSkinMenuScript({
    ...base, activeId: "a", preferStored: true,
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(stored, /"preferStored":true/, "background repair may restore a local quick image");
  const explicit = buildSkinMenuScript({
    ...base, activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(explicit, /"preferStored":false/, "explicit apply must let activeId win");
});

test("accepts only the narrow canonical loopback control descriptor", () => {
  const token = Buffer.alloc(32, 7).toString("base64url");
  const input = {
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
    control: {
      available: true,
      persistenceEnabled: true,
      revision: 4,
      endpoint: "http://127.0.0.1:43123/v1/persistence",
      token,
      launcherName: "HeiGe 皮肤启动器",
    },
  };
  const script = buildSkinMenuScript(input);
  assert.match(script, /data\.control\?\.available/);
  assert.match(script, /"persistenceEnabled":true/);

  for (const control of [
    { ...input.control, endpoint: "http://localhost:43123/v1/persistence" },
    { ...input.control, endpoint: "http://127.0.0.1:43123/v1/persistence?command=open" },
    { ...input.control, token: "not-canonical" },
    { ...input.control, revision: -1 },
    { ...input.control, launcherName: "其他启动器" },
    { ...input.control, command: "open" },
  ]) {
    assert.throws(() => buildSkinMenuScript({ ...input, control }), /控制描述/);
  }
});
