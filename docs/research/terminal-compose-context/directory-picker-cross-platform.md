# Directory Picker：跨平台能力与 shell 集成研究

调研日期：2026-10-30。Netcatty 源码基线：`7f8f8d34687a1dbb94b16f314952bf25aac0d88d`。本文研究后续能力，**不表示当前 PR 已支持 Windows 本地目录导航**；实施顺序见 [后续计划](directory-picker-follow-up.md)。

## 1. 结论

保留绝对路径作为操作目标；依 shell 生成命令，依文件系统环境读取目录，依当前交互会话确认结果。跨平台的难点是这三项能力的组合，不是把 `cd --` 换成 `cd`。

建议优先补齐 Windows PowerShell 5.1／PowerShell 7，再推进 CMD。macOS 的 zsh／bash 和主流 Linux 的 bash／ash／zsh 保留已有进程 cwd 回退，并逐步增加可协商的 shell 上报。fish 独立处理引用与事件。WSL、Git Bash、Cygwin 按自己的路径空间接入，不因被分类为 `posix` 就复用 Windows 本地文件系统。

这里的“默认终端支持”指 **Netcatty 创建的交互 shell**。Windows Terminal、Terminal.app、GNOME Terminal 等窗口应用本身不是命令解释器；不能只按 OS 或发行版名称选择语法。

## 2. 当前实现与缺口

| 位置 | 已有能力 | 后续约束 |
| --- | --- | --- |
| `application/state/useTerminalDirectorySession.ts` | macOS／Linux 本地与符合条件的 SSH；Windows 本地主动禁用 | 当前平台门槛不能直接删除，必须先证明 cwd、路径、执行三者都适配 |
| `electron/bridges/localSessionCwd.cjs` | Linux 读 `/proc/<pid>/cwd`；macOS 用 lsof | Windows 未实现；读到启动 PTY 的进程不等于能识别所有嵌套 shell |
| `infrastructure/services/terminalDirectory.ts` | 本地 FS 或 exact-session SFTP，严格 cwd 查询 | 远程不新建登录、不借用其他 session；SFTP 根与 shell 根未必相同 |
| `domain/directoryPicker.ts` | `/` 开头的路径、POSIX 父路径和拼接 | 不支持盘符、UNC、WSL 及 MSYS／Cygwin 路径转换 |
| `domain/sessionRestore.ts` | `resolveInteractiveTerminalCdIntent` 的 POSIX 引用、控制字节拒绝 | 扩展 Directory Picker 不应破坏已有恢复和 SFTP 定位调用者 |
| `terminalDirectoryController.ts`／`terminalCwdStore.ts` | 每会话 revision、严格结果确认、旧连接失效 | 加入 shell 报告也要保留这些顺序与身份约束 |
| `terminalDirectoryRegistry.ts`／`components/Terminal.tsx` | 芯片可见时按完成／输出事件刷新，不恒定轮询 | 集成有效时可以减少辅助探测；关闭 chips 要停止其额外需求 |
| `components/terminal/runtime/createXTermRuntime.ts` | OSC 7 上报路径；OSC 133 的 D 完成事件 | 当前 `URL.pathname` 结果仍按 POSIX 使用；不能把 `/C:/...` 当 POSIX 路径直接读盘 |
| `components/terminal/osc7Setup.ts` | 已有 bash／zsh／fish 目录跟踪配置及确认流程 | 会写 rc 文件并可能 reload；不能改成新功能的静默自动安装器 |
| `electron/bridges/ai/sessionShellKind.cjs`／`liveShellProbe.cjs` | shell 分类、远端登录 hint、当前 PTY 探测 | 登录 shell hint 不证明当前 shell；现有主动探测有输入和副作用，不能每次点菜单就执行 |
| `electron/bridges/ai/ptyExecHelpers.cjs` | POSIX／fish／PowerShell 各自的字符串引用 | 可提取纯引用逻辑；整个 AI exec 包装器不适合目录操作，有子进程、eval、环境及历史处理语义 |

## 3. 绝对路径与 `--`

菜单查询、点击、异步 realpath、写入终端之间存在时间差。即使 chip 自动跟随，列表也只代表查询时的目录。相对路径不能单独消除旧列表风险：仍要校验 session、连接代次、shell／文件系统身份及 cwd revision。

POSIX `cd` 的相对目录还可能受 `CDPATH` 影响；`./child` 能避开这一搜索规则，但仍依赖执行时 cwd。POSIX 文档规定 `cd` 改变的是当前 shell 的执行环境，因此独立 exec 的 cd 不能代替对用户交互 shell 的切换。[S1]

本机隔离目录实验，bash 3.2.57、zsh 5.9 和系统 dash：

| 实验 | 结果 |
| --- | --- |
| `cd -- '/absolute/path'` 与 `cd '/absolute/path'` | 三种 shell 均成功 |
| 从 A 列出 `src`，执行前切到 B，再 `cd './src'` | 三种 shell 均进入 B/src |
| 同样条件下使用 A/src 绝对路径 | 三种 shell 均进入指定 A/src |
| 设置 `CDPATH` 后执行 `cd 'src'` | bash／dash 进入搜索路径中的 src；本次 zsh 优先进入本地 src，不能泛化为各 shell 完全相同 |

这些实验只证明上述本机版本。`--` 与引号作用不同：前者结束选项，后者保持参数边界。对于当前 `/` 开头的绝对路径，`--` 不是必需；不应把删掉它当成 Windows 兼容方案。引用策略必须按 shell 测试，不能把 POSIX 单引号拼接直接推广到 fish／CMD。[S1、S4、N1]

## 4. 支持矩阵与数据来源

| 环境 | cwd 首选／回退 | 目录读取 | 切换策略与主要缺口 |
| --- | --- | --- | --- |
| macOS zsh，兼容 bash 3.2 | 已有 lsof；新增 prompt／chpwd 上报 | 本地 FS | 当前 shell 的 cd；保留原有 login／rc／PATH 行为 |
| Linux bash／zsh／dash／ash | 已有 `/proc`；可用时接 shell 报告 | 本地 FS | 独立引用测试；dash／ash 不保证有 bash 的 hook 能力 |
| Linux／macOS fish | prompt／PWD 事件，必要时进程回退 | 本地 FS | fish 引用与事件；不能运行 POSIX 初始化脚本 |
| Windows PowerShell 5.1／7 | **当前 runspace 的位置报告** | FileSystem provider 的本地 FS | `Set-Location -LiteralPath`；盘符、UNC、provider、策略限制 |
| Windows CMD | 会话 PROMPT 中的位置／边界报告 | Windows 本地 FS | `cd /d`；百分号、感叹号、命令扩展、UNC 另定 |
| Windows WSL | 所选 distro 内 shell 上报／受控 helper | 同一 distro 的 Linux FS 适配 | Linux 语法；不能把 `/home` 传给宿主 Windows FS |
| Windows Git Bash／Cygwin | 该环境的 shell 上报 | 已验证的命名空间映射／helper | MSYS／Cygwin 的挂载规则，不是 WSL 的路径转换 |
| 普通 SSH 到 Unix | 已有严格活动 shell 探测；可选远端集成 | 同一连接的 SFTP；先证明路径对应 | 嵌套 shell、sudo、chroot 不能退回登录 home 冒充 cwd |
| SSH 到 Windows | 远端活动 shell 报告；不靠新 exec 的 Get-Location | 远端 SFTP 路径映射／受控能力 | Win32-OpenSSH hint 不等于活动 shell；独立阶段 |
| 单通道跳板、网络设备、mosh／ET、插件终端 | 按 provider／传输能力分别证明 | 按该传输证明 | 不因支持 cwd 上报就自动支持目录枚举或安全切换 |

Ubuntu／Debian、Fedora／Rocky／Alma、Arch、Alpine 等应作为验收样本，不能把发行版与用户当前 shell 硬绑定。Windows 也不能只根据 PowerShell／CMD 的提示符外观推断可写状态。

## 5. 会话级 shell 集成的可行路径

### 5.1 参考实现与可复用部分

VS Code 将工作目录与命令边界由 shell 脚本报告，启动时通过参数／环境注入；其用户文档也明确普通 SSH、子 shell、特殊启动参数会使自动注入失效。[S2] 固定源码快照 N1 中：

- bash 使用 init-file 路径，并兼容用户 rc／login 启动；fish 使用 init-command。
- zsh 使用临时 ZDOTDIR 中的启动文件代理，不只是加载 `.zshrc` 一步。
- PowerShell 在原 prompt 前后报告位置和边界，只为 FileSystem provider 报告文件路径；受限语言模式会退出集成。
- Windows Terminal 另给出 PowerShell／CMD 的 prompt 集成例子，使用 OSC 133 与 OSC 9;9；这与现有 OSC 7 接收逻辑不是同一协议。[S3、N1]

这些代码证明路径可行，不等于 Netcatty 已支持，也不应整套复制。尤其官方页面和最新主分支的 shell 支持范围可能不同，以自己测试过的版本为准。

### 5.2 推荐启动方式

本地在 `startLocalSession` 的可执行文件、参数和环境解析完成后，按已识别 shell 生成**会话级启动方案**。支持的普通交互参数才注入；用户 `-Command`、`-File`、`--norc`、自定义 `--rcfile`、受限模式或包装脚本不能悄悄改写。集成失败时照常打开终端，声明能力不足，保留当前支持的回退。

临时脚本通过 `tempDirBridge.getTempFilePath()` 放在 Netcatty 管理目录，检查权限、包内资源路径与清理生命周期；不能依赖源码目录在打包后存在。外部 shell 不能把 Electron 的 asar 虚拟路径当普通脚本文件使用，需显式部署为真实资源或复制到受管目录后加载。[S15] 首期不改用户 rc、注册表 AutoRun 或全局环境，也不默认重载整个配置文件。

shell hook 要保留原 prompt、主题插件、退出状态及 PATH；防止重复安装和递归。bash 区分标量／数组 `PROMPT_COMMAND` 及旧版本；zsh 保留 precmd／chpwd 链；fish 保留已有函数和事件。PowerShell 包装原 prompt 并恢复其结果，不能使用 PowerShell 6 才加入的反引号 e 作为 5.1 唯一 ESC 写法，应采用如 `[char]27` 的兼容构造。[S5–S8]

### 5.3 上报协议与可信度

推荐先保留 OSC 7 的可互操作 cwd 展示，再为 host-owned 集成增加可协商、带明确版本及编码的状态报告；是否复用 OSC 633，需在实现前确定。不要随意占用新的 OSC 编号，也不要为完整命令录制扩张本功能。

最低需要报告：当前 cwd／provider、路径类型、shell kind、prompt-ready／running，以及 shell 实例或集成代次。接收器必须处理 BEL／ST、分片、多字节 UTF-8、转义、长度上限与 URI authority。不能把终端原样输出拼成命令。

报告范围只覆盖目录与操作所需状态，不默认收集命令全文、环境变量或凭据。新增序列需经过已有输出管线，避免污染日志、回放、输出触发器与侧栏上下文；不能只在可见 xterm 中生效，忽略 worker／hibernate 路径。

**OSC 7 和普通边界序列是内容，不是认证。** 任意程序都可能打印它们，cwd 报告不能单独解除密码／MFA、alternate screen 或半行输入的阻止条件。VS Code 的 nonce 用于部分命令报告验证，不代表所有 Cwd 属性都已认证。[S2、N1] 候选方案可以使用会话 nonce 降低误识别，但 shell 内可执行代码仍可能读取它，不能宣传为隔离恶意进程的安全边界。

实现时在 worker／host 绑定 session、连接及 shell 代次，验证消息后再发 typed event 到应用状态。保留每会话 revision，使另一个终端的更新不能盖过本终端严格读取；旧连接、退出、hibernate／恢复、外部 `su`、嵌套 shell 均需失效规则。

## 6. Windows 原生 shell

### PowerShell

PowerShell 每个 runspace 的当前位置不同于 `[Environment]::CurrentDirectory`；另起 `powershell -Command Get-Location` 也读不到原交互 runspace 的状态。[S4] 应在目标 prompt 内获取 `$PWD`／`SessionState.Path.CurrentLocation`，只在 provider 为 FileSystem 时取 ProviderPath。进入 `HKLM:`、Env: 或自定义 provider 时显示“非文件系统位置”，不继续展示上一次目录为当前值。[S4、N1]

切换示例为 `Microsoft.PowerShell.Management\Set-Location -LiteralPath 'D:\Project [test]\O''Brien'`：单引号内部的单引号按 PowerShell 规则加倍；`-LiteralPath` 防止方括号等被当通配符。按当前 runspace 的 FileSystem home 做 `~` 展示；不要使用启动 Electron 的用户 home 代替。不能利用 Invoke-Expression 处理用户路径，也不以子进程的成功退出替代原 runspace 确认。[S4、S5]

PowerShell 5.1 与 7 分别验证 PSReadLine、有／无 profile、oh-my-posh／starship、UNC、PSDrive、ConstrainedLanguage／JEA。遵守执行策略；不能自动 `Set-ExecutionPolicy`、强制 Bypass 或绕过组策略。策略阻止集成时声明不可用，并给出可理解原因。[S9、N1]

### CMD

`cd /d "D:\Project"` 才会同时切换盘符和目录；单引号不是 CMD 的路径引用语法。[S10] `PROMPT` 的 `$P`、`$E` 可提供位置和序列构造，Windows Terminal 提供了会话 PROMPT 的组合示例。[S3、S11] 这只证明可上报，不自动解决命令前后边界、当前半行输入、编码或错误码保留。

`%NAME%` 的环境展开、`/V:ON` 的 `!NAME!`、交互输入与批处理中的 `%` 规则不同。不能照抄嵌套 `cmd /c` 包装器的转义：子 CMD 切目录不影响父 CMD；`setlocal` 包装也可能改变退出后的目录／状态。[S12、N1 的对照边界]

第一版可先明确拒绝未经验证的 `%`／`!` 等路径，而非声明支持任意目录。不能修改用户 delayed expansion／AutoRun 来让自己的命令能运行。UNC 也不能默认用 `pushd` 兜底：它会创建临时盘符并改变目录栈；必须另行设计可见语义、清理和失败恢复。[S10–S12]

## 7. WSL、路径模型和远程

路径至少区分显示值、执行值、文件系统地址、逻辑／物理路径及 authority。例如同一 `/home/me` 在 distro A、distro B、SSH 或容器里不是同一目标；`C:foo` 是盘符相对路径，不等于 `C:\foo`；UNC 根也不能用 POSIX 字符串截断计算父级。[S4、S10、S13]

WSL 优先使用所选 distro 的 helper 枚举并返回结构化目录，或经过验证的 Windows UNC 访问；不把 `$PWD` 直接交给 `listLocalDir`。Git Bash／Cygwin 则要验证挂载点、`/c`／`/cygdrive`／`/usr`、链接和编码，不能只替换斜杠。helper 不经 `ls` 文本拆行，支持中英文、空格与严格取消；必要时仍拒绝无法安全执行的控制字符。

PowerShell 的 drive／provider、Windows 大小写、Linux 的大小写敏感与链接语义应交给对应适配器，不对所有路径全局 lowercase／trim／decode。WSL 的 Linux FS 与 Windows FS 在大小写和访问性能上有区别。[S13]

本地集成不会随普通 ssh、tmux、容器或 sudo 自动迁移到目标 shell。远端可选择已有的显式 OSC 7 配置流程，或后续受控地安装当前 shell 的临时集成；必须说明配置是否持久化。不能因菜单打开而私自修改远端 rc。单通道、mosh／ET、Windows OpenSSH、受限 SFTP 需各自证明 cwd、list、change 三种能力，不能借另一个登录“猜目录”。[S2、项目现有实现]

## 8. 实验范围与参考资料

本轮完成源码检查与本机 bash／zsh／dash 命令实验。PowerShell、CMD、fish、WSL 未在本机安装，Windows 和多发行版运行结果**尚未验证**。现有 PR 的本地 PTY／SSH fixture 证明的是当前 Unix 路径，不证明 Windows 已可用。

官方资料均查阅于 2026-10-30：

- S1：[POSIX cd](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/cd.html)，当前 shell、CDPATH、逻辑／物理路径。
- S2：[VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)，注入、支持范围、SSH 限制、OSC 633 与 nonce。
- S3：[Windows Terminal shell integration](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)，PowerShell／CMD 的 OSC 133 和位置报告。
- S4：[PowerShell locations](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_locations?view=powershell-7.5) 与 [Set-Location](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-location?view=powershell-7.5)，runspace、provider、LiteralPath。
- S5：[PowerShell quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-7.5) 与 [special characters](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_special_characters?view=powershell-7.5)，引用及 5.1／6+ 语法区别。
- S6：[Bash prompt](https://www.gnu.org/software/bash/manual/html_node/Controlling-the-Prompt.html) 与 [Bash startup files](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html)。
- S7：[zsh functions](https://zsh.sourceforge.io/Doc/Release/Functions.html)，precmd／chpwd 及 hook 链。
- S8：[fish language](https://fishshell.com/docs/current/language.html)，PWD、函数作用域与事件。
- S9：[PowerShell execution policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-7.5)。
- S10：[CMD cd](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cd)，盘符与 `/d`。
- S11：[CMD prompt](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/prompt)，位置、转义及目录栈符号。
- S12：[CMD](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd) 与 [pushd](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pushd)，展开、AutoRun、UNC／临时盘符。
- S13：[WSL filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)，路径空间、大小写与访问方式。
- S14：[WezTerm shell integration](https://wezterm.org/shell-integration.html)，OSC 7 Windows／POSIX 构造对照。
- S15：[Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)，虚拟路径、外部程序与 unpack 限制。

N1：VS Code 官方仓库固定快照 `ce233327f26ef7791b7fff0143c24e81a8126bd2`，用于验证实现机制，不表示其支持承诺等同于 Netcatty：

- [terminalEnvironment.ts](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/platform/terminal/node/terminalEnvironment.ts)：按 shell 注入参数、ZDOTDIR 与 unsupported-args 分支。
- [shellIntegration.ps1](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1)：provider、原 prompt、状态、语言模式与协议字段。
- [shellIntegration-bash.sh](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh)、[shellIntegration-rc.zsh](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh)、[shellIntegration.fish](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish)：各 shell 初始化及事件处理。
