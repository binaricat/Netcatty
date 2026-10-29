# Pull Request：关联 PR 显示与查看

日期：2026-10-29。状态：初步调研，尚未形成实施规格。总体目标与架构影响见 [README](README.md)。

## 目标与范围

通过 **Pull Request Chip** 显示当前仓库／分支关联的 PR，并提供明确查看动作。创建、评论、提交、合并和 CI 操作不自动纳入。依赖 Git 上下文和远程查询，但联网失败不应阻塞目录导航或本地 Git 展示。

## 已知参考行为

本机 Warp 芯片行显示过 `PR #4056`。官方 2026-03-25 的更新日志记录：AI 输入模式中，当前分支有开放 GitHub PR 时可显示 PR 芯片。这个记录不能直接泛化为所有输入模式、平台或代码托管服务。

具体点击落点、认证来源、关联查询与多个候选的处理尚未验证。点击浏览器打开是可讨论的 Netcatty 方案，尚不能写成已确认的 Warp 行为。

## 待补充调研

| 主题 | 需确认 |
| --- | --- |
| 出现条件 | 无 PR、draft／open／closed／merged、状态过期 |
| 点击 | 浏览器、菜单或内嵌面板；hover 详情与 URL |
| 关联 | 多 remote、fork、同名分支、多个 PR、不同 base 与跨仓库 PR |
| 服务与身份 | GitHub／Enterprise／GitLab 的实际支持，私有仓库和认证边界 |
| 查询来源 | 参考产品可确认的机制与 Netcatty 可复用适配，不靠文案猜 API |
| 失败与刷新 | 离线、未登录、限流、切分支／目录、重连、缓存与旧结果失效 |
| 环境 | local／SSH 使用哪一侧身份，provider 不支持的反馈 |

## 功能范围待确定

先能明确说明“这个 PR 为什么属于当前终端的这个仓库和分支”，并验证点击与常见失败路径。未查询到、没有关联和查询失败应分开呈现。

慢请求和身份切换不能污染另一个终端；共享仓库／会话边界见 [README](README.md)。

参考：[Warp prompt](https://docs.warp.dev/terminal/appearance/prompt/)；[2026 changelog](https://docs.warp.dev/changelog/2026/)。
