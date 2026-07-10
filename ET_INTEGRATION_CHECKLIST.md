# EternalTerminal (ET) 集成清单 — 按 Mosh 方式重做

> 目标：在上游最新架构（分支 `feat/et-history-reapply`，基于 `031bf0ee`）上，
> **完全照搬 Mosh 的方式**重新集成 EternalTerminal：
> 1. **打包客户端** —— 像 `mosh-client` 那样，把 `et` 客户端二进制构建 + 下载 +
>    捆绑进安装包，运行时只用捆绑的二进制（不依赖系统安装的 et）。
> 2. **接入协议** —— 把旧分支 `feat/eternal-terminal`（tip `67e81616`）里的 ET
>    后端 + UI 重新落到上游重构后的目录结构上，并让它启动**捆绑的** `et`。
>
> 旧实现参考：`git show 67e81616`（共 7 个 ET 提交，见 `feat/eternal-terminal`）。
> Mosh 模板参考（**仅 MoshCatty 纯二进制路径**）：`resources/mosh/README.md`、
> `scripts/fetch-mosh-binaries.cjs`、`scripts/resolve-mosh-bin-release.cjs`、
> `scripts/mosh-extra-resources.cjs`、`electron/bridges/terminalBridge/moshSession.cjs`。
> 客户端本体在独立仓库 [binaricat/MoshCatty](https://github.com/binaricat/MoshCatty)
> （`moshcatty-*` releases）；Netcatty 内已无 Cygwin 构建流水线 / FluentTerminal 回退。

## 关键设计差异（ET vs Mosh）

- **协议**：Mosh 需要 Node 做 SSH bootstrap + 抓 `MOSH CONNECT` + 换 PTY
  （`moshHandshake` + `moshSession`）。**ET 不需要** —— `et` 客户端自己完成 SSH
  引导 + 协议握手，我们只要把 `et` 当作普通 PTY 进程 `pty.spawn` 即可。所以**没有**
  `etHandshake.cjs`。
- **凭证注入**：Mosh 自己驱动 ssh、直接往 PTY 里敲密码；ET 内部驱动 ssh，需用
  **SSH_ASKPASS + 临时 ~/.ssh 环境**把保存的密码/密钥/跳板/算法喂给 et 内部的 ssh
  （旧实现 `prepareEtSshEnvironment` 已完整实现，直接搬运）。
- **纯二进制**：MoshCatty 与理想 ET 打包都是「每平台一个客户端文件」。Mosh 侧已
  无 terminfo / Cygwin DLL 袋；`et` 同样本地不渲染终端。Windows 若动态链 CRT
  才考虑可选 DLL 目录，否则只放 `et[.exe]`。
- **构建系统**：Mosh 客户端在 **MoshCatty** 仓库用 Rust 构建并发布；Netcatty 只
  `fetch`。**ET** 用 CMake + Ninja + vcpkg
  （`cmake -DDISABLE_TELEMETRY=ON -GNinja -DCMAKE_BUILD_TYPE=RelWithDebInfo`），
  产物是单个 `et`（Windows `et.exe`），由 `scripts/build-et/` + `build-et-binaries.yml` 发布。

## 命名约定（镜像 Mosh / MoshCatty）

| Mosh (MoshCatty) | ET |
|------|----|
| `resources/mosh/<plat-arch>/mosh-client[.exe]` | `resources/et/<plat-arch>/et[.exe]` |
| 打包后 `<Resources>/mosh/mosh-client` | 打包后 `<Resources>/et/et` |
| 上游构建：`binaricat/MoshCatty` CI releases | `scripts/build-et/` + `build-et-binaries.yml` |
| `scripts/fetch-mosh-binaries.cjs` | `scripts/fetch-et-binaries.cjs` |
| `scripts/resolve-mosh-bin-release.cjs` | `scripts/resolve-et-bin-release.cjs` |
| `scripts/mosh-extra-resources.cjs` | `scripts/et-extra-resources.cjs` |
| env `MOSH_BIN_RELEASE` / 仓库 `MoshCatty` / tag `moshcatty-*` | env `ET_BIN_RELEASE` / 仓库 `Netcatty-et-bin` / tag `et-bin-*` |
| `npm run fetch:mosh[:dev]` | `npm run fetch:et[:dev]` |
| `bundledMoshClient()` / `resolveBareMoshClient()` | `bundledEtClient()` / `resolveBareEtClient()` |

---

## Phase 1 — 打包基础设施（构建/下载/捆绑）

- [x] **1.1** `resources/et/README.md` —— 镜像 `resources/mosh/README.md`：说明
      二进制来源、`Netcatty-et-bin` 发布仓库、`et-bin-*` tag、许可证（ET 为
      Apache-2.0，与 GPL-3.0 兼容）、可复现构建命令。
- [x] **1.2** `.gitignore` —— 追加 ET 段（镜像 mosh 段）：
      `/resources/et/*/et`、`/resources/et/*/et.exe`、`/resources/et/*/*.dll`、
      `/resources/et/*/et-win32-*-dlls/`。保留 `resources/et/README.md`。
- [x] **1.3** `scripts/build-et/build-linux.sh` —— manylinux2014 + vcpkg 静态三元组
      构建 `et`（x64/arm64），产物 `et-linux-<arch>.tar.gz`(+.sha256)，内含单个 `et`。
      校验非系统动态库（ldd 白名单）。
- [x] **1.4** `scripts/build-et/build-macos.sh` —— arm64 + x86_64 分别构建后 `lipo`
      成 universal，`MACOSX_DEPLOYMENT_TARGET=11.0`，产物 `et-darwin-universal.tar.gz`。
- [x] **1.5** `scripts/build-et/build-windows.ps1`（或 `.sh`）—— MSVC + vcpkg
      `x64-windows-static`，产物 `et-win32-x64.tar.gz`（含 `et.exe`；若动态链接 CRT
      则随附 DLL 目录 `et-win32-x64-dlls/`，否则纯静态无 DLL）。
- [x] **1.6** `scripts/et-extra-resources.cjs` —— 镜像 `mosh-extra-resources.cjs`：
      按平台/arch 仅当 `resources/et/<plat-arch>/et[.exe]` 存在时才产出 extraResources
      指令（`to: "et/"`）；Windows 额外处理可选 DLL 目录。纯客户端文件为主。
- [x] **1.7** `scripts/resolve-et-bin-release.cjs` —— 镜像 `resolve-mosh-bin-release.cjs`：
      `TAG_RE=/^et-bin-.../`，默认仓库 `Netcatty-et-bin`，env `ET_BIN_RELEASE` 优先。
- [x] **1.8** `scripts/fetch-et-binaries.cjs` —— 镜像 `fetch-mosh-binaries.cjs`：
      `TARGETS` 四项（linux-x64/arm64、darwin-universal、win32-x64），全部 tar.gz；
      SHA256SUMS 校验；解包到 `resources/et/<plat-arch>/`。**Windows 用自建产物**。
- [x] **1.9** 单元测试：`scripts/fetch-et-binaries.test.cjs`、
      `scripts/resolve-et-bin-release.test.cjs`、`scripts/et-extra-resources.test.cjs`
      （镜像对应 mosh 测试，改名/改路径）。
- [x] **1.10** `package.json` scripts：新增
      `"fetch:et": "node scripts/fetch-et-binaries.cjs"`、
      `"fetch:et:dev": "node scripts/fetch-et-binaries.cjs --host --resolve-release"`；
      把 `dev` 脚本改成先 `fetch:mosh:dev && fetch:et:dev`；`test` glob 已覆盖
      `scripts/*.test.cjs`（确认即可）。
- [x] **1.11** `electron-builder.config.cjs`：引入 `etExtraResources`，在 darwin/win32/
      linux 三处把 `etExtraResources(plat)` 合并进 `extraResources`（与 mosh 数组拼接）。
- [x] **1.12** `.github/workflows/build-et-binaries.yml` —— 四个构建 job + 一个
      `release` job（dispatch 且 `release_tag` 非空时发布到 `Netcatty-et-bin`，附
      `SHA256SUMS`）。`paths` 过滤指向 `scripts/build-et/**`、`scripts/fetch-et-binaries.cjs`、
      `scripts/et-extra-resources.cjs`。env 用 `ET_REF`（默认 ET release tag，如 `et-v6.2.x`）。
      > 注：实际二进制由用户手动 `workflow_dispatch` 触发产出；本地/CI 未设
      > `ET_BIN_RELEASE` 时 fetch 步骤安静跳过（同 mosh 的 `MOSH_BIN_RELEASE`）。

## Phase 2 — 运行时定位捆绑客户端

- [x] **2.1** `electron/bridges/terminalBridge.cjs` 新增 `bundledEtClient(opts)`
      —— 镜像 `bundledMoshClient`：打包路径 `<Resources>/et/et[.exe]`；dev 回退
      `<projectRoot>/resources/et/<plat-arch>/et[.exe]`；导出到 module.exports。

## Phase 3 — ET 协议后端（搬运旧实现到新架构）

- [x] **3.1** 新建 `electron/bridges/terminalBridge/etSession.cjs` —— 用上游
      `moshSession.cjs` 的 `createXxxSessionApi(ctx)` + `with(ctx)` 工厂模式，封装：
      `ET_ASKPASS_SCRIPT`、`writeSecureFile`、`prepareEtSshEnvironment`、
      `createEtAskpassArtifacts`、`cleanupStaleEtTempDirs`、
      `cleanupSessionExternalAuthArtifacts`、`execOnEtSession`、`startEtSession`。
      **改动点**：`etCmd` 由 `findExecutable('et')` 改为 `resolveBareEtClient()`
      （取捆绑二进制）；找不到时抛错（同 mosh：提示跑 `npm run fetch:et:dev`）。
      Windows 若有动态链接 DLL 目录，可把该目录加进 PATH（MoshCatty 路径已无此需求）。
- [x] **3.2** `terminalBridge.cjs` 接线 `createEtSessionApi(ctx)`（镜像 moshSessionApi
      的 ctx），传入 `bundledEtClient`、`tempDirBridge`、`execFile/execFileSync` 等；
      解构出 `startEtSession`、`execOnEtSession`、`cleanupStaleEtTempDirs`、
      `cleanupSessionExternalAuthArtifacts`、`resolveBareEtClient`。
- [x] **3.3** `init()` 调 `cleanupStaleEtTempDirs()`；`registerHandlers` 加
      `ipcMain.handle("netcatty:et:start", startEtSession)`；`closeSession` 与
      `cleanupAllSessions` 调 `cleanupSessionExternalAuthArtifacts(session)`；
      `module.exports` 导出 `startEtSession`、`execOnEtSession`、`bundledEtClient`。
- [x] **3.4** 测试：`terminalBridge.bundledEt.test.cjs`（路径解析）+
      `terminalBridge/etSession.test.cjs`（prepareEtSshEnvironment 的端口/密钥/
      askpass/跳板/legacy 算法分支）。可参考旧分支是否已有 ET 测试并搬运。

## Phase 4 — domain / 类型 / preload 接口面

- [x] **4.1** `domain/models.ts`：`HostProtocol` 加 `'et'`；`ProtocolConfig.etPort?`；
      `Host`/`GroupConfig` 加 `etEnabled?`/`etPort?`/`etTerminalPath?`；
      `TerminalSession.etEnabled?`；`ConnectionLog.protocol` 加 `'et'`。
      （照搬 `git show 794eecdf -- domain/models.ts`）
- [x] **4.2** `domain/groupConfig.ts`：加 `etEnabled` 默认项（照搬旧 diff）。
- [x] **4.3** `global.d.ts`：`NetcattyBridge` 加 `startEtSession?(options): Promise<...>`
      及相关 options 类型（照搬 `git show 794eecdf -- global.d.ts`，并补齐后续 ET 提交
      新增的 etPort/terminalPath/jumpHosts/legacyAlgorithms 字段）。
- [x] **4.4** `electron/preload/api.cjs`：加 `startEtSession`（镜像第 26 行的
      `startMoshSession`）→ `ipcRenderer.invoke("netcatty:et:start", options)`。
      **注意**：上游已把 preload 重构成 `createPreloadApi`，落点在 `preload/api.cjs`，
      不是旧的 `preload.cjs` 内联对象。

## Phase 5 — 渲染层 + UI + i18n

- [x] **5.1** `application/state/useTerminalBackend.ts`：加 `etAvailable`（查
      `bridge?.startEtSession`）+ `startEtSession`，并在返回对象/依赖数组里登记
      （镜像 mosh 的第 10/42/198/205 行处）。
- [x] **5.2** `application/state/useSessionState.ts`：路由 ET 会话（照搬旧 diff，+6 行）。
- [x] **5.3** `components/terminal/runtime/createTerminalSessionStarters.ts`：加
      `startEt(term)`（镜像 `startMosh`，组装 options：etPort/terminalPath/
      jumpHosts/legacyAlgorithms/凭证/identityFilePaths）。
      **注意**：上游把它从旧的 `infrastructure/runtime/` 移到了
      `components/terminal/runtime/` —— 落点以上游为准。
- [x] **5.4** UI 组件（照搬 `git show b1a306f8 6c0d5bf3 55caa268` 的相应文件，
      映射到上游同名组件）：
      - [ ] `components/ProtocolSelectDialog.tsx` —— 新增 ET 选项
      - [ ] `components/QuickConnectWizard.tsx`
      - [ ] `components/HostDetailsPanel.tsx` —— ET 设置（启用、ET 端口、etterminal 路径）
      - [ ] `components/GroupDetailsPanel.tsx`
      - [ ] `components/VaultView.tsx`
      - [ ] `components/Terminal.tsx` / `components/TerminalLayer.tsx`
      - [ ] `components/terminal/TerminalConnectionDialog.tsx` / `TerminalToolbar.tsx`
      - [ ] `App.tsx`
- [x] **5.5** i18n：`application/i18n/locales/en.ts` 与 `zh-CN.ts` 加 ET 文案
      （照搬旧 diff，键名对齐上游现有 mosh 文案结构）。

## Phase 6 — 校验

- [x] **6.1** `npm run lint`（确保新 .cjs 在 scripts/ 下不受 ESLint 限制，
      或按需加 eslint-disable，与 mosh 脚本一致）。
- [x] **6.2** `npm test`（新增的 fetch/resolve/extra-resources/etSession 测试全绿）。
- [x] **6.3** `npm run build`（渲染层 TS 编译通过，无类型错误）。
- [ ] **6.4** 手动冒烟（需先有发布的二进制）：
      `ET_BIN_RELEASE=et-bin-... npm run fetch:et` → `npm run start` →
      新建 ET 会话连一台装了 etserver 的主机，验证连接/输入/退出/凭证注入。

---

## 进度记录

- 状态：**Phase 1–5 已完成并通过校验**（仅余 1 个可选项 + CI 产二进制）
- 验证结果：
  - `npx eslint <所有改动文件>` → 干净（0 错 0 警）
  - `npx tsc --noEmit` → 我的改动 **0 个新增类型错误**
    （`TerminalConnectionDialog` 里 `case 'mosh'` 的 TS2678 是既有问题，行号因我插入 ET 早返回从 60→64，非新增）
  - `node --test`（ET 相关）→ etSession/bundledEt/3 个脚本测试 **全绿**
  - `npm test` → 1383 通过 / 16 失败，**16 个全是既有的 Windows 环境失败**
    （mosh 打包测试的 GNU-tar `C:` 问题、`isExecutableFile` 无 x 位、ACP execPath、SKILL.md 权限、Comware DH 等；均在我未改动的文件里）
  - `npm run build`（Vite）→ **构建成功**（8.55s），渲染层打包通过

### 已完成
- **Phase 1**：`scripts/et-extra-resources.cjs` / `resolve-et-bin-release.cjs` /
  `fetch-et-binaries.cjs`（+3 测试，27 通过）、`scripts/build-et/{build-linux.sh,
  build-macos.sh,build-windows.ps1}`、`.github/workflows/build-et-binaries.yml`、
  `resources/et/README.md`、`.gitignore`、`package.json`、`electron-builder.config.cjs`。
- **Phase 2**：`terminalBridge.cjs` 新增并导出 `bundledEtClient`。
- **Phase 3**：`terminalBridge/etSession.cjs`（startEtSession + prepareEtSshEnvironment +
  SSH_ASKPASS 机制 + execOnEtSession + 清理），接线进 terminalBridge.cjs（ctx/IPC
  `netcatty:et:start`/init 清理/close/quit 清理/导出），+2 测试（13 通过）。
  **et 指向捆绑二进制**（resolveBareEtClient→bundledEtClient），找不到则报错。
- **Phase 4**：domain `connection.ts`/`history.ts`/`terminal.ts`、`groupConfig.ts`、
  `types/global/netcatty-bridge-session.d.ts`（startEtSession + NetcattyJumpHost[]）、
  `electron/preload/api.cjs`、`domain/vaultImport.ts`（排除 'et' 导入协议）。
- **Phase 5**：
  - 启动派发：`useTerminalEffects.ts`、`Terminal.tsx`(×3) → `startEt`
  - 运行时 starter：`createTerminalSessionStarters.ts` 新增 `startEt`（含单跳板/凭证/
    legacy 算法/askpass 路径），`.types.ts` 加 `etAvailable`/`startEtSession`
  - 后端 hook：`useTerminalBackend.ts`（etAvailable + startEtSession）
  - 会话透传 etEnabled：`sessionFactories.ts`、`useSessionState.ts`(×6)、
    `TerminalLayer.tsx`(×3)、`TerminalLayerSupport.tsx`、`AppHandlers.ts`(协议解析/日志/选择)
  - UI：`HostDetailsAdvancedSections.tsx`（ET 开关+端口+etterminal 路径，与 Mosh 互斥）、
    `HostDetailsPanel.tsx`、`ProtocolSelectDialog.tsx`（ET 选项）、
    `TerminalConnectionDialog.tsx`（ET 标签）、`TerminalToolbar.tsx`（编码菜单门控）、
    `GroupSshSettingsSection.tsx` + `GroupDetailsPanel.tsx`（组级 ET）、`VaultView.tsx`
  - i18n：en/zh-CN 的 `hostDetails.section.et`、`hostDetails.et.*`、
    `terminal.connection.protocol.et`、`terminal.et.*`

### 剩余（可选 / 非阻塞）
- [ ] **QuickConnectWizard.tsx**：把 ET 加为“快速连接”协议按钮（type/端口/建主机映射 +
      UI 按钮）。当前快速连接未列 ET；保存主机后开启 ET 再连即可，故仅为便利项。
- [ ] **产出二进制**：手动 `workflow_dispatch` 跑 `build-et-binaries.yml`（带
      `release_tag=et-bin-<ver>-1`）发布到 `Netcatty-et-bin`，并配 `ET_BIN_RELEASE_TOKEN`
      secret。之后 `ET_BIN_RELEASE=... npm run fetch:et` 即可本地/打包捆绑 `et`。
      build-et 脚本本机无法编译 C++，需在 CI 验证。
- [ ] **端到端冒烟**：有二进制后 `npm run dev`，对装有 etserver 的主机建 ET 会话验证。

- 当前分支：`feat/et-history-reapply`（基于上游 `031bf0ee`）
- 旧 ET 实现参考分支：`feat/eternal-terminal`（tip `67e81616`，7 个 ET 提交）
