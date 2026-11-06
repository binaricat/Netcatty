# Node Version：版本显示与切换

日期：2026-10-29。状态：初步调研，尚未形成实施规格。总体目标与架构影响见 [README](README.md)。

## 目标与范围

通过 **Node Version Chip** 显示当前终端实际使用的 Node 版本。版本管理器发现、可用版本列表、切换当前 shell 版本是额外能力，应分别确定范围，不能用 Electron 主进程的 Node 版本替代用户终端版本。

## 已知参考行为

Warp 已有 Node 版本芯片，官方 2025-09-10 更新日志记录点击切换版本。本机观察到芯片显示 `v26.13.0`，菜单却提示没有已安装版本，并提供 `nvm install node` 入口。菜单为空不能解释为“系统没有 Node”；当前 PATH 中可用的版本与管理器可管理的列表需要分开建模。

本机安装包的只读资源检查支持 nvm 管理的菜单线索，以及在启用芯片时按目录与 PATH 缓存版本检测的脚本路径。官方 2026-06-10 也记录了避免每次 prompt 启动 Node 的缓存修复。静态线索不等于已验证实际切换，也不能据此断言所有平台／管理器的行为。

## 待补充调研

| 主题 | 需确认 |
| --- | --- |
| 显示条件 | package.json、祖先目录、无 Git 项目、worktree、Node 缺失 |
| 版本列表 | 多版本排序、当前项、别名、没有可用版本的状态 |
| 切换流程 | 直接执行还是填入编辑器；关闭时机；目标 shell 的版本与 PATH 确认 |
| 管理器 | nvm 不存在、未加载、非 nvm 安装；首个支持范围 |
| 安装入口 | 命令按钮实际行为、确认过程与失败反馈 |
| 刷新 | cd、PATH 变化、外部版本切换、缓存失效与性能 |
| 环境 | bash／zsh／fish／PowerShell、local／SSH 的差异 |

## 功能范围待确定

至少验证一次“列表 → 选择 → 当前交互 shell 版本确认”，以及无管理器、空列表和失败状态。可先只做展示，再增加 nvm；fnm、Volta、asdf、mise 等均需独立调研。

共享提供器应区分 `activeVersion`、`managerKind`、`installedVersions` 和切换能力。

参考：[Warp prompt](https://docs.warp.dev/terminal/appearance/prompt/)；[2026 changelog](https://docs.warp.dev/changelog/2026/)。

Node 版本切换另见 [2025 changelog](https://docs.warp.dev/changelog/2025/)。
