# Directory Picker：目录展示与切换

目录芯片展示当前聚焦终端的实际工作目录，提供当前层搜索、父级／子目录导航和目录链接选择。跨平台设计见 [设计说明](directory-picker-cross-platform.md)，剩余工作见 [开发计划](directory-picker-follow-up.md)。

## 交互

芯片使用文件夹图标和路径，长路径截断展示，悬停提供完整值。菜单锚定芯片上方，包含搜索、固定父目录行、目录列表、隐藏目录开关和刷新动作；大列表使用虚拟化。

搜索在当前目录的已加载结果中进行，目录名采用自然排序。方向键移动选项，Enter 执行选择，Escape 关闭菜单。菜单关闭后恢复撰写栏焦点，草稿与选区保持独立。

| 状态 | 呈现与操作 |
| --- | --- |
| 已确认 cwd | 展示完整绝对路径或基于该会话 home 的缩写 |
| 读取中 | 展示加载状态，等待当前请求结果 |
| 目录未知 | 展示未知状态与刷新入口 |
| Registry／Environment 等 PowerShell provider | 清空原目录与列表，展示 provider 状态提示 |
| 终端忙碌、敏感输入或半行输入 | 保留现有输入，目录操作返回对应状态 |
| 目录读取／切换错误 | 展示可恢复错误，后续刷新以实际 cwd 为准 |

## 路径与执行

执行目标保留文件系统中的绝对路径，显示层负责 home 缩写和控制字符可视化。POSIX 根、Windows 盘符根和 UNC share 根分别计算父级；目录链接通过 realpath 与实际 cwd 确认。

POSIX 使用现有交互 `cd` 引用规则。PowerShell 使用模块限定的 `Set-Location -LiteralPath`，对 ASCII 和弯单引号应用对应转义。含终端控制字节的名称作为可见数据展示，快捷切换采用安全路径资格检查。

每次操作绑定终端、连接代次和 cwd revision。路径解析后再次验证目标及就绪状态，再写入该终端；实际 cwd 上报或严格查询负责确认结果。广播设置与撰写栏发送保持各自职责。

## 实现分工

| 模块 | 职责 |
| --- | --- |
| `domain/directoryPath.ts`、`directoryPicker.ts` | POSIX／Win32 路径、目录条目、显示与命令策略 |
| `terminalDirectoryController.ts` | 能力检查、代次保护、路径解析与结果确认 |
| `useTerminalDirectorySession.ts` | 根据终端环境注册适配器 |
| `useComposeDirectoryPicker.ts` | 菜单状态、列表生命周期和 revision 绑定 |
| `terminalDirectory.ts` | 本地 FS、原生 PowerShell 状态和 exact-session SFTP |
| `powerShellDirectoryIntegration.cjs`、`shellIntegration/directory.ps1` | 会话启动、位置报告与输出过滤 |
| `ComposeDirectoryPicker.tsx` | 菜单呈现、焦点、键盘导航和虚拟化 |

当前覆盖 macOS／Linux 本地 POSIX、符合连接能力的 Unix SSH，以及 Windows PowerShell 5.1／7 的 FileSystem 位置。CMD、WSL／兼容层和扩展远程环境按独立阶段接入。
