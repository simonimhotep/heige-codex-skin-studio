# macOS live acceptance

Status: PARTIAL PASS
Recorded: 2026-07-17T07:05:00.000Z
Machine: real macOS host (unsandboxed), Codex desktop hosted by ChatGPT.app

## Production install

- installer: PASS（第 2 次运行 commit）。`scripts/install.command` 第 1 次运行在 `awaitExactReady`（`set-persistence true --revision 1`）失败：controller 刚被重启尚未就绪的瞬态竞态；重跑 `macos-install-coordinator` 后 `{"decision":"commit","persistenceEnabled":true}`。
- 缺陷：`install.command` 只回显 `Command failed: <argv>`，吞掉了子命令 stderr，瞬态失败无法定位。
- 缺陷：第 1 次失败的安装残留使 controller 之后持续 `MACOS_INSTALL_IN_PROGRESS` 围栏拒绝（`controller.error.log` 同样吞细节，真实原因只在结构化日志 injector.log）；约 20 分钟后 controller 自愈恢复完成，围栏解除。
- 安装后 generation 更新、主题与常驻选择保留。

## Live menu acceptance（真实 renderer，CDP 逐项驱动）

- menuSwitch: PASS。`role=switch`、`aria-checked` 与后台一致、提醒文案完整（关闭后如何拉起：皮肤启动器 / 对 Codex 说「启用 HeiGe 皮肤」/ 重开开关）。
- offAck: PASS。真实确认 UI（确认关闭）→ 回环 ACK → revision 1→2，前后台一致，即时生效。
- reEnableViaMenu: PARTIAL。后台正确落地（revision 2→3，enabled=true，走 fallback 队列由 controller 轮询接手），但直连回环 ACK 超过 renderer 3s fetch 窗口，UI 15s 计时器先到期，用户先看到「后台控制器未确认，请重试」+ 开关回弹，随后才被 controller 推送纠正。功能终态正确，体验呈现假失败——疑似用户报告「按钮没生效」的直接来源。
- sameProcessReload: PASS。renderer reload 后 2s 内皮肤与菜单恢复，开关状态正确。
- finalPreference: PASS。终态 persistenceEnabled=true = 用户原始选择。

## Restart persistence（常驻跨重启语义）

- nativeRestart: FAIL（设计缺口）。常驻开启时正常退出并正常重启 Codex，皮肤 300s+ 未自动恢复。根因：controller 的进程探测只匹配带 CDP 端口启动的 Codex 进程（`listCodexProcesses().filter(cdpPort===port)`），用户正常启动的 Codex 无 CDP → probe 返回 null → reconcile 永远停在 `wait-for-app`。没有任何组件会把原生启动的 Codex 重启进 CDP 模式，开关文案「已开启，下次启动继续使用」的承诺未兑现。
- 恢复路径验证：`apply` 可用（重启 Codex 进 CDP 并注入，5s 恢复）。
- 连带缺陷：恢复时 `apply` 默认 `preferStored` 读到 renderer 本地陈旧选择 `miku-488137`，覆盖了 state.json 权威主题 `dalao-dianyan`（revision 4），与「以用户当前真实选择为准」的修复方向相反；已用 `apply --theme dalao-dianyan` 纠正（revision 5）。

## Harness boundary

- `test/live-macos-acceptance.mjs` 的 `rollback-then-clean` 序列在本机不可运行：preflight `inspectLegacy` 硬性要求旧 watchdog plist 存在，而本机已完成迁移（仅存 `com.heige.codex-skin-controller`）。迁移后状态兼容是未完成的已知工作项。

## Final machine state

- generation `223a444bd12de8bc1563a5b1930260a8`，mode active，theme `dalao-dianyan`，menu true，persistenceEnabled true，revision 5。与验收前用户状态一致。

## Code verification（沿用前次）

- controller and LaunchAgent regression suite: PASS, 216 passed, 0 failed.
- full suite before the final fresh-controller startup-race patch: PASS, 917 passed, 0 failed, 6 skipped.
- rollback-quiescence regression suite after the final recovery-order patch: PASS, 58 passed, 0 failed.

Windows Store: 待验证
