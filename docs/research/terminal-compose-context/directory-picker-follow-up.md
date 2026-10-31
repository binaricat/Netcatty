# Directory Picker：后续开发计划

日期：2026-10-30。目标是在现有目录芯片上补齐 Windows 原生终端与常用 shell 支持，同时保持 macOS／Linux／普通 SSH 的既有行为。技术依据、实验与官方来源见 [跨平台研究](directory-picker-cross-platform.md)；当前功能规格见 [directory-picker.md](directory-picker.md)。

## 1. 当前交付与后续范围

当前 PR 实现目录菜单、绝对路径切换、真实 cwd 确认、手动 cd 联动及默认开启的 Context Chips 设置。Windows 本地、WSL／Git Bash／Cygwin 仍为不可用，不应先撤销门槛再寻找兼容方案。

后续按**路径与能力 → Windows PowerShell → CMD → WSL／兼容层 → 扩展远程**推进。macOS／Linux 的会话集成可与 PowerShell 阶段复用协议基础，但不同 shell 独立验收，不要求为增加一个平台一次性重写全部终端。

## 2. 统一能力与状态

不能只有一个 `supported`：至少分别描述 `readCwd`、`listDirectories`、`changeDirectory`、`confirmChange`。只有目标环境和这些能力一致，菜单才可执行切换。例如收到 OSC cwd 但没有正确的 WSL 枚举能力时，只能展示位置；没有可用的安全执行／确认时不能给出可操作假象。

候选能力快照应包含下列语义；这是规划，不是当前新增的公共 RPC 协议：

| 字段 | 用途 |
| --- | --- |
| session／connection／shell generation | 绑定实际目标，重连与嵌套 shell 变化废弃旧请求 |
| shell kind／version／confidence | 区分 spawn 信息、登录 hint 与当前活动 shell；未知时拒绝危险猜测 |
| filesystem authority／path flavor | native-win32、posix、wsl:distro、msys、cygwin、ssh 等环境身份 |
| provider／cwd／home／source／revision | 表示 FileSystem、非文件系统、未知与过期；保留单会话排序 |
| integration status／capabilities | active、fallback、unsupported、policy-blocked 等可解释状态 |

UI 显示值可以缩写和截断；执行目标保留对应命名空间的绝对路径。调用前重新校验 cwd revision／身份，结果按真实上报确认，不能只因命令已写入就宣布成功。关闭工具栏停止其额外工作，但不能拆掉其他功能仍在消费的共享集成。

## 3. 阶段 A：路径、能力及确认边界

**交付**：抽出按 path flavor 的解析、父目录、拼接、比较和显示逻辑，扩展目录控制器所需的 typed capability；保持现有 UI 与 POSIX 默认行为。

调整位置：`domain/directoryPicker.ts`、`terminalDirectoryController.ts`、`useTerminalDirectorySession.ts`、`infrastructure/services/terminalDirectory.ts` 及对应 bridge 类型。将变更目录的意图构造注入控制器或放入明确 shell 适配，不让控制器固定引用唯一 POSIX builder。

优先复用 `resolveInteractiveTerminalCdIntent` 的 POSIX 路径与控制字节规则。PowerShell／CMD 新策略不得直接改变该函数现有恢复目录／SFTP 调用者的契约。现有 AI helper 仅提取经过验证的纯引用函数，避免复用含子 shell／eval 的执行包装。

**验收门槛**：POSIX `/`、Windows `C:\`、UNC `\\server\share\`、相对盘符 `C:foo`、大小写和 symlink 不混淆；文件系统 authority 不同的同名路径永不互用。旧的目录、广播、草稿、会话失效、关闭 chips 和 SFTP 测试保持通过。

## 4. 阶段 B：shell 报告基础与 PowerShell 5.1／7

**交付**：本地 PowerShell FileSystem 目录展示、子目录／父目录导航、手动切换联动、真实结果确认。目标包括项目支持 Windows 版本上的系统 Windows PowerShell 5.1 和用户安装的 PowerShell 7；具体 Windows build 按当时 Electron／ConPTY 支持矩阵验证，不能用“包能打出来”代替实机支持。

实施点：

1. 在 `electron/bridges/terminalBridge.cjs` 的 spawn 参数解析后加入可测试的会话启动方案；脚本由 `tempDirBridge` 管理。保留 profile、PSReadLine、用户启动参数和原 prompt。未知参数／策略阻止时不注入，不改执行策略。
2. 位置取自该 runspace 的 FileSystem ProviderPath；`HKLM:` 等报告为非文件系统。切换使用 LiteralPath 和 PowerShell 引用，在原 shell 生效。
3. worker 接收并归一化 shell 状态，随后通过既有 session 事件／preload 传递给应用层。协议版本、字段转义、最大长度、旧代次与来源必须可验证；是否复用 OSC 633 在此阶段明确。
4. cwd 报告与就绪证明分开；敏感输入、半行草稿和 TUI 仍会阻止注入。不能把可以打印任意 OSC 的进程当成 host authority。
5. 使用本地 FS 读取原生 Windows 路径；新进入的盘符／UNC 要重新校验，FileSystem home 才可显示为 `~`。

**验收门槛**：Windows 实际 ConPTY 中验证切换盘符、空格、中文、单引号、方括号、`$`、反引号、只读目录、删除目录、policy-blocked、`-NoProfile`、自定义 prompt。registry／Env provider 不冒充本地目录；PowerShell 5.1 不使用仅 6+ 可用的 ESC 语法。启动失败不能损坏用户 profile，关闭后无持久配置变更。

同一基础在 macOS／Linux 新会话内按 shell 启用：bash 兼容 3.2 的 cwd hook，zsh 的 precmd／chpwd，fish 的事件。无法集成的 dash／ash 保留现有进程回退。完整命令生命周期在不同旧版本上未必可用，不能为 cwd 功能强制要求全部实现 preexec。

## 5. 阶段 C：CMD 原生路径导航

**交付**：会话级 cwd 上报、盘符切换、普通路径菜单、清楚的受限路径提示。

PROMPT 包装保留用户原值，`$P` 提供位置。`cd /d` 必须在原 CMD 中执行，不经另一个 `cmd /c`。独立实现并验证交互／batch 转义、命令扩展、`%`／`!`、编码与 ERRORLEVEL；不要通过临时改变 delayed expansion／AutoRun 绕过问题。

**范围选择**：可先支持经过验证的盘符绝对目录，对 `%`／`!` 和 UNC 明确不可切换。UNC 如果以后采用 pushd／popd，要先定义临时盘符、目录栈、退出及失败清理，不把这个动作伪装成无副作用的 cd。

**验收门槛**：命令扩展开／关、delayed expansion 开／关、默认／自定义 PROMPT、空格／中文／`&`／`^`／`%`／`!`、从 C 到 D、访问被拒、共享不可达。UI 不能把拒绝／失败当 `± 0` 类的空成功；不执行多余命令、不改变父 CMD 之外的进程来冒充结果。

## 6. 阶段 D：WSL、Git Bash 与 Cygwin

**交付**：明确目标 distro／兼容层的 cwd 与目录读取适配。Windows 上只是发现了 bash.exe／wsl.exe，不足以启用 Directory Picker。

- WSL 在所选 distro 内获取 shell 上报和结构化目录数据，验证 distro 身份及 `wslpath`／UNC 映射策略；同一路径不能跨 distro 复用缓存。WSL1／2 的支持范围按实测决定。
- Git Bash／Cygwin 各自验证 mount／drive／symlink 映射，不能把 POSIX 路径字符串直接交给 Windows `fs`。
- helper 协议保留原始名称、文件类型和目录链接；支持有限输出、取消、权限失败。不得使用 `ls` 的展示文本做机器目录清单。

**验收门槛**：Linux home、Windows 挂载盘、两个 distro 相同路径、大小写敏感目录、链接、编码、启动参数和 unavailable provider。不支持的映射有具体提示；测试不得通过修改用户 distro 配置来获得成功。

## 7. 阶段 E：远程与嵌套 shell

普通 Unix SSH 保留当前严格探测和 exact-session SFTP 约束。远程集成是目标 shell 的独立能力，不随本机启动脚本自动生效。已有显式 OSC 7 配置写 rc，与后续无持久化注入必须在 UI 和权限上区分。

逐项处理 SSH 到 Windows、su／sudo、嵌套 shell、tmux／screen、容器、mosh／ET、SFTP chroot 和单通道跳板。一个 cwd 报告不能证明登录用户的 SFTP 有相同目录视图；无法证明映射或当前活动 shell 身份时，保持不可用，不新建另一个登录。

**验收门槛**：连接及 shell 代次变更、主机不同的同名 cwd、权限跨用户、拒绝额外通道、工作目录已删除、重连／hibernate／附加窗口。自动安装远端脚本不纳入当前计划的默认行为；必须经独立范围确认。

## 8. 必须保留的回归与完成标准

| 类别 | 验收内容 |
| --- | --- |
| 命令与路径 | 每个 shell 的实际输入结果；绝对路径不受 CDPATH／异步 cwd 改变影响；特殊字符不执行额外代码 |
| shell 生命周期 | prompt、原状态码、PATH、历史与主题不被破坏；login、无 profile、特殊启动参数有明确行为 |
| 协议 | 分片／合并、BEL／ST、编码、Windows URI、大小上限、伪造／旧报告、重复集成和 nonce 限制 |
| 正确性 | 手动 cd、函数 cd、延迟 cd、失败 cd、逻辑／物理路径、provider 切换、目录列表与真实 cwd 一致 |
| 安全与目标 | 密码／MFA／sudo、TUI、半行输入、广播开启、切焦点／重连：没有错误目标写入 |
| 平台 | Windows 原生 ConPTY 的 5.1／7／CMD；macOS 系统 bash 3.2 与 zsh；Linux bash／dash／ash／fish／zsh |
| 发行版 | Ubuntu／Debian、Fedora／Rocky 或 Alma、Arch、Alpine 作为后端 shell 样本；不把同一 shell 的语法复制测试替代真实环境 |
| 性能 | 有效集成优先事件更新，回退探测合并／单飞／有超时；空闲不额外轮询，关闭 chips 不产生其额外读写 |
| 打包 | 外部 shell 使用真实脚本资源或受管副本，不依赖 asar 虚拟路径；native helper 如有新增，验证各架构与签名；资源变更通过 `npm run pack:dir` |

现有 domain、controller、registry、hook、真实 PTY、SSH fixture 与 Windows CI 是起点。后续 Windows 测试必须使用真实 Windows shell／ConPTY 验证 runspace 状态，不能仅靠 Linux mock 或 Windows 编译成功。是否开启某个平台，由这些验收结果决定，不以删除平台 gate 作为完成标准。

当前 PR 只追加研究与规划；阶段 A–E 的产品实现、脚本安装及协议扩展由后续独立改动完成。
