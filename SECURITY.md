# 安全边界与漏洞报告

## 运行时边界

HeiGe Codex Skin Studio 通过 Chrome DevTools Protocol（CDP）的 `Runtime.evaluate`，把本仓库生成的 CSS 与菜单脚本注入经过严格识别的 Codex 主窗口 renderer。皮肤工作期间，Codex 以仅监听 `127.0.0.1` 的调试端口启动。这个端口属于无认证的 CDP：能够在同一用户权限下访问该本机端口的其他进程，可能获得与 CDP 相同的页面执行能力。防火墙、回环地址和随机端口不能替代 CDP 自身缺少的认证。

独立控制端点同样只监听 `127.0.0.1`，并要求 256-bit 随机令牌通过 `X-HeiGe-Control-Token` 提交。它只接受带版本号的常驻布尔切换或已验证主题 ID，不提供任意命令、文件路径或脚本执行接口。Codex renderer 的 CSP 阻止访问回环 HTTP 时，菜单会把同形状请求暂存在当前 renderer 内存中；控制器通过已经建立的 CDP 会话读取它，并在同一个状态租约内校验随机 capability、renderer generation、revision、动作和值，然后才允许提交。这个令牌和 capability 用于阻止不知道秘密的本机请求或伪造 renderer 状态改变设置，但它们不保护无认证的 CDP，也不抵御已经能够读取本用户进程内存、renderer 或私有状态目录的恶意程序。

项目不读取 Codex 对话，不读取 API key、Base URL、用户项目文件或其他工作区内容。注入器读取的本地内容限于本仓库主题清单、主题图片、状态文件与完成生命周期操作所需的进程身份信息。

运行 `restore` 会先验证目标应用、进程身份和端口归属，再移除已分类 renderer 中的皮肤，注销后台控制器，关闭控制端点，并以不带 CDP 参数的普通模式重新启动 Codex。`pause` 只暂停当前会话中的皮肤，不等于撤销 CDP 启动模式；需要退出该边界时应使用 `restore`。

## 本机威胁模型

本项目不声称能防御已经控制当前 macOS 或 Windows 用户会话的恶意软件。状态目录、控制令牌、LaunchAgent 或 Scheduled Task 均以当前用户权限运行，不要求管理员权限。安装脚本、控制器和更新包必须来自你审核过的仓库版本。

## 报告漏洞

请优先打开仓库的 Security 标签页。如果页面提供「Report a vulnerability」，请使用该私密流程提交复现步骤、影响范围和受影响版本。仓库当前是否启用了 GitHub private vulnerability reporting，应以 GitHub 实时设置为准，本文不作已启用承诺。

不要在公开 Issue 中粘贴控制令牌、日志中的私密路径、API key、对话内容或其他秘密。如果私密入口不可用，请先建立不含秘密的最小联系，再约定安全的材料传递方式。
