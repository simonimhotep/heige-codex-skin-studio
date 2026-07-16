import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinCss } from "../src/skin-css.mjs";

test("builds one fast generic skin from a theme and image data URL", () => {
  const css = buildSkinCss({
    theme: {
      id: "miku-488137",
      colors: { accent: "#19c9e5", secondary: "#ed6ec1", surface: "#f5f6fc", text: "#122c60" },
      copy: { brand: "Miku Codex", headline: "一起创造吧" },
    },
    heroDataUrl: "data:image/webp;base64,AAAA",
  });

  assert.match(css, /HEIGE_CODEX_SKIN:miku-488137/);
  assert.match(css, /data:image\/webp;base64,AAAA/);
  assert.match(css, /\.app-shell-left-panel/);
  assert.match(css, /\.composer-surface-chrome/);
  assert.match(css, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /https?:\/\//);
});

test("rejects invalid colors instead of emitting arbitrary CSS", () => {
  assert.throws(
    () => buildSkinCss({ theme: { id: "bad", colors: { accent: "red;display:none" } }, heroDataUrl: "data:image/png;base64,AA" }),
    /颜色/,
  );
});
