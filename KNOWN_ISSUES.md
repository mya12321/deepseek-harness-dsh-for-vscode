# Known Issues / 问题记录

> 更新日期：2026-09-18 · 对应版本：**1.2.0（开发中）** · 当前**1 个未修复已知问题（独立跟进项）**
> Updated 2026-09-18 · tracks in-development **1.2.0** · **1 open issue (separate follow-up)**

迁移说明：1.2.0 已把扩展迁移到 typert 线上协议，并要求 dsh ≥ 0.1.5-rc.2——斜杠式 JSON-RPC + `/api/remote.mux` WebSocket，旧式 `session.list` / `workspace.list` / `events.mux` / `session.export` 端点全部移除、无降级（见 [CHANGELOG.md](CHANGELOG.md)）。`session/prompt` 请求 id 改为客户端生成；会话回填改走 follow 快照的 `records`。
Migration note: 1.2.0 hardcodes the typert wire protocol and requires dsh ≥ 0.1.5-rc.2 — slashed JSON-RPC plus `/api/remote.mux` WebSocket; the legacy `session.list` / `workspace.list` / `events.mux` / `session.export` endpoints are gone with no fallback. `session/prompt` request ids are client-minted and the changes-view backfill reads the follow snapshot's `records`.

## 未修复已知问题 / Open issue

| # | 问题 / Issue | 状态 / Status |
|---|---|---|
| 1 | `runtime-integration/dsh-vscode-integration` 插件的桥接端点（`/api/lm/*`、`/api/fim`、`/api/vscode/open-link`）在 dsh 0.1.5 上返回 404（这些端点仍是旧协议遗留，未随 typert 迁移）→ LM 路由 / Tab 补全 / 打开链接等插件侧能力不可用。**独立跟进项**，不属于本次 404 迁移范围。 / The plugin's bridge endpoints (`/api/lm/*`, `/api/fim`, `/api/vscode/open-link`) still 404 on dsh 0.1.5 — they predate the typert migration on the plugin side, so LM routing / tab completion / open-link are unavailable. Separate follow-up, out of scope for this 404 migration. | 跟进中 / in progress |

历史问题与修复索引（复现细节见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/dev/](docs/dev/)）：
Past issues and their fixes (details in the changelog and dev notes):

| # | 问题 / Issue | 修复版本 / Fixed in |
|---|---|---|
| 1 | 编辑器空白行右键没有“将文件添加到 DSH 对话”入口 / no editor-body context entry for Add File to DSH Thread | 0.6.0 |
| 2 | 工作区之外的文件无法添加到对话 / files outside the workspace could not be attached | 0.6.0 |
| 3 | macOS 嵌入侧栏内 ⌘C/⌘X 复制剪切失效（VS Code Edit 菜单不转发进嵌套 iframe，microsoft/vscode#129178；旧桥只接管了 ⌘V） / ⌘C/⌘X copy-cut dead inside the embedded iframe on macOS | 0.9.0 |
| 4 | 颜色跟随操作系统而非 VS Code 主题（扩展端 dsh_theme/dshThemeChanged 链路早已就绪，DSH 端消费方缺失，主题服务仍按 prefers-color-scheme 解析 system）/ colors followed the OS instead of the VS Code theme — the DSH-side consumer was missing | 0.9.0 |
| 5 | 默认配置下侧边栏报「没有可提供视图数据的已注册数据提供程序」：dsh.changes 视图无条件声明但提供程序仅在 changes-review 开启时挂载 / "no registered data provider" placeholder for dsh.changes under default settings | 0.9.4 |
| 6 | 切换 VS Code 工作区后侧栏不跟随：扩展端经工作区注册表重绑并以 `?dsh_session=` 重载 iframe，但 DSH Web 端只恢复自己持久化的当前会话、无任何 dsh_session 消费方 / after a workspace switch the sidebar kept the old conversation: the DSH web app restores its own persisted current session and nothing consumed dsh_session | 0.9.3 |
| 7 | @dsh 参与者每条消息新建会话且标题为裸 UUID（会话爆炸）/ the @dsh participant created a new session per message with bare-UUID titles | 1.1.2 |
| 8 | 桥推送的编辑立即落盘、Accept 仅记账、Undo 反向区间被 applyEdit 拒绝 / bridge-pushed edits wrote to disk immediately, Accept only bookkept, and Undo reverse ranges were rejected | 1.1.2 |
| 9 | 终端 `read` 始终为空：无 onDidWriteTerminalData 输出回读 / bridge `terminal/read` always returned empty — no terminal output read-back | 1.1.2 |

## 验收提示 / Verification notes（issue 3/4）

- 修复位于 DSH 侧 `dsh-vscode-integration/client.js`，由扩展在每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），旧扩展宿主与旧 client.js 不会热替换。
  The fix ships in the DSH-side `dsh-vscode-integration/client.js`, which the extension re-syncs into the selected DSH home on every activation; after upgrading, fully quit and restart VS Code — nothing hot-swaps.
- ⌘C 验收：侧栏消息文字内选中 → ⌘C → 任意编辑器 ⌘V；再在聊天输入框内选中自己输入的文字 → ⌘C。
  Verify ⌘C with a selection over message text, and again with a selection inside the chat composer.
- 主题验收：切换 VS Code 亮/暗主题，DSH 侧栏应实时跟随；卸载/禁用扩展后 DSH 恢复其自身主题偏好。
  Verify theme-follow by toggling the VS Code light/dark theme; on dispose the DSH preference is restored.

## 验收提示 / Verification notes（跨窗口共享，2026-09-18 修复）

- 「同环境共享一个 dsh 实例」此前在围栏运行时上是**静默失效**的：配置端口的收养以 `isDsh` 为门槛（围栏下无 token 探测恒为 `isDsh:false`），进程发现用的 `dsh.+web` 又匹配不到扩展自己的受管启动形态，于是每个窗口各起一个实例；收养来的句柄 `owned:false`，绑定工作区时还会弹同意框、拒绝即回滚。现已全部修复。
  Cross-window sharing was silently broken on fenced runtimes: port adoption was gated on `isDsh` (never true for a tokenless probe under the fence), process discovery's `dsh.+web` never matched the extension's own managed launch shape, so every window spawned its own instance; and an adopted handle was `owned:false`, so binding a workspace prompted for consent and a decline rolled it back.
- 验证：同一环境（Windows 或 WSL）开两个窗口指向同一 DSH home → `dsh-instances.json` 只应有一条该端口的条目（`ps` 里只有一个 `dsh/lib/bin.js --port …`），第二个窗口的状态栏显示 `reused`；在第二个窗口切换文件夹 → 不再弹同意框，侧栏跟随到该文件夹的会话；关闭第一个窗口后实例仍在（第二窗口附着），关闭全部窗口后实例退出。
  Verify by opening two windows against the same DSH home in one environment: the registry should hold a single entry for that port (one `dsh/lib/bin.js --port …` in `ps`) with the second window reporting `reused`; switching folders in the second window must bind without a consent prompt and move the sidebar; the instance must survive the first window closing (the second is attached) and exit once every window is gone.
- 注册表条目现在记录实例启动 token，文件权限为 `0600`（该 token 随围栏实例的收养流程使用，等同该文件里本就记录的 spawn 日志路径）。
  Registry entries now record the instance launch token and the file is mode `0600` (used by the adoption path for fenced instances; same secret the recorded spawn-log path already carried).
- 2026-09-18 补充修复（新开窗口的工作区「绑不上」的另一半根因）：实例本体的启动随 embed overlay 全灭——`dsh-vscode-integration` 服务端入口声明了 `inject: ['apiProxy', …]`，而 `apiProxy` 在 typert 网关上已不存在 → 启动断言 "1 entry did not activate" 整个进程 exit 1 → 扩展自愈去掉 `--patch` 重试，实例**无插件运行**。此时 API 层的注册表/会话绑定都正常（诊断看不出异常），但 `dsh_session` 没有任何消费方，新开窗口侧栏里的 Web 应用只会自动打开「最近更新的工作区」（通常是另一个窗口的），表现为「新开的插件 workspace 没有正确绑定」。inject 已移除 `apiProxy`（旧协议 openPath 桥改为服务存在才挂接）；**升级后请重启 DSH 实例**，并可在 DSH 输出通道确认不再出现 `[selfheal] DSH exited early with --patch`。
  Follow-up fix 2026-09-18 (the other half of "a newly opened window's workspace never binds"): the instance boot itself died with the embed overlay — the plugin's server entry declared `inject: ['apiProxy', …]`, a service the typert gateway no longer has, so the boot asserted "1 entry did not activate" and exited; the extension's self-heal then retried without `--patch`, leaving the instance running WITHOUT the plugin. API-level binding stayed healthy (invisible in diagnostics), but nothing consumed `dsh_session`, so each newly opened window's sidebar auto-opened the most recently updated workspace — usually the other window's — reading as "the new workspace never binds". The inject drops `apiProxy` (the legacy openPath bridge now attaches only when the service exists); restart the DSH instance after upgrading and confirm the DSH output channel no longer shows `[selfheal] DSH exited early with --patch`.

## 验收提示 / Verification notes（issue 6）

- 修复同样位于 DSH 侧 `dsh-vscode-integration/client.js`，扩展每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），并重启 DSH 实例使新 client.js 生效。
  The fix likewise ships in the DSH-side `dsh-vscode-integration/client.js` re-synced on every activation; fully quit and restart VS Code after upgrading, and restart the DSH instance.
- 验收：打开文件夹 A → 侧栏绑定 A 的会话；`File → Open Folder` 切到文件夹 B（或多根工作区里把活动编辑器移到另一根）→ 侧栏应重载并自动切到 B 的空白会话，会话工具的工作区根随之为 B；自管 DSH 子进程 PID 全程不变。
  Verify by opening folder A, then `File → Open Folder` to folder B (or focusing an editor from another multi-root folder): the sidebar reloads onto B's blank session, tool sandboxes root at B, and the owned child PID never changes.
- 2026-09-18 残留修复：上述跟随链路里，DSH 侧的 `dsh_session` 消费方等待上限只有 5 秒，且会话服务在 apply 时未挂载就**静默不启动**——两侧都无提示，表现为侧栏停在旧工作区的会话。现在等待会话服务挂载、预算 60 秒、以 `current` 真正切到目标为完成条件，并在列表刷新重置选中项时重试；用户自己点了别的会话则立即退让。切文件夹时若仍不跟随，请确认 DSH 实例已重启（新 client.js 生效）。
  Residual fix 2026-09-18: the DSH-side `dsh_session` consumer waited at most 5s and silently never started when the sessions service was not mounted at apply time — both invisible, leaving the sidebar on the old workspace's session. It now waits for the service to mount, runs a 60s budget, completes when `current` actually moves to the target, retries across list refreshes, and stands down when the user picks another session. If a folder switch still does not follow, confirm the DSH instance was restarted so the new client.js is live.

## 内部开发文档 / Internal dev notes

实现笔记、QA findings 与批次计划移至 `docs/dev/`（不进 VSIX）：
Implementation notes, QA findings and batch planning live under `docs/dev/` (excluded from the VSIX):

- `docs/dev/impl-notes/` — B0–B4 批次实现笔记
- `docs/dev/qa-findings/` — B2/B3 QA 记录
- `docs/dev/planning/` — 0.7 生命周期计划
