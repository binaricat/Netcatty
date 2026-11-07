# Directory Picker：跨平台设计

目录导航需要组合三项能力：读取活动 shell 的位置、访问对应文件系统、在原交互 shell 中执行切换。实现按路径空间和 shell 适配组织，菜单消费统一的目录控制器。

## 已实现的适配

| 环境 | cwd 来源 | 目录读取 | 切换与确认 |
| --- | --- | --- | --- |
| macOS／Linux 本地 POSIX | OSC 7；进程 cwd 回退 | 本地 FS | 现有交互 cd 策略，严格 cwd／realpath 确认 |
| Unix SSH | 活动会话的严格查询／OSC 7 | 同一认证连接的 SFTP | 绑定原终端，按连接能力确认 |
| Windows PowerShell 5.1／7 | 原 runspace 的 FileSystem ProviderPath | Windows 本地 FS | Set-Location -LiteralPath，等待新位置报告 |

## 路径与能力模型

`domain/directoryPath.ts` 负责 POSIX／Win32 的绝对路径、父级、拼接、比较和 home 显示。Win32 分别处理盘符根与 UNC share 根，保留大小写语义；链接与物理路径通过 realpath 确认。设备命名空间、盘符相对路径及 Win32 尾点／尾空格通过路径资格检查处理。

控制器分别声明 `readCwd`、`listDirectories`、`changeDirectory`、`confirmChange`，并接收独立的命令构造策略。目标 authority 绑定 backend 会话，控制器生命周期覆盖连接代次，列表与提交绑定 cwd revision。这样可复用菜单和状态编排，同时让每种 shell 保持自己的路径与引用规则。

绝对路径使异步菜单选择保留明确目标；操作前后的身份与 revision 校验处理目录变化和重连。显示值与执行值分别管理，终端控制字符使用可视化名称和安全执行资格。

## PowerShell 会话集成

普通 `powershell.exe`／`pwsh.exe` 交互启动接受 `-NoLogo`、`-NoProfile`、`-NoExit`。其余启动方式沿用用户原始参数，并显示集成状态。

启动脚本由 Netcatty 管理的临时目录承载，使用 BOM UTF-8 兼容 PowerShell 5.1。加载遵循当前执行策略，profile、PSReadLine、PATH 和原 prompt 继续由用户环境管理。脚本在会话生命周期结束时清理。

原 prompt 包装器读取 runspace 的 `CurrentLocation.ProviderPath`，保留 prompt 的命令状态和 `LASTEXITCODE`。FileSystem 位置形成原生目录报告；Registry／Environment 等 provider 清空旧文件系统位置和菜单，恢复 FileSystem 时重新建立状态。

### 位置报告

采用 OSC 633 property 通道，属性 `NetcattyDirectory` 的值为 base64 UTF-8 JSON：

| 字段 | 用途 |
| --- | --- |
| version、nonce、pid、sequence | 协议版本、会话来源与单调顺序 |
| provider、cwd、home | 当前 provider、文件系统位置与显示 home |

接收器位于 PTY owner，校验来源和顺序后更新状态，再从输出中移除私有报告。日志、回放、提示符跟踪和 renderer 使用过滤后的数据。报告通过现有 `getSessionPwd` IPC 的 typed `directoryState` 返回。

解析器处理 BEL／ST 和任意分片，限制报告为 24 KiB、路径为 8192 字符、provider 为 128 字符。nonce 用于来源关联；终端就绪、敏感输入和活动程序检查继续承担执行门控。

PTY 的提交／中断写入使上次报告失效，覆盖交互输入、AI 和 snippet 路径。后续读取等待原 shell 的新报告，从而将嵌套 shell 与外层 shell 的位置状态分开。

### 导航

目录读取使用 Windows 本地 FS，切换使用原 shell 中的模块限定 `Set-Location -LiteralPath`。PowerShell 把 ASCII 与 U+2018／2019／201A／201B 单引号视为引用字符，构造器统一加倍转义。提交前重验 provider、cwd 和 revision，提交后等待新报告确认。

PSDrive 根的 ProviderPath 可能带尾部反斜杠，因此路径比较按根和分隔符语义处理。ConPTY 退出为异步过程，真实运行测试等待进程退出后清理资源。

原生 Windows 路径提示符使用独立的边界识别，覆盖深目录和折行；`>` 后的内容继续作为当前输入。目录操作因此复用同一套空提示符、敏感输入和 TUI 检查。

## 后续设计方向

- POSIX hook：分别处理 bash 的 PROMPT_COMMAND、zsh 的启动链和 fish 事件，补齐事件上报。
- CMD：围绕 PROMPT、`cd /d`、交互转义和 ERRORLEVEL 建立独立策略。
- WSL／MSYS／Cygwin：以 distro／mount authority 组织目录 helper 和路径映射。
- 扩展远程环境：逐项明确活动 shell 与 SFTP／provider 的文件系统对应关系。

阶段交付与推进顺序统一维护在 [开发计划](directory-picker-follow-up.md)。

## 技术依据

- [PowerShell locations](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_locations)：runspace、provider 与当前位置。
- [Set-Location](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-location) 与 [quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules)：LiteralPath 与字符串引用。
- [PowerShell execution policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)：脚本加载策略。
- [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) 与 [PowerShell 实现](https://github.com/microsoft/vscode/blob/ce233327f26ef7791b7fff0143c24e81a8126bd2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1)：会话注入、prompt 保留与 OSC 属性通道。
- [Windows Terminal shell integration](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)、[WSL filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)：Windows shell 上报与文件系统命名空间。
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)：外部 shell 的实体脚本资源。
