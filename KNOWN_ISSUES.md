# Known Issues / 问题记录

> 更新日期：2026-09-24 · 对应版本：**1.2.0（开发中）** · 当前**0 个未修复已知问题**
> Updated 2026-09-24 · tracks in-development **1.2.0** · **0 open issues**

迁移说明：1.2.0 已把扩展迁移到 typert 线上协议，并要求 dsh ≥ 0.1.5-rc.2——斜杠式 JSON-RPC + `/api/remote.mux` WebSocket，旧式 `session.list` / `workspace.list` / `events.mux` / `session.export` 端点全部移除、无降级（见 [CHANGELOG.md](CHANGELOG.md)）。`session/prompt` 请求 id 改为客户端生成；会话回填改走 follow 快照的 `records`。
Migration note: 1.2.0 hardcodes the typert wire protocol and requires dsh ≥ 0.1.5-rc.2 — slashed JSON-RPC plus `/api/remote.mux` WebSocket; the legacy `session.list` / `workspace.list` / `events.mux` / `session.export` endpoints are gone with no fallback. `session/prompt` request ids are client-minted and the changes-view backfill reads the follow snapshot's `records`.

## 未修复已知问题 / Open issue

（无 / none — 2026-09-18 登记的插件桥接端点 404 问题已于 2026-09-19 修复，见下方验收提示与 [CHANGELOG.md](CHANGELOG.md)。）
(none — the plugin bridge-endpoint 404 issue registered on 2026-09-18 was fixed on 2026-09-19; see the verification notes below and the changelog.)

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
| 10 | 插件桥接端点（`/api/lm/*`、`/api/fim`、`/api/vscode/open-link`）在 dsh 0.1.5 上返回 404，LM 路由 / Tab 补全 / 打开链接不可用（根因：路由按**启动时** env 条件挂载，功能后开或收养共享实例时永远挂不上，请求落进 `/api` fetch 桥得到裸 404） / plugin bridge endpoints returned 404 on dsh 0.1.5 — routes were mounted only when their feature env existed at SPAWN time, so later toggles and adopted shared instances never mounted them | 1.2.0 |
| 11 | 更新 dsh 至 0.1.7 后侧栏 workspace 指向又错了：0.1.7 把会话视图选区从 sessions 控制器搬到 `uiWorkspace` 服务（列表快照无 `current`、`sessions.open` 移除），`dsh_session` 跟随消费方读不到当前会话也发不出切换，60s 预算空转后静默放弃，侧栏停在「最近更新的工作区」 / after updating dsh to 0.1.7 the sidebar's workspace pointing broke again: view selection moved from the sessions controller to the `uiWorkspace` service (no `current` on the list snapshot, `sessions.open` removed), so the dsh_session follow could neither read the current session nor switch, idled out its 60s budget and gave up silently — the sidebar stayed on the most recently updated workspace | 1.2.0（修复未发版，见 CHANGELOG Unreleased）/ 1.2.0 (fix in CHANGELOG Unreleased, unreleased) |

## 验收提示 / Verification notes（dsh 0.1.7 会话视图选区搬家，2026-09-24 修复）

- 实证方式：对运行中的 0.1.7-rc.1 实例（本机 3081）直接核对客户端表面——`@deepseek-ai/dsh-api-session-controller/lib/client.js` 的 `ClientSessions` 方法清单（retain/using/retainInfo/…/create/fork/scope/binding/…）**没有 `open`**，且头注释写明 "view selection remains outside the Controller"；`projectList()` 产出的列表快照是 `{ ids, byId, phase, projectionsBySession }`，**无 `current`**；选区在 `@deepseek-ai/dsh-client-ui-workspace` 的 `uiWorkspace` 服务上（`selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } })`、`openSession(target)` → `replaceMain(target, signal, "reveal")`）。升级前（0.1.5/0.1.6）跟随消费方用的正是旧表面，升级后读/写同时失效，且失败是静默的（预算耗尽即停，页面不报错）。
  How this was verified: against a live 0.1.7-rc.1 instance (local port 3081) — `ClientSessions` in `@deepseek-ai/dsh-api-session-controller/lib/client.js` has **no `open`** method and its header reads "view selection remains outside the Controller"; `projectList()` emits `{ ids, byId, phase, projectionsBySession }` with **no `current`**; the selection lives on the `uiWorkspace` service in `@deepseek-ai/dsh-client-ui-workspace` (`selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } })`, `openSession(target)` → `replaceMain(target, signal, "reveal")`). The pre-update follow consumer used exactly the removed surfaces, so the update silently broke both its read and write sides (budget expiry stops the loop without any on-page error).
- 修复后部署：扩展激活时的内容感知同步会把新 client.js 写进 profile 的 `node_modules/dsh-vscode-integration/`（hmr 已被 vscode profile 关闭且这是客户端模块，无需重启 DSH 实例）——重载侧栏 iframe（DSH: Reconnect / 重载窗口）后 boot page 的插件模块 rev 变化即生效；已在 0.1.7-rc.1 实例上实测新 rev 的 client.js 正常下发。
  Post-fix deployment: the extension's content-aware activation sync writes the new client.js into the profile's `node_modules/dsh-vscode-integration/` (hmr is disabled in the vscode profile and this is a client module, so no DSH instance restart is needed) — reloading the sidebar iframe (DSH: Reconnect / window reload) picks up the new boot-page module rev; verified live on the 0.1.7-rc.1 instance serving the new rev.

## 验收提示 / Verification notes（插件桥接端点 404，2026-09-19 修复）

- 根因并非「未随 typert 迁移」：这些端点本就是挂在工作面（webServer）上的裸 HTTP 路由，挂上即用。真正的缺陷是**挂载条件**——路由只在 DSH 进程的 spawn env 里有对应功能键（`DSH_LM_BRIDGE_TOKEN` / `DSH_FIM_BRIDGE_TOKEN` / `DSH_VSCODE_OPEN_URL/TOKEN`）时才挂载，而 env 是**启动时快照**：后开功能、收养的共享实例、旧版本扩展启动的实例，路由永远不存在 → 请求落进 `/api` 前缀路由的 fetch 桥，已认证请求得到裸 `404 not found`，未认证得到围栏 401。实测复现于 dsh 0.1.5-rc.2（2026-09-19）。
  The root cause was not "not migrated to typert": these are plain webServer HTTP routes that work once mounted. The defect was the MOUNT CONDITION — routes existed only when the DSH process env (a spawn-time snapshot) carried the feature keys, so a later toggle, an adopted shared instance, or an instance spawned by an older build never mounted them, and requests fell into the `/api` prefix fetch bridge answering a bare `404 not found` (authenticated) or a fence 401. Reproduced live on dsh 0.1.5-rc.2 (2026-09-19).
- 修复（插件 0.8.0 + 扩展）：`/api/lm/*`、`/api/fim`、`/api/vscode/open-link` 现在**始终挂载**，按请求降级——未配置时返回 `503 fim-not-configured` / `503 editor-links-unavailable`（带操作指引），不再有 404。新增 `POST /api/vscode/configure`（Bearer `DSH_VSCODE_CONFIGURE_TOKEN`）：扩展把 FIM/LM/editor-links 的**运行时**配置推给运行中的实例（token 集合为 upsert 合并，共享实例上多窗口各自注入自己的 per-window token）；该 configure token 同时记入实例注册表（`configureToken` 字段，与 `authToken` 同一 0600 文件），收养窗口因此也能配置它没有亲手启动的实例。
  Fix (plugin 0.8.0 + extension): the three route groups are ALWAYS mounted and degrade per request — an unconfigured instance answers `503 fim-not-configured` / `503 editor-links-unavailable` with actionable guidance instead of a 404. New `POST /api/vscode/configure` (Bearer `DSH_VSCODE_CONFIGURE_TOKEN`) lets the extension push FIM/LM/editor-links config to a RUNNING instance (token sets merge by upsert so each window of a shared instance adds its own per-window bearer); the configure token is recorded in the instance registry (`configureToken`, same 0600 file as `authToken`), so an adopting window can configure an instance it did not spawn.
- 实测验收（dsh 0.1.5-rc.2，2026-09-19）：未配置实例上 `POST /api/fim` 503（原来 404）→ configure 推送（FIM token + 上游 + LM token + editor-links 桥）→ `POST /api/fim` 200 且 SSE 流出 mock 上游增量、`GET /api/lm/models`（推送的 token）200 返回真实模型列表、open-link 路由由 503 变为实际调用推送的桥端点。
  Live verification (dsh 0.1.5-rc.2, 2026-09-19): an unconfigured instance answered 503 (was 404); after one configure push, `POST /api/fim` streamed SSE deltas from the mock upstream, `GET /api/lm/models` with the pushed token returned the real model list, and the open-link route went from 503 to actively calling the pushed bridge endpoint.
- **升级后请执行一次 DSH: Restart Server**：旧实例的插件（< 0.8.0）没有 configure 路由，扩展推送会得到 404 并在诊断里提示重启；重启后同步 0.8.0 插件即全部生效。手动 `dsh web` 启动（无 overlay）的实例依旧无插件，属既有边界。
  Run DSH: Restart Server once after upgrading — an instance running the old plugin (< 0.8.0) has no configure route; the extension logs the 404 hint in diagnostics and a restart syncs the 0.8.0 plugin. A manually started `dsh web` (no overlay) still has no plugin, as before.

## 验收提示 / Verification notes（issue 3/4）

- 修复位于 DSH 侧 `dsh-vscode-integration/client.js`，由扩展在每次激活时同步进所选 DSH home；**升级扩展后必须完全退出并重启 VS Code**（⌘Q），旧扩展宿主与旧 client.js 不会热替换。
  The fix ships in the DSH-side `dsh-vscode-integration/client.js`, which the extension re-syncs into the selected DSH home on every activation; after upgrading, fully quit and restart VS Code — nothing hot-swaps.
- ⌘C 验收：侧栏消息文字内选中 → ⌘C → 任意编辑器 ⌘V；再在聊天输入框内选中自己输入的文字 → ⌘C。
  Verify ⌘C with a selection over message text, and again with a selection inside the chat composer.
- 主题验收：切换 VS Code 亮/暗主题，DSH 侧栏应实时跟随；卸载/禁用扩展后 DSH 恢复其自身主题偏好。
  Verify theme-follow by toggling the VS Code light/dark theme; on dispose the DSH preference is restored.

## 验收提示 / Verification notes（多窗口冷启动 30s 误杀 + 孤儿清扫 PID 复用误杀，2026-09-20 修复）

- 上一轮修复（settle 收养 + 注册表锁）落地后仍偶发「起不来」。本轮从本机 `%APPDATA%\Code\logs\<session>\window*\exthost\output_logging_*\*-DSH.log` 与 globalStorage 的 spawn 日志拿到实证：`[startup] DSH service did not become ready within 30s; process terminated` 连续多条，对应的 `dsh-server-*.log` 全部 **0 字节**——子进程不是坏了，是**还没启动完就被 30s 就绪预算杀了**。实测 dsh 0.1.5-rc.1 冷启动 55.7s、温启动 ~9s（同机、同 profile 克隆）。多窗口把这个问题放大：每个窗口都 spawn 一个冷引导，互相争抢磁盘/杀毒，谁的 30s 都不够。
  The previous fix (settle adoption + registry lock) left the intermittent failure. Evidence from this machine's own logs: repeated `[startup] DSH service did not become ready within 30s; process terminated` with **0-byte** spawn logs — the children were not broken, they were mid-boot when the 30s readiness deadline killed them. Measured on dsh 0.1.5-rc.1: cold boot 55.7s vs warm ~9s (same machine, cloned profile). Many windows amplify it: every window spawns its own cold boot and they contend for disk/AV, so nobody fits in 30s.
- 修复（四个独立点，全部落在扩展侧 `src/serverManager.js`）：① 首次 spawn 就绪预算 120s（`_hasEverBeenReady` 后回落 30s；`SPAWN_EXITED_EARLY` 仍事件驱动快速失败）；② 共享模式健康轮询每 ≈2.8s 静默收养检查——赢家 token 一落盘，输家立即放弃自己的重复引导并收养；③ 孤儿清扫击杀前用进程创建时间 vs 条目写入时间防 PID 复用误杀（现场：清扫 "terminated 13908" 后同窗口自己的新子进程恰好复用 13908 被杀）；④ 存活检查 1.5s TTL 缓存，注册表锁临界区不再被逐条 tasklist 拖向 3s 超时；超时击杀后补端口释放等待，Retry 不再漂移端口。
  Fixed on four independent points, all in the extension (`src/serverManager.js`): (1) 120s readiness budget for the first spawn per extension host (falls back to 30s once warm; SPAWN_EXITED_EARLY stays event-driven and fast); (2) shared-mode health poll silently re-checks the configured port for an adoptable sibling every ≈2.8s — losers abandon their duplicate boot the moment the winner's token lands; (3) sweep kills now verify process creation time against the entry write time to refuse recycled pids (field: sweep "terminated 13908", then the same window's own new child reusing 13908 died); (4) a 1.5s TTL on liveness answers keeps registry-lock critical sections short, and the deadline kill waits bounded for port release so Retry no longer drifts ports.
- 验证：同环境 5+ 窗口同时冷启动（Windows 必测）→ 不应有窗口停留在错误页、不应出现 0 字节 spawn 日志或 "did not become ready" 字样；`ps`/任务管理器里每个环境仍只有一个 `dsh/lib/bin.js --port …`；重载窗口时清扫跳过信息（若 PID 恰被复用）出现在 DSH 输出通道而非杀掉新实例。回归：`test/unit/simultaneousStart.test.js`（新增 mid-wait adoption 用例）、`test/serverManager.test.js`（recycled pid、readyTimeoutMs）。
  Verify: 5+ windows of one environment starting cold simultaneously (Windows especially) → no window stuck on the error page, no 0-byte spawn logs, no "did not become ready" lines; still exactly one `dsh/lib/bin.js --port …` per environment; a window reload whose sweep meets a recycled pid logs the skip in the DSH output channel instead of killing the fresh instance. Regression: `test/unit/simultaneousStart.test.js` (new mid-wait adoption case), `test/serverManager.test.js` (recycled pid, readyTimeoutMs).

## 验收提示 / Verification notes（多窗口同时启动竞态·收养与注册表，2026-09-20 修复）

- 「多窗口同时启动时有的窗口 dsh 起不来」的另一处根因：N 个窗口同时激活都会探测到共享端口空闲并各自 spawn，输掉端口竞争的窗口只有**一次**收养尝试，而赢家实例要等 HTTP 监听 + 赢家窗口把带 `authToken` 的注册表条目落盘（健康轮询 700ms 节拍）才可收养——真实 socket 复现输家 t+304ms 失败、赢家 t+1755ms 才就绪，窗口停在「DeepSeek Harness unavailable」等手点 Retry。现已改为有界 settle 收养（重探测 + 每轮重读注册表 token），并把实例注册表写改原子发布 + 跨进程文件锁（并发激活曾丢掉刚落盘的赢家条目，连带 token，实例从此对所有窗口不可收养）。
  The other root cause of "some windows fail to start DSH when many windows launch at once": N simultaneously activating windows all probe the shared port free and spawn; a port-race loser got exactly ONE adoption attempt while the winner becomes adoptable only after its HTTP listener is up AND its window finalized the registry entry carrying the `authToken` (health poll, 700ms cadence). Real-socket repro: loser failed at t+304ms, winner adoptable at t+1755ms, window stuck on "DeepSeek Harness unavailable" until a manual Retry. Adoption now settles with a bounded re-probe loop that re-reads the registry token each round, and registry writes are atomic publishes behind a cross-process file lock (concurrent activations used to drop the winner's fresh entry — token included — leaving that instance unadoptable by every window).
- 验证：同环境开 5+ 个窗口同时启动（Windows 与 WSL 各试一组）→ 不应再有窗口停留在错误页；`ps` 里每个环境只有一个 `dsh/lib/bin.js --port …`；`dsh-instances.json` 恰好一条该端口条目且 `authToken` 完好；状态栏各窗口分别显示 managed/reused。真实启动失败的窗口（无兄弟、坏运行时）仍应在约 2 秒内报 `SPAWN_EXITED_EARLY`，而非空等。
  Verify: launch 5+ windows of one environment simultaneously (try a Windows set and a WSL set) → no window should stick on the error page; `ps` shows exactly one `dsh/lib/bin.js --port …` per environment; `dsh-instances.json` holds exactly one entry for that port with an intact `authToken`; status bars report managed/reused accordingly. A genuine startup failure (no sibling, broken runtime) must still surface `SPAWN_EXITED_EARLY` within ~2s instead of idling.
- 手动复现脚本：`node test/manual/simultaneous-start-race.demo.js`（修复前 FAILED，修复后 ADOPTED）；回归测试 `test/unit/simultaneousStart.test.js`。
  Manual reproduction: `node test/manual/simultaneous-start-race.demo.js` (FAILED before the fix, ADOPTED after); regression tests in `test/unit/simultaneousStart.test.js`.
- 残留边界（非本次修复范围）：多个 **WSL 发行版** 各有独立扩展注册表但共享同一 WSL2 网络命名空间——跨发行版窗口探测到彼此实例却拿不到对方注册表里的 token，仍会各起一个（每个发行版一个）；如需完全收敛，可为 `dsh.home.path` 指定跨发行版共享目录或将各发行版的 `dsh.port` 显式错开。
  Residual edge (out of scope for this fix): multiple **WSL distros** keep per-distro extension registries while sharing one WSL2 network namespace — a window in distro B sees distro A's instance but cannot recover its token from B's registry, so each distro still converges on its own instance; for full convergence, point `dsh.home.path` at a shared location or pin distinct `dsh.port` values per distro.

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
