# Known Issues / 问题记录

> 更新日期：2026-09-17 · 对应版本：**1.2.0（开发中）** · 当前**1 个未修复已知问题（独立跟进项）**
> Updated 2026-09-17 · tracks in-development **1.2.0** · **1 open issue (separate follow-up)**

迁移说明：1.2.0 已把扩展迁移到 dsh ≥ 0.1.3-alpha.2 的 typert 线上协议（实测 0.1.5）——斜杠式 JSON-RPC + `/api/remote.mux` WebSocket，旧式 `session.list` / `workspace.list` / `events.mux` / `session.export` 端点全部移除、无降级（见 [CHANGELOG.md](CHANGELOG.md)）。`session/prompt` 请求 id 改为客户端生成；会话回填改走 follow 快照的 `records`。
Migration note: 1.2.0 hardcodes the typert wire protocol (dsh ≥ 0.1.3-alpha.2, tested on 0.1.5) — slashed JSON-RPC plus `/api/remote.mux` WebSocket; the legacy `session.list` / `workspace.list` / `events.mux` / `session.export` endpoints are gone with no fallback. `session/prompt` request ids are client-minted and the changes-view backfill reads the follow snapshot's `records`.

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

## 验收提示 / Verification notes（issue 6）

- 修复同样位于 DSH 侧 `dsh-vscode-integration/client.js`，扩展每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），并重启 DSH 实例使新 client.js 生效。
  The fix likewise ships in the DSH-side `dsh-vscode-integration/client.js` re-synced on every activation; fully quit and restart VS Code after upgrading, and restart the DSH instance.
- 验收：打开文件夹 A → 侧栏绑定 A 的会话；`File → Open Folder` 切到文件夹 B（或多根工作区里把活动编辑器移到另一根）→ 侧栏应重载并自动切到 B 的空白会话，会话工具的工作区根随之为 B；自管 DSH 子进程 PID 全程不变。
  Verify by opening folder A, then `File → Open Folder` to folder B (or focusing an editor from another multi-root folder): the sidebar reloads onto B's blank session, tool sandboxes root at B, and the owned child PID never changes.

## 内部开发文档 / Internal dev notes

实现笔记、QA findings 与批次计划移至 `docs/dev/`（不进 VSIX）：
Implementation notes, QA findings and batch planning live under `docs/dev/` (excluded from the VSIX):

- `docs/dev/impl-notes/` — B0–B4 批次实现笔记
- `docs/dev/qa-findings/` — B2/B3 QA 记录
- `docs/dev/planning/` — 0.7 生命周期计划
