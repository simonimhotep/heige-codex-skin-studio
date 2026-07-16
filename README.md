# HeiGe Codex Skin Studio | Codex 换肤工作室

<div align="center">

**给 Codex Desktop 一键换肤：一张图片就是一个主题，右上角菜单即时切换。**

*Reskin the Codex Desktop app on macOS: one image becomes a theme, switch instantly from an in-app menu.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-black)
![Codex Desktop](https://img.shields.io/badge/Codex-Desktop-10a37f)

[中文](#这是什么) · [English](#english)

</div>

![真机截图：Miku 主题 + 右上角一键切换菜单](docs/images/miku-switcher-live.jpg)

*真机截图：Miku 主题运行中，右上角 🎨 菜单列出全部内置主题，点击即时切换。*

## 这是什么

一个效率优先的 macOS Codex Desktop 换肤工具。它通过本机回环 CDP 把主题实时注入 Codex 界面，不修改 `app.asar`，不破坏应用签名，也不需要为每次 Codex 更新重新适配。

- **一键切换**：应用皮肤后 Codex 右上角出现 🎨 菜单，所有已装主题和原生界面即点即换，零等待。
- **自定义上传**：菜单里选「＋ 自定义图片」直接上传本地图片，自动按图片风格取色（主色、辅色、面板底色、文字色），即点即换，重启后重新 apply 仍会保留；行尾 × 一键删除。
- **一张图片就是一个主题**：任意 PNG、JPG、JPEG、WebP 直接生成皮肤（配色 + 背景底图）。
- **9 个内置预设**：高精度定制的 `Miku 488137`，加上原神、鸣潮、火影忍者、恋与深空各两款轻量主题。
- **AI 生成主题**：把 Skill 交给 Codex，让它先用生图能力产出主图，再自动做成皮肤，无需额外 API Key。
- **可选桌宠**：独立的 `Miku Future` 动画桌面宠物，不覆盖 Codex 内置宠物。
- **随时还原**：暂停皮肤或切回原生界面，官方安装包始终原封不动。

![真机截图：原神星夜主题](docs/images/genshin-night-live.jpg)

*真机截图：原神 · 星夜 轻量主题（无文字干净底图 + 自动配色）。*

## 最快使用

需要 macOS 和已安装的 Codex Desktop。下载本仓库后：

```bash
open "<仓库路径>/scripts/install.command"
```

安装脚本会把工具放到 `~/.codex/heige-codex-skin-studio`，并默认应用 Miku 预设。应用皮肤时 Codex 会被正常退出并以本机调试模式重新打开，当前任务请先保存。

之后的日常切换都在 Codex 右上角 🎨 菜单里完成。想用自己的图片做皮肤：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/customize.command"
```

暂停皮肤、回到原生外观：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/pause.command"
```

注意：Codex 手动重启后注入会消失（CDP 方案的天性），重跑一次 `apply.command` 即可回来。

## 交给 Codex 使用

把 `output/heige-codex-skin-studio.skill` 交给 Codex，可以直接说：

> 用这张图片给 Codex 做一个皮肤并应用。

或者：

> 先生成一张蓝紫色赛博城市主图，再把它做成 Codex 皮肤。

Skill 会优先调用 Codex 当前可用的图片生成能力产出主图，然后调用本地确定性工具创建并应用主题。

## 极简主题格式

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "name": "My Skin",
  "hero": "hero.webp",
  "colors": {
    "accent": "#24C9D7",
    "secondary": "#EF8FD3",
    "surface": "#F7FBFF",
    "text": "#17344F"
  }
}
```

只有 `schemaVersion`、`id`、`name` 和 `hero` 必填。图片必须位于主题目录内，颜色和文案都可省略。

## 主题概念图库

这些 4K 概念图展示「一张图就是一个皮肤方向」的设计效果，内置的 8 款轻量预设使用同场景的无文字干净壁纸版本。

| 原神 | 原神 |
| --- | --- |
| ![原神 Codex UI 概念一](assets/previews/genshin-impact-codex-ui-1.webp) | ![原神 Codex UI 概念二](assets/previews/genshin-impact-codex-ui-2.webp) |

| 鸣潮 | 鸣潮 |
| --- | --- |
| ![鸣潮 Codex UI 概念一](assets/previews/wuthering-waves-codex-ui-1.webp) | ![鸣潮 Codex UI 概念二](assets/previews/wuthering-waves-codex-ui-2.webp) |

| 火影忍者 | 火影忍者 |
| --- | --- |
| ![火影忍者 Codex UI 概念一](assets/previews/naruto-codex-ui-1.webp) | ![火影忍者 Codex UI 概念二](assets/previews/naruto-codex-ui-2.webp) |

| 恋与深空 | 恋与深空 |
| --- | --- |
| ![恋与深空 Codex UI 概念一](assets/previews/love-and-deepspace-codex-ui-1.webp) | ![恋与深空 Codex UI 概念二](assets/previews/love-and-deepspace-codex-ui-2.webp) |

## 命令行

```bash
node src/cli.mjs list
node src/cli.mjs create --image "/absolute/path/hero.webp" --name "My Skin"
node src/cli.mjs apply --theme my-skin-id
node src/cli.mjs status
node src/cli.mjs pause
node src/cli.mjs doctor
```

## 设计边界

这是一个轻量工具。皮肤跟随当前 renderer 存活，Codex 完整重载界面后重新运行一次 `apply.command` 即可。当前版本只保证 macOS，CDP 只绑定本机回环地址 `127.0.0.1`。

本仓库前身是走 ASAR 修改路线的 codex-miku-theme，旧实现保存在历史提交中（tag `v5-asar-legacy`），已由当前 CDP 注入方案取代。

## 开发

```bash
npm test
npm run doctor
```

## English

**HeiGe Codex Skin Studio** reskins the Codex Desktop app on macOS through loopback-only CDP injection. It never touches `app.asar` or the code signature. Any single image becomes a theme (palette + backdrop); after applying once, a 🎨 menu in the top-right corner of Codex switches between every installed theme and the native look instantly. Nine presets ship built in: the fully customized `Miku 488137` showcase plus eight lightweight game-inspired themes. Hand the bundled `.skill` to Codex and it can even generate theme artwork with its own image tools, then install the result deterministically.

Quick start: run `scripts/install.command`, then switch themes from the in-app menu. Pause anytime with `scripts/pause.command`; a normal Codex restart always returns to stock.

## 许可证与素材

代码使用 [MIT License](LICENSE)。预览与预设中的角色、名称和视觉素材权利属于各自权利人（初音未来、原神、鸣潮、火影忍者、恋与深空等），仅用于主题概念展示，不由本项目的软件许可证授权，详见 [NOTICE.md](NOTICE.md)。
