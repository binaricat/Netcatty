# Directory Picker：开发计划

目标是让各类终端共享目录菜单与状态编排，由各环境适配器提供位置、文件系统、命令和确认能力。设计依据见 [跨平台设计](directory-picker-cross-platform.md)，交互职责见 [功能规格](directory-picker.md)。

## 当前交付

| 阶段 | 已实现 | 设计理由 |
| --- | --- | --- |
| A：路径与能力 | POSIX／Win32 路径模型；盘符／UNC 根；authority、cwd revision；独立 read／list／change／confirm 能力；可注入命令策略 | 将目标文件系统和 shell 语法分别建模，保持菜单可复用 |
| B：PowerShell | 5.1／7 会话级脚本；原 runspace ProviderPath；私有位置报告；本地 FS；LiteralPath 切换和实际结果确认 | 用原 shell 状态串联展示、读取和执行 |
| 状态恢复 | provider 切换清空旧目录与列表；恢复 FileSystem 后重新读取；提交输入使旧报告失效 | 让菜单始终对应当前有效的文件系统位置 |
| 生命周期 | 单会话请求排序、旧控制器失效、受管脚本清理、终端就绪门控 | 将异步操作与实际会话代次绑定 |

路径与状态回归覆盖盘符、UNC、链接、特殊字符、控制字节、草稿、广播隔离、重连和关闭芯片。Windows 原生 ConPTY 覆盖 PowerShell 5.1／7、PSDrive、provider、执行策略、状态码及真实 terminal bridge；现有 Windows CI 显式执行该组用例。macOS／Linux 继续覆盖真实 POSIX PTY 和 SSH fixture。

## 后续阶段

### PowerShell 覆盖扩展

继续补充主题／profile 组合、prompt 内位置变化、受限语言模式、大小写敏感目录和共享目录权限场景。每项先建立原生 ConPTY fixture，再完善能力状态和路径确认策略。

### B2：POSIX 会话级上报

调研并实现各 shell 的启动与事件适配：

- bash：兼容 3.2，覆盖 PROMPT_COMMAND 的标量／数组形式与 login／rc 语义。
- zsh：覆盖 ZDOTDIR、login 启动链及 precmd／chpwd hook。
- fish：采用独立引用和事件，保留现有 prompt 函数。
- dash／ash：继续使用进程 cwd 回退，并评估事件上报能力。

交付目标是复用位置报告和控制器，保留原 prompt、PATH、历史与命令状态，按有效集成优先使用事件更新。

### C：CMD 原生导航

先完成 PROMPT、`cd /d`、命令扩展、delayed expansion、百分号／感叹号、编码和 ERRORLEVEL 的交互实验，再接入独立命令策略。

首个交付覆盖已验证的盘符绝对目录，并将路径限制体现为明确能力状态。UNC 的 pushd／popd 方案单独定义临时盘符、目录栈和退出清理语义。

### D：WSL、Git Bash 与 Cygwin

为每类环境定义文件系统 authority、cwd 来源、结构化目录 helper 与执行策略：

- WSL：绑定所选 distro，验证 Linux home、挂载盘及 wslpath／UNC 映射。
- MSYS／Cygwin：验证 mount、驱动器、链接和编码转换。
- helper：保留原始名称、类型和目录链接，提供输出边界、取消及权限状态。

交付目标是让目录读取与命令执行处于同一命名空间，并按 distro／mount 身份组织缓存。

### E：扩展远程与嵌套 shell

依次覆盖 Windows OpenSSH、su／sudo、tmux／screen、容器、SFTP chroot、单通道跳板及 mosh／ET。每个适配明确活动 shell、连接代次和文件系统映射，复用 exact-session 访问约束。

远程集成脚本的部署方式、配置持久性和权限交互在对应阶段定义。

## 推进方式

每阶段先形成真实 shell／传输实验，再实现对应路径和命令策略，最后接入能力并补齐回归。阶段完成后更新本文交付表及跨平台设计中的实现说明；README 保持索引职责。
