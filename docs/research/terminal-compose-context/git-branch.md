# Git Branch：分支显示与切换

日期：2026-10-29。状态：初步调研，切换行为尚待验证。

## 功能目标

在当前终端位于 Git 仓库时显示分支图标和名称，点击弹出可搜索的分支列表，选择后切换该终端所对应仓库／worktree 的分支。非仓库时隐藏；detached HEAD 显示短提交哈希。长名称在芯片内截断，菜单提供完整名称。

## Warp 参考行为

已观察到分支搜索框、完整分支条目和整行高亮；芯片采用前部省略、保留尾部的展示。官方更新日志还包含 detached HEAD 展示短哈希及创建新分支入口。尚未亲自验证候选分支范围、选择后的关闭时机和切换结果。

## 拟议交互

- 点击芯片打开上方菜单，搜索框获焦；菜单样式与目录选择器一致。
- 当前分支有明确标记；上下键移动活动项，Enter 选择，Escape 关闭。
- 切换动作绑定当前 session 与 worktree，不参与终端广播，也不发送或清空命令草稿。
- 只有实际分支状态确认后才更新芯片；失败保留当前分支并显示原因。
- 遇到未提交改动冲突，不隐式 stash 或丢弃变更。创建分支、远程跟踪分支是否包含仍待确定。

## 待查清的行为

| 主题 | 问题 |
| --- | --- |
| 分支列表 | 本地／远程候选范围、排序、搜索规则、当前项标识 |
| 切换动作 | 执行方式、菜单关闭时机、结果确认及失败反馈 |
| 特殊状态 | 空仓库、unborn branch、detached HEAD、分支被删除 |
| worktree | `.git` 为文件、另一 worktree 占用目标分支、不同终端指向不同 worktree |
| 环境 | local／SSH、Git 缺失、权限或锁文件、忙碌终端时的能力限制 |
| 新建分支 | 入口、名称校验、起点与确认过程；是否纳入本期 |

仓库识别与刷新可和 [Git Changes](git-changes.md) 共用。切 cwd／会话或重连后，旧分支列表和切换结果必须失效。

参考：[Warp prompt](https://docs.warp.dev/terminal/appearance/prompt/)；[2025 changelog](https://docs.warp.dev/changelog/2025/)的分支搜索；[2026 changelog](https://docs.warp.dev/changelog/2026/)的创建分支记录；[2023 changelog](https://docs.warp.dev/changelog/2023/)的 detached HEAD 展示。
