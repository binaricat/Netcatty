# Terminal Compose Context Chips

Context Chips 位于终端撰写栏的快捷命令与输入区之间，为当前聚焦终端提供目录、仓库和运行时上下文。芯片沿用终端主题，使用紧凑布局、悬停详情和键盘导航；窄分屏优先保留目录信息。

“设置 → 终端 → Context Chips”控制整行显示，默认开启。草稿和选区由撰写栏独立维护，目录操作通过绑定会话的执行入口完成。

## 功能与文档

| 功能 | 当前范围 | 文档 |
| --- | --- | --- |
| Directory Picker | 目录展示、当前层搜索、父级／子目录导航；POSIX 与 Windows PowerShell 适配 | [功能规格](directory-picker.md) · [跨平台设计](directory-picker-cross-platform.md) · [开发计划](directory-picker-follow-up.md) |
| Git Branch | 后续接入仓库识别、分支读取与切换 | [Git Branch](git-branch.md) |
| Git Changes | 后续接入变更统计与详情入口 | [Git Changes](git-changes.md) |
| Node Version | 后续接入当前 shell 的运行时与版本管理器 | [Node Version](node-version.md) |
| Pull Request | 后续接入仓库／分支对应的托管服务查询 | [Pull Request](pull-request.md) |

[目录交互示意](directory-picker-demo.html) 使用示例数据展示菜单行为。

## 架构

- `domain/` 管理路径、过滤、排序、显示和操作资格。
- `application/state/` 管理会话绑定、请求生命周期、cwd revision 和结果确认。
- `infrastructure/services/` 与 Electron bridge 提供目标文件系统读取及交互 shell 适配。
- `components/terminal/` 消费 view model，维护菜单、焦点和主题呈现。

目录操作依次经过目标身份、路径、终端就绪与敏感输入检查，并以原交互 shell 的实际 cwd 确认结果。读取和执行共享同一会话身份；菜单观察需求通过现有 registry 合并，关闭芯片时释放额外刷新需求。

后续 Git 芯片共享 repo／worktree 状态，Node 芯片使用 shell／管理器适配，PR 芯片独立管理服务身份和网络状态。详细 Git 变更面板通过现有 per-terminal 侧栏布局接入。
