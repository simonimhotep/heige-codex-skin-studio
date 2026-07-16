const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const DEFAULT_ACCENT = "#24c9d7";

export function buildSkinMenuScript({ entries, activeId, styleId, menuId }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("皮肤菜单至少需要一个主题");
  }
  const themes = entries.map((entry) => {
    if (!entry?.id || typeof entry.css !== "string") throw new Error("主题条目缺少 id 或 css");
    return {
      id: String(entry.id),
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : String(entry.id),
      accent: HEX_COLOR.test(entry.accent ?? "") ? entry.accent : DEFAULT_ACCENT,
      css: entry.css,
    };
  });
  if (activeId !== null && !themes.some((theme) => theme.id === activeId)) {
    throw new Error(`当前主题不在菜单列表中：${activeId}`);
  }
  const payload = JSON.stringify({ styleId, menuId, activeId, themes });

  return `(() => {
  const data = ${payload};

  let style = document.getElementById(data.styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = data.styleId;
    document.head.appendChild(style);
  }

  document.getElementById(data.menuId)?.remove();
  const root = document.createElement("div");
  root.id = data.menuId;
  root.style.cssText = "position:fixed;top:10px;right:14px;z-index:2147483000;font:500 13px/1.4 system-ui;user-select:none;";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\\u{1F3A8}";
  button.title = "HeiGe Codex Skin Studio";
  button.style.cssText = "display:block;margin-left:auto;width:30px;height:30px;border-radius:50%;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.82);backdrop-filter:blur(10px);box-shadow:0 2px 8px rgba(0,0,0,.14);cursor:pointer;font-size:15px;padding:0;";

  const panel = document.createElement("div");
  panel.style.cssText = "display:none;margin-top:8px;min-width:190px;padding:6px;border-radius:12px;border:1px solid rgba(0,0,0,.1);background:rgba(255,255,255,.94);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.18);color:#17344f;";

  const rows = new Map();
  const paint = (id) => {
    for (const [rowId, row] of rows) {
      row.style.background = rowId === id ? "rgba(36,201,215,.16)" : "transparent";
      row.style.fontWeight = rowId === id ? "700" : "500";
    }
  };
  const row = (label, dotColor, onPick) => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;";
    const dot = document.createElement("span");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;flex:none;background:" + dotColor + ";";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    item.addEventListener("mouseenter", () => { if (item.style.fontWeight !== "700") item.style.background = "rgba(0,0,0,.05)"; });
    item.addEventListener("mouseleave", () => paint(document.documentElement.dataset.heigeCodexSkin ?? null));
    item.addEventListener("click", () => { onPick(); panel.style.display = "none"; });
    panel.appendChild(item);
    return item;
  };

  const setTheme = (id) => {
    const theme = data.themes.find((candidate) => candidate.id === id);
    if (!theme) return;
    style.textContent = theme.css;
    document.documentElement.dataset.heigeCodexSkin = theme.id;
    paint(theme.id);
  };
  const clearTheme = () => {
    style.textContent = "";
    delete document.documentElement.dataset.heigeCodexSkin;
    paint(null);
  };

  for (const theme of data.themes) rows.set(theme.id, row(theme.name, theme.accent, () => setTheme(theme.id)));
  const native = row("\\u539f\\u751f\\u754c\\u9762", "rgba(0,0,0,.24)", clearTheme);
  native.style.borderTop = "1px solid rgba(0,0,0,.08)";
  native.style.borderRadius = "0 0 8px 8px";
  rows.set(null, native);

  button.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  root.append(button, panel);
  document.body.appendChild(root);
  if (data.activeId === null) clearTheme();
  else setTheme(data.activeId);
  return true;
})()`;
}
