# HeiGe Codex Skin Studio 设计规范

日期：2026 年 7 月 16 日

状态：已确认，可进入实施规划

## 一、目标

将现有 `codex-miku-theme` 重构为 macOS 通用 Codex 桌面端换肤工具 `HeiGe Codex Skin Studio`。

新版采用本机回环 CDP 注入，不再修改官方 `.app`、`app.asar` 或代码签名。初音未来主题作为随产品提供的首个完整 preset，用户也可以提供一张图片或一句描述，由 Codex 的 image 生图能力生成主题素材，再由本地引擎确定性地安装、应用、暂停和恢复。

## 二、已确认的产品决策

1. 主项目彻底切换到 CDP 通用换肤路线。
2. 旧 ASAR 版不留在主产品中，只保存在 Git 历史、归档分支与历史 Tag／Release。
3. 首发只支持 macOS。
4. 展示名称为 `HeiGe Codex Skin Studio`。
5. 仓库名和 Skill 名为 `heige-codex-skin-studio`。
6. 默认完整主题为 `Miku 488137`。
7. 独立原生宠物 `Miku Future` 继续作为可选配套能力，不覆盖 Codex 内置宠物。
8. 普通用户可以只导入一张图片；完整主题可以提供主背景、侧栏纹理、Logo 和拍立得装饰。
9. Codex Skill 可以调用当前环境可用的 image 生图／改图能力生成完整主题包，本地引擎本身不内置第三方 AI API，也不要求额外 API Key。
10. 用户提供的 Miku 实机截图作为 README 首屏预览图。
11. `/Users/blakexu/Downloads/export (8)` 中的 8 张 4K 概念图只作为 README 主题灵感图库，不作为可安装背景，不进入分发 Skill。

## 三、非目标

初始版不实现以下内容：

1. Windows 支持。
2. 本地 Web 主题编辑器。
3. 云端账号、主题市场或遥测。
4. 自动调用需要用户自行配置 Key 的第三方生图 API。
5. 把含假侧栏、假卡片和假输入框的完整 UI 概念图铺到 Codex 后面。
6. 修改 Codex 官方安装包、二进制文件、签名资源或模型供应商配置。
7. 静默强杀 Codex 进程。

## 四、用户体验

### 4.1 安装

用户从 Release 下载 `.skill` 或项目包，交给 Codex 并要求安装。Skill 运行 doctor，确认系统、官方 Codex 应用、签名、Team ID、架构和 Codex 自带 Node.js 可用，然后把引擎安装到稳定目录：

```text
~/.codex/heige-codex-skin-studio/
```

状态、日志、当前主题和用户主题放在：

```text
~/Library/Application Support/HeiGeCodexSkinStudio/
```

### 4.2 使用内置主题

用户可以说“安装 Miku 主题”，Skill 调用本地引擎选择 `Miku 488137`。若 Codex 已按普通模式运行，工具要求用户正常退出一次，然后以仅绑定 `127.0.0.1` 的 CDP 模式重新打开。注入器连接通过验证的 Codex 渲染器并应用主题。

### 4.3 用一张图片制作主题

用户通过 Finder 选图或把文件交给 Codex。最小主题生成流程只要求一张主背景图，工具根据图片生成主题目录、默认文案与配色配置。高级用户可以继续编辑 `theme.json`。

### 4.4 让 Codex 生成完整主题

用户提供参考图或一句描述后，Skill 调用可用的 image 生图／改图能力，生成不包含假 UI 控件的以下素材：

1. 主背景或 hero。
2. 低噪声侧栏纹理。
3. 透明 Logo 或角标。
4. 透明拍立得／贴纸装饰。

Skill 校验素材后写入 `theme.json`，再调用本地引擎导入和应用。若当前环境没有生图能力，Skill 明确降级为单图主题，不假装已经生成完整素材。

### 4.5 暂停和恢复

“暂停”只从当前页面移除主题并停止持续注入，Codex 可以继续运行，但调试端口可能仍随本次 Codex 进程存在。

“完全恢复”停止本工具创建的注入器，核对记录的进程身份，并引导用户正常退出 Codex。重新打开后不再携带 CDP 参数，官方外观、官方签名和官方资源始终保持原样。

## 五、系统架构

```text
Codex Skill
  ├── 解析用户意图
  ├── 可选调用 image 生图／改图能力
  ├── 创建或选择主题包
  └── 调用本地 CLI
          │
          ▼
HeiGe Codex Skin Studio CLI
  ├── doctor 与 macOS 运行时验证
  ├── 主题包校验与主题库管理
  ├── Codex CDP 启动与生命周期管理
  ├── 注入器进程管理
  └── 状态、日志、暂停与恢复
          │
          ▼
Codex 官方桌面端
  ├── 127.0.0.1 CDP
  ├── app:// 渲染器
  ├── 原生侧栏、卡片、输入框和任务页面
  └── CSS 与装饰 DOM 注入层
```

### 5.1 信任边界

1. 只接受 `com.openai.codex` 官方应用。
2. 校验应用签名、预期 Team ID、当前机器架构和自带 Node.js 签名。
3. CDP 只绑定 `127.0.0.1`，不绑定局域网地址。
4. 只连接 URL 为预期 `app://` 范围的 renderer target。
5. 只操作本工具记录并再次核验 PID、可执行路径和启动时间的注入器。
6. 不读取、修改或记录 Codex API Key、Base URL、对话内容和项目文件。
7. README 明确说明 CDP 本机调试端口的风险，主题运行期间不要运行不可信本机程序。

## 六、模块边界

### 6.1 CLI 入口

`src/cli.mjs` 只负责解析命令、调用模块和输出机器可读 JSON。初始命令为：

```text
doctor
install
list
import
apply
pause
status
restore
```

### 6.2 macOS 运行时

`src/macos-runtime.mjs` 负责发现官方 Codex、验证签名和自带 Node.js、选择回环端口、识别进程、正常启动与停止本工具自己的进程。它不理解主题内容。

### 6.3 主题协议

`src/theme-schema.mjs` 负责解析、标准化和验证 `theme.json`。它不接触 CDP。

主题协议 v1 示例：

```json
{
  "schemaVersion": 1,
  "id": "miku-488137",
  "name": "Miku 488137",
  "appearance": "light",
  "assets": {
    "hero": "hero.png",
    "sidebar": "sidebar.png",
    "logo": "logo.png",
    "polaroid": "polaroid.png"
  },
  "colors": {
    "accent": "#19C9E5",
    "secondary": "#F397E0",
    "surface": "#FAFAFF",
    "text": "#122C60"
  },
  "copy": {
    "brand": "Miku Codex",
    "headline": "我们今天来构建什么？",
    "tagline": "和初音未来一起，把灵感写成代码与旋律。"
  }
}
```

约束如下：

1. `schemaVersion` 必须为受支持的整数。
2. `id` 只能使用小写字母、数字和连字符。
3. 所有素材路径必须留在当前主题目录内，不允许绝对路径和 `..`。
4. 只接受 PNG、JPEG、WebP 和 macOS 可安全转换的常见图片格式。
5. 单个源文件和最终准备文件均有大小上限。
6. 颜色必须是明确的十六进制颜色值。
7. 文案有长度上限，注入时使用文本节点或 CSS 变量，不拼接为可执行代码。
8. `hero` 必填，其余素材可选。

### 6.4 主题库

`src/theme-store.mjs` 负责导入、生成稳定目录名、复制素材、原子写入 manifest、切换当前主题和列出主题。内置 preset 只读，用户主题写入 Application Support。

### 6.5 CDP 客户端

`src/cdp-client.mjs` 提供最小 WebSocket 会话、命令请求、超时和连接关闭，不包含 CSS 和页面选择器。

### 6.6 渲染器注入

`src/renderer-inject.mjs` 负责把主题 manifest 和素材编译为可重复执行的 payload：

1. 使用唯一 style ID 和根节点标记。
2. 重复执行不会叠加元素或监听器。
3. 装饰层默认 `pointer-events: none`。
4. 原生侧栏、建议卡、项目选择、输入框和任务内容保持可交互。
5. 使用 MutationObserver 和路由状态检测处理页面切换与重绘。
6. `cleanup` 能完整移除样式、装饰 DOM、观察器和全局状态。
7. 主题只改变视觉，不替换原生按钮文字所承载的真实功能。

### 6.7 注入器守护进程

`src/injector.mjs` 负责发现 renderer targets、连接、首次应用、断线重连、路由后重应用、验证和安全停止。它从已经验证的主题目录读取素材并转成 data URL，不把用户输入拼进 JavaScript 源码。

### 6.8 Skill

`skill/heige-codex-skin-studio/SKILL.md` 负责：

1. 识别安装、应用、生成主题、换图、检查、暂停和恢复意图。
2. 在生成主题时调用可用的 image 能力。
3. 强制要求生成纯素材，不生成带假侧栏、假输入框和假按钮的整窗 UI。
4. 调用本地 CLI，而不是重新实现安装器。
5. 遇到签名、端口、目标身份和素材校验失败时保留真实错误，不绕过安全门。

### 6.9 独立宠物

`Miku Future` 保留为单独可选目录和安装命令。通用主题引擎不把宠物写进所有主题，也不把安装宠物作为应用主题的强制步骤。

## 七、Miku 默认 preset

`presets/miku-488137/` 使用现有经过处理的纯主题素材，不使用完整 UI 截图作为背景。它展示多素材 preset 的全部能力，也是安装后的默认演示主题。

预设应包含：

```text
theme.json
hero.png
sidebar.png
logo.png
polaroid.png
```

现有素材如无法直接对应新槽位，使用固定、可复现的素材构建脚本生成。生成产物记录 SHA-256，确保仓库、Skill 和安装副本一致。

## 八、README 与预览图库

README 首屏使用用户本轮提供的 Miku 实机截图：

```text
/var/folders/bn/k96c656d2x56zwyld3hrs2gw0000gn/T/codex-clipboard-bf759870-7064-4d0f-85cd-cdb2a7dc8801.png
```

仓库内目标路径为：

```text
docs/images/heige-codex-skin-studio-miku-preview.png
```

`/Users/blakexu/Downloads/export (8)` 中的 8 张 4K 图会生成适合 GitHub README 的压缩预览版本，并放入 `docs/images/gallery/`。原始 4K 文件不复制进 Git 仓库，避免仓库无意义膨胀。README 明确标记这些图片为“主题灵感预览”，不承诺当前 Release 已包含对应 IP 的可安装素材。

## 九、错误处理

以下情况必须失败并给出明确错误：

1. 找不到官方 Codex 应用。
2. 应用、Team ID 或自带 Node.js 签名不符合预期。
3. 端口被非 Codex 进程占用。
4. 已运行的 Codex 没有 CDP，且用户没有正常退出。
5. CDP target 不是预期 `app://` renderer。
6. 主题 manifest 越界、路径穿越、颜色无效、素材缺失或过大。
7. 注入后关键标记、原生侧栏或输入框不可验证。
8. 状态中的 PID、路径或启动时间与当前进程不一致。

失败时不修改官方应用、不强杀 Codex、不覆盖旧主题目录，并保留结构化日志供 Skill 汇报。

## 十、测试策略

所有行为改动遵循测试先行。

### 10.1 单元测试

1. 主题协议解析、默认值和错误输入。
2. 路径穿越、素材类型、大小和颜色校验。
3. data URL 编码和 payload 文本转义。
4. CDP 消息 ID、超时、断开和错误响应。
5. 进程列表、端口归属和 target 过滤。
6. 状态文件原子写入与旧状态拒绝。

### 10.2 集成测试

1. 使用临时目录导入单图主题并生成标准主题包。
2. 应用、重复应用、切换主题、暂停和 cleanup 的幂等性。
3. 模拟 renderer 重载后重新注入。
4. 注入失败时状态不被误标记为成功。
5. 安装目录和 Skill 分发内容一致。
6. Miku preset 素材哈希和主题协议一致。

### 10.3 实机验收

在官方 macOS Codex 上验证：

1. 首页和正常任务页均生效。
2. 原生侧栏、建议卡、项目选择、输入框、弹窗和审批卡可用。
3. 页面切换和刷新后主题仍在。
4. 暂停后原生外观恢复。
5. 完全恢复后 CDP 端口关闭，普通方式启动 Codex。
6. `codesign --verify --deep --strict` 始终通过。
7. 不修改 `app.asar` 的字节与修改时间。

## 十一、旧版归档策略

在删除 ASAR 主线代码前，先把当前 v5 工作完整提交到归档分支，并建立清晰 Tag：

```text
codex/archive-asar-v5
v5-full-legacy
```

主分支随后进入 `HeiGe Codex Skin Studio` 的新历史阶段。README 提供旧版 Release 链接和风险边界，但不在新 Skill 中混装两套引擎。

## 十二、成功标准

满足以下条件才算初始版完成：

1. 官方 Codex 安装包与签名未被修改。
2. Miku preset 能在 macOS Codex 首页和任务页稳定应用。
3. 用户可以导入一张图片生成并应用新主题。
4. Skill 能在可用时调用 image 能力生成完整主题包，并在不可用时诚实降级。
5. 暂停、完全恢复和状态检查均可重复执行。
6. README 首图和 8 张主题灵感预览完成。
7. Miku Future 宠物可选安装，且不覆盖内置宠物。
8. 自动测试通过，实机验收通过，恢复后 CDP 端口关闭。
