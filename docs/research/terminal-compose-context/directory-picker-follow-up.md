# Directory Picker：开发计划

目标是让各类终端共享目录菜单与状态编排，由各环境适配器提供位置、文件系统、命令和确认能力。设计依据见 [跨平台设计](directory-picker-cross-platform.md)，交互职责见 [功能规格](directory-picker.md)。

## 当前交付

| 阶段 | 已实现 | 设计理由 |
| --- | --- | --- |
| A：路径与能力 | POSIX／Win32 路径模型；盘符／UNC 根；authority、cwd revision；独立 read／list／change／confirm 能力；可注入命令策略 | 将目标文件系统和 shell 语法分别建模，保持菜单可复用 |
| B：PowerShell | 5.1／7 会话级脚本；原 runspace ProviderPath；私有位置报告；本地 FS；LiteralPath 切换和实际结果确认 | 用原 shell 状态串联展示、读取和执行 |
| C：CMD | 交互 CMD 的 PROMPT 上报；盘符目录读取与 `cd /d` 切换；原进程和新提示符确认 | 复用目录控制器，按 CMD 的变量展开和进程继承划定支持范围 |
| D1：Git Bash | 绑定原 Git for Windows Bash，读取 MSYS cwd 并映射为 Windows 盘符路径 | 保留 Bash 启动行为，复用 Windows 文件系统和目录控制器 |
| D2：WSL | 从原交互 Bash 读取 POSIX cwd，在同发行版和用户下解析路径、枚举目录并确认切换 | 保留 WSL 启动配置，让 Linux 目录和 Windows 挂载盘共享同一会话身份 |
| 状态恢复 | provider 切换清空旧目录与列表；恢复 FileSystem 后重新读取；提交输入使旧报告失效 | 让菜单始终对应当前有效的文件系统位置 |
| 生命周期 | 单会话请求排序、旧控制器失效、受管脚本清理、终端就绪门控 | 将异步操作与实际会话代次绑定 |

Windows CI 使用原生 ConPTY 覆盖 PowerShell 5.1／7 以及 CMD 的特殊字符、跨盘符和嵌套会话。macOS／Linux 继续覆盖真实 POSIX PTY 和 SSH fixture。

## 后续阶段

| PR 顺序 | 交付范围 |
| --- | --- |
| 1. WSL | Ubuntu Bash 的 Directory Picker，覆盖 Linux 目录和挂载盘。 |
| 2. Cygwin | 识别原 Bash 及其挂载，接入目录枚举、跳转和确认。 |
| 3. Git Branch | 识别当前工作树，读取分支并确认切换。见 [Git Branch](git-branch.md)。 |
| 4. Git Changes | 复用工作树状态，提供变更统计和详情入口。见 [Git Changes](git-changes.md)。 |
| 5. Pull Request | 使用当前工作树和分支关联托管服务。见 [Pull Request](pull-request.md)。 |
| 6. Node Version | 独立接入当前 shell 和版本管理器。见 [Node Version](node-version.md)。 |

### PowerShell 覆盖扩展

继续补充主题／profile 组合、prompt 内位置变化、受限语言模式、大小写敏感目录和共享目录权限场景。每项先建立原生 ConPTY fixture，再完善能力状态和路径确认策略。

### B2：POSIX 会话级上报

调研并实现各 shell 的启动与事件适配：

- bash：兼容 3.2，覆盖 PROMPT_COMMAND 的标量／数组形式与 login／rc 语义。
- zsh：覆盖 ZDOTDIR、login 启动链及 precmd／chpwd hook。
- fish：采用独立引用和事件，保留现有 prompt 函数。
- dash／ash：继续使用进程 cwd 回退，并评估事件上报能力。

交付目标是复用位置报告和控制器，保留原 prompt、PATH、历史与命令状态，按有效集成优先使用事件更新。

### CMD 覆盖扩展

为 `%`、`!` 目录验证保留字面值的传递方式；为自定义 AutoRun、关闭命令扩展和前后台子进程补充原生用例。UNC 的 `pushd`／`popd` 单独定义临时盘符、目录栈和退出清理语义。

### D2：WSL

启动时通过 `WSLENV` 传入会话标记，保留原登录 shell 和配置。辅助进程在同一发行版和用户下运行，通过 `/proc` 绑定原 Bash 及其终端。目录读取使用 Linux 路径，切换结果由原 Bash 的 cwd 确认。

首轮以带 Python 3.10 及以上版本的 Ubuntu Bash 为目标。WSL 1 已覆盖原生 ConPTY 核心行为。后续补充 WSL 2、其他发行版及 shell，并评估更轻量的辅助进程实现。

### D3：Cygwin

先确认 Cygwin 进程与终端的对应关系，再验证 `/cygdrive`、自定义挂载、符号链接和 Unicode。由同一安装的工具读取 cwd 和目录，保留原路径命名空间。Git Bash 后续扩展共享路径和虚拟挂载。

### E：扩展远程与嵌套 shell

依次覆盖 Windows OpenSSH、su／sudo、tmux／screen、容器、SFTP chroot、单通道跳板及 mosh／ET。每个适配明确活动 shell、连接代次和文件系统映射，复用 exact-session 访问约束。

远程集成脚本的部署方式、配置持久性和权限交互在对应阶段定义。

## 推进方式

每阶段先形成真实 shell／传输实验，再实现对应路径和命令策略，最后接入能力并补齐回归。阶段完成后更新本文交付表及跨平台设计中的实现说明；README 保持索引职责。
