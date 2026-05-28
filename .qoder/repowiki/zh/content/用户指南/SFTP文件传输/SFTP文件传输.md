# SFTP文件传输

<cite>
**本文引用的文件**
- [SftpPaneView.tsx](file://components/sftp/SftpPaneView.tsx)
- [SftpPaneFileList.tsx](file://components/sftp/SftpPaneFileList.tsx)
- [SftpPaneTreeView.tsx](file://components/sftp/SftpPaneTreeView.tsx)
- [SftpPaneToolbar.tsx](file://components/sftp/SftpPaneToolbar.tsx)
- [SftpFileRow.tsx](file://components/sftp/SftpFileRow.tsx)
- [SftpContext.tsx](file://components/sftp/SftpContext.tsx)
- [useSftpViewFileOps.ts](file://components/sftp/hooks/useSftpViewFileOps.ts)
- [SftpTransferQueue.tsx](file://components/sftp/SftpTransferQueue.tsx)
- [types.ts](file://application/state/sftp/types.ts)
- [useSftpPaneActions.ts](file://application/state/sftp/useSftpPaneActions.ts)
- [useSftpTransfers.ts](file://application/state/sftp/useSftpTransfers.ts)
</cite>

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能考量](#性能考量)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录](#附录)

## 简介
本指南面向最终用户，系统讲解 Netcatty 中 SFTP 文件传输功能的使用方法与最佳实践。内容覆盖双面板文件浏览器（列表视图与树形视图）、文件操作（复制/移动/删除/重命名/权限修改）、拖放上传/下载、文件关联与内置编辑器、传输队列管理（暂停/恢复/取消/重试）、以及安全性与性能优化建议。

## 项目结构
SFTP 功能由“UI 视图层 + 状态管理层 + 传输引擎”三层构成：
- 视图层：负责展示左右两个 SFTP 面板（列表/树），提供工具栏、面包屑、过滤、上下文菜单、拖放交互等。
- 状态层：维护每个面板的连接状态、文件列表、选择状态、过滤条件、编码设置、缓存与重连状态等。
- 传输层：封装上传/下载/目录传输、冲突处理、进度回调、重试与取消逻辑，并与后端桥接通信。

```mermaid
graph TB
subgraph "视图层"
Toolbar["工具栏<br/>面包屑/过滤/视图切换"]
List["文件列表视图"]
Tree["树形视图"]
Queue["传输队列"]
end
subgraph "状态层"
PaneState["SftpPane 状态<br/>连接/文件/选择/过滤/编码"]
Transfers["传输任务集合<br/>冲突/重试/取消"]
end
subgraph "传输层"
Bridge["后端桥接<br/>SFTP/本地文件操作"]
end
Toolbar --> PaneState
List --> PaneState
Tree --> PaneState
Queue --> Transfers
PaneState --> Bridge
Transfers --> Bridge
```

**图表来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpPaneToolbar.tsx:66-687](file://components/sftp/SftpPaneToolbar.tsx#L66-L687)
- [SftpPaneFileList.tsx:120-704](file://components/sftp/SftpPaneFileList.tsx#L120-L704)
- [SftpPaneTreeView.tsx:26-988](file://components/sftp/SftpPaneTreeView.tsx#L26-L988)
- [types.ts:1-74](file://application/state/sftp/types.ts#L1-L74)
- [useSftpTransfers.ts:19-990](file://application/state/sftp/useSftpTransfers.ts#L19-L990)

**章节来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [types.ts:1-74](file://application/state/sftp/types.ts#L1-L74)

## 核心组件
- 双面板视图容器：负责左右面板的可见性、激活态、懒加载树视图、路径同步与刷新。
- 工具栏：面包屑导航、过滤条、视图模式切换、新建文件/文件夹、隐藏文件显示、编码设置、刷新等。
- 文件列表视图：网格列头（名称/修改时间/大小/类型）、行渲染、上下文菜单、拖拽/放置、虚拟化滚动。
- 树形视图：按需加载子节点、展开/折叠、键盘导航、拖放移动、右键菜单、路径高亮。
- 传输队列：多级任务展示、父子任务联动、列宽可调、拖拽调整高度、暂停/恢复/取消/重试。
- 文件操作钩子：打开/编辑/下载/上传、文件关联（内置编辑器/系统应用）、权限修改。
- 状态管理：SftpPane 状态、文件操作动作、传输任务生命周期。

**章节来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpPaneToolbar.tsx:66-687](file://components/sftp/SftpPaneToolbar.tsx#L66-L687)
- [SftpPaneFileList.tsx:120-704](file://components/sftp/SftpPaneFileList.tsx#L120-L704)
- [SftpPaneTreeView.tsx:26-988](file://components/sftp/SftpPaneTreeView.tsx#L26-L988)
- [SftpTransferQueue.tsx:150-456](file://components/sftp/SftpTransferQueue.tsx#L150-L456)
- [useSftpViewFileOps.ts:13-900](file://components/sftp/hooks/useSftpViewFileOps.ts#L13-L900)
- [types.ts:1-74](file://application/state/sftp/types.ts#L1-L74)

## 架构总览
SFTP 双面板通过 Context 提供稳定的回调引用，避免因回调变更导致的重复渲染；文件操作通过状态层统一调度，传输层负责具体 IO 并与后端桥接通信。

```mermaid
sequenceDiagram
participant U as "用户"
participant V as "SftpPaneView"
participant C as "SftpContext"
participant S as "useSftpPaneActions"
participant T as "useSftpTransfers"
participant B as "后端桥接"
U->>V : 拖放文件到面板
V->>C : onUploadExternalFiles(...)
C->>S : 调用上传动作
S->>B : 写入远程文件/目录
B-->>S : 返回写入结果
S-->>V : 刷新当前目录
V-->>U : 显示成功/失败提示
U->>V : 右键菜单-下载
V->>C : onDownloadFile(...)
C->>T : 添加下载任务
T->>B : 启动流式下载
B-->>T : 进度/完成/错误
T-->>V : 更新队列状态
V-->>U : 队列中显示进度
```

**图表来源**
- [SftpContext.tsx:21-64](file://components/sftp/SftpContext.tsx#L21-L64)
- [useSftpPaneActions.ts:508-744](file://application/state/sftp/useSftpPaneActions.ts#L508-L744)
- [useSftpTransfers.ts:508-668](file://application/state/sftp/useSftpTransfers.ts#L508-L668)
- [useSftpViewFileOps.ts:272-425](file://components/sftp/hooks/useSftpViewFileOps.ts#L272-L425)

## 详细组件分析

### 双面板文件浏览器
- 面板容器与懒加载：仅在激活或需要时渲染树视图，减少内存占用。
- 视图模式：支持“列表/树”两种模式，切换时清空另一模式的排序/选择状态。
- 面包屑导航：双击进入路径编辑，支持历史与文件夹建议，快速跳转。
- 过滤条：输入关键字即时筛选文件名，Esc 关闭。
- 加载/错误/重连遮罩：导航期间保持旧内容，避免空白闪烁；断开重连时显示旋转指示。

```mermaid
flowchart TD
Start(["进入面板"]) --> Mode{"选择视图模式"}
Mode --> |列表| List["渲染文件列表视图"]
Mode --> |树形| Tree["懒加载树视图"]
List --> Toolbar["工具栏：面包屑/过滤/视图切换"]
Tree --> Toolbar
Toolbar --> Filter{"是否启用过滤"}
Filter --> |是| ApplyFilter["应用过滤条件"]
Filter --> |否| Ready["就绪"]
ApplyFilter --> Ready
Ready --> Drag{"是否有拖放数据"}
Drag --> |是| Drop["放置到目标位置"]
Drag --> |否| Idle["等待用户操作"]
```

**图表来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpPaneToolbar.tsx:66-687](file://components/sftp/SftpPaneToolbar.tsx#L66-L687)
- [SftpPaneFileList.tsx:120-704](file://components/sftp/SftpPaneFileList.tsx#L120-L704)
- [SftpPaneTreeView.tsx:26-988](file://components/sftp/SftpPaneTreeView.tsx#L26-L988)

**章节来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpPaneToolbar.tsx:66-687](file://components/sftp/SftpPaneToolbar.tsx#L66-L687)

### 文件列表视图与树形视图
- 文件列表视图
  - 表头：名称/修改时间/大小/类型，支持点击排序与列宽拖拽。
  - 行渲染：选中高亮、拖拽悬停高亮、双击打开、右键菜单。
  - 上下文菜单：打开/打开到/打开方式、编辑、下载、复制到另一面板、剪切路径、移动到上级、重命名、权限、删除、刷新、新建文件/文件夹、上传文件/文件夹。
  - 虚拟化：大列表自动虚拟化，提升滚动性能。
- 树形视图
  - 按需加载子节点，支持展开/折叠、键盘方向键导航、Shift 多选、Enter 打开。
  - 拖放：同面板内移动、跨面板复制/移动、从外部拖入上传。
  - 右键菜单：重命名、删除、新建、上传、移动到目标路径等。

```mermaid
classDiagram
class SftpPaneFileList {
+表头排序
+右键菜单
+拖拽/放置
+虚拟化渲染
}
class SftpPaneTreeView {
+按需加载
+键盘导航
+拖放移动
+右键菜单
}
class SftpFileRow {
+选中高亮
+拖拽悬停
+双击打开
}
SftpPaneFileList --> SftpFileRow : "渲染行"
SftpPaneTreeView --> SftpPaneFileList : "复用部分交互"
```

**图表来源**
- [SftpPaneFileList.tsx:120-704](file://components/sftp/SftpPaneFileList.tsx#L120-L704)
- [SftpPaneTreeView.tsx:26-988](file://components/sftp/SftpPaneTreeView.tsx#L26-L988)
- [SftpFileRow.tsx:12-165](file://components/sftp/SftpFileRow.tsx#L12-L165)

**章节来源**
- [SftpPaneFileList.tsx:120-704](file://components/sftp/SftpPaneFileList.tsx#L120-L704)
- [SftpPaneTreeView.tsx:26-988](file://components/sftp/SftpPaneTreeView.tsx#L26-L988)
- [SftpFileRow.tsx:12-165](file://components/sftp/SftpFileRow.tsx#L12-L165)

### 文件操作（复制/移动/删除/重命名/权限）
- 复制到另一面板：从源面板选择文件，右键“复制到另一面板”，目标面板自动接收并显示在当前目录。
- 移动/剪切：同面板内拖放至目录，或右键“移动到上级/移动到目标路径”；跨面板拖放默认复制。
- 删除：右键“删除”，弹出确认对话框；支持批量删除。
- 重命名：右键“重命名”或双击文件名，输入新名称。
- 权限修改：右键“权限”，弹出权限对话框进行修改（仅远程文件）。

```mermaid
sequenceDiagram
participant U as "用户"
participant L as "左侧面板"
participant R as "右侧面板"
participant S as "useSftpPaneActions"
U->>L : 右键-复制到另一面板
L->>S : onCopyToOtherPane(files)
S->>R : 接收文件列表
R-->>U : 当前目录显示新增文件
U->>L : 拖放文件到目录
L->>S : onMoveEntriesToPath(paths, target)
S->>S : 跨面板移动/同面板移动
S-->>L : 刷新当前目录
```

**图表来源**
- [useSftpPaneActions.ts:508-744](file://application/state/sftp/useSftpPaneActions.ts#L508-L744)
- [SftpPaneFileList.tsx:320-427](file://components/sftp/SftpPaneFileList.tsx#L320-L427)
- [SftpPaneTreeView.tsx:641-656](file://components/sftp/SftpPaneTreeView.tsx#L641-L656)

**章节来源**
- [useSftpPaneActions.ts:508-744](file://application/state/sftp/useSftpPaneActions.ts#L508-L744)
- [SftpPaneFileList.tsx:320-427](file://components/sftp/SftpPaneFileList.tsx#L320-L427)
- [SftpPaneTreeView.tsx:641-656](file://components/sftp/SftpPaneTreeView.tsx#L641-L656)

### 拖放上传/下载
- 拖放上传
  - 列表视图：在空白区域或目录上拖入文件/文件夹，自动上传到目标路径。
  - 树形视图：在节点上拖放，支持复制/移动/上传三种效果（根据来源与目标判断）。
- 拖放下载
  - 列表/树视图：右键“下载”，或直接拖拽文件到本地文件系统（若后端支持流式下载）。
- 批量传输
  - 选中多个文件后统一下载，避免多次弹窗；上传时支持 FileList 或 DataTransfer。

```mermaid
sequenceDiagram
participant U as "用户"
participant LV as "列表视图"
participant TV as "树形视图"
participant C as "SftpContext"
participant V as "useSftpViewFileOps"
U->>LV : 拖入文件到空白区域
LV->>C : onUploadExternalFiles(dataTransfer, target)
C->>V : uploadExternalFiles(...)
V-->>LV : 刷新当前目录/显示进度
U->>TV : 拖入文件到节点
TV->>C : onUploadExternalFiles(dataTransfer, target)
C->>V : uploadExternalFiles(...)
V-->>TV : 刷新目标目录
```

**图表来源**
- [SftpPaneFileList.tsx:609-618](file://components/sftp/SftpPaneFileList.tsx#L609-L618)
- [SftpPaneTreeView.tsx:731-781](file://components/sftp/SftpPaneTreeView.tsx#L731-L781)
- [useSftpViewFileOps.ts:272-425](file://components/sftp/hooks/useSftpViewFileOps.ts#L272-L425)

**章节来源**
- [SftpPaneFileList.tsx:609-618](file://components/sftp/SftpPaneFileList.tsx#L609-L618)
- [SftpPaneTreeView.tsx:731-781](file://components/sftp/SftpPaneTreeView.tsx#L731-L781)
- [useSftpViewFileOps.ts:272-425](file://components/sftp/hooks/useSftpViewFileOps.ts#L272-L425)

### 文件关联与内置编辑器
- 文件关联
  - 支持“内置编辑器”或“系统应用”两种打开方式；可保存扩展名默认打开器。
  - 右键“打开方式”可弹出选择器，支持选择系统应用并设为默认。
- 内置编辑器
  - 文本文件直接在内置编辑器中打开，支持语言识别、自动同步（可选）。
  - 编辑完成后保存，系统会校验当前连接是否仍指向同一主机，防止写错目标。

```mermaid
flowchart TD
Open["右键-打开/打开方式"] --> HasAssoc{"已配置默认打开器?"}
HasAssoc --> |是| Type{"类型"}
Type --> |内置编辑器| Edit["打开内置编辑器"]
Type --> |系统应用| Sys["下载到临时文件并用系统应用打开"]
HasAssoc --> |否| Picker["弹出选择器"]
Picker --> SaveDefault{"设为默认?"}
SaveDefault --> |是| Assoc["保存扩展名默认打开器"]
SaveDefault --> |否| Open
Assoc --> Open
```

**图表来源**
- [useSftpViewFileOps.ts:107-172](file://components/sftp/hooks/useSftpViewFileOps.ts#L107-L172)
- [SftpPaneFileList.tsx:287-321](file://components/sftp/SftpPaneFileList.tsx#L287-L321)

**章节来源**
- [useSftpViewFileOps.ts:107-172](file://components/sftp/hooks/useSftpViewFileOps.ts#L107-L172)
- [SftpPaneFileList.tsx:287-321](file://components/sftp/SftpPaneFileList.tsx#L287-L321)

### 传输队列管理
- 展示与交互
  - 支持父任务展开查看子任务；列宽可调；拖拽调整面板高度。
  - 支持暂停/恢复、取消、重试；完成/取消任务可一键清理。
- 错误处理与重试
  - 单文件失败不阻塞整目录；部分失败时禁用自动重试以避免重复覆盖。
  - 支持批量冲突处理（替换/跳过/去重/停止）。
- 进度监控
  - 实时更新已传输字节、总大小、速度；支持外部下载任务注入队列。

```mermaid
sequenceDiagram
participant U as "用户"
participant Q as "SftpTransferQueue"
participant T as "useSftpTransfers"
participant B as "后端桥接"
U->>Q : 点击重试
Q->>T : retryTransfer(id)
T->>B : 重新发起传输
B-->>T : 进度/完成/错误
T-->>Q : 更新任务状态
Q-->>U : 队列中显示最新状态
```

**图表来源**
- [SftpTransferQueue.tsx:150-456](file://components/sftp/SftpTransferQueue.tsx#L150-L456)
- [useSftpTransfers.ts:631-668](file://application/state/sftp/useSftpTransfers.ts#L631-L668)

**章节来源**
- [SftpTransferQueue.tsx:150-456](file://components/sftp/SftpTransferQueue.tsx#L150-L456)
- [useSftpTransfers.ts:631-668](file://application/state/sftp/useSftpTransfers.ts#L631-L668)

## 依赖关系分析
- 组件耦合
  - SftpPaneView 作为根容器，聚合工具栏、列表/树视图、对话框与传输队列。
  - SftpContext 提供稳定回调，降低 props 钻取与重渲染。
  - useSftpPaneActions 与 useSftpTransfers 分别封装文件操作与传输逻辑，职责清晰。
- 外部依赖
  - 后端桥接负责实际的 SFTP/本地文件读写、统计、权限修改、流式下载等。
  - 国际化与主题库提供文案与样式支持。

```mermaid
graph LR
SftpPaneView["SftpPaneView"] --> SftpContext["SftpContext"]
SftpPaneView --> SftpPaneToolbar["SftpPaneToolbar"]
SftpPaneView --> SftpPaneFileList["SftpPaneFileList"]
SftpPaneView --> SftpPaneTreeView["SftpPaneTreeView"]
SftpPaneView --> SftpTransferQueue["SftpTransferQueue"]
SftpContext --> useSftpPaneActions["useSftpPaneActions"]
useSftpPaneActions --> useSftpTransfers["useSftpTransfers"]
useSftpPaneActions --> Bridge["后端桥接"]
useSftpTransfers --> Bridge
```

**图表来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpContext.tsx:125-223](file://components/sftp/SftpContext.tsx#L125-L223)
- [useSftpPaneActions.ts:63-965](file://application/state/sftp/useSftpPaneActions.ts#L63-L965)
- [useSftpTransfers.ts:19-990](file://application/state/sftp/useSftpTransfers.ts#L19-L990)

**章节来源**
- [SftpPaneView.tsx:82-671](file://components/sftp/SftpPaneView.tsx#L82-L671)
- [SftpContext.tsx:125-223](file://components/sftp/SftpContext.tsx#L125-L223)

## 性能考量
- 虚拟化滚动：大列表自动启用虚拟化，减少 DOM 节点数量，提升滚动流畅度。
- 懒加载树视图：首次进入树视图才渲染，避免不必要的初始化成本。
- 列宽与排序缓存：列宽持久化、排序状态与列表顺序缓存，减少重复计算。
- 导航缓存：目录列表缓存与“最后确认状态”机制，避免竞态与回退闪烁。
- 传输并发：目录传输采用分批/异步策略，单文件失败不影响整体进度。

[本节为通用指导，无需特定文件引用]

## 故障排查指南
- 连接丢失/重连
  - 现象：面板显示“正在重连”或错误提示。
  - 处理：点击刷新按钮触发重连；若后台标签页无焦点，重连会在切换回该标签页时自动触发。
- 传输中断/失败
  - 现象：传输队列中出现失败项，或提示“传输取消/失败”。
  - 处理：在队列中重试；若为部分失败，系统会禁用自动重试以避免覆盖已成功文件。
- 文件权限问题
  - 现象：修改权限失败或权限未生效。
  - 处理：确保当前连接具备相应权限；仅远程文件支持权限修改。
- 拖放无效
  - 现象：拖放后无反应。
  - 处理：确认目标为目录且非“..”；检查是否跨面板拖放（默认复制）；确保后端桥接支持对应操作。

**章节来源**
- [SftpPaneFileList.tsx:80-118](file://components/sftp/SftpPaneFileList.tsx#L80-L118)
- [useSftpTransfers.ts:460-506](file://application/state/sftp/useSftpTransfers.ts#L460-L506)

## 结论
SFTP 双面板文件浏览器提供了直观、高效的文件管理体验：列表/树双视图满足不同场景需求；完善的文件操作与拖放上传/下载简化了日常任务；传输队列与冲突处理保障了批量任务的可控性；文件关联与内置编辑器提升了文本文件的编辑效率。结合本文的安全性与性能建议，可在复杂网络环境下稳定高效地完成文件传输工作。

[本节为总结，无需特定文件引用]

## 附录
- 快捷操作速查
  - 新建：工具栏“新建文件夹/新建文件”
  - 刷新：工具栏“刷新”或快捷键
  - 过滤：工具栏“搜索”开启过滤条
  - 视图：工具栏“列表/树”切换
  - 隐藏文件：工具栏“显示/隐藏文件”
  - 编码：远程文件可切换“自动/UTF-8/GB18030”
- 安全建议
  - 使用内置编辑器保存时，系统会校验连接主机一致性，避免写入错误目标。
  - 对于敏感文件，优先使用加密通道与强口令认证。
  - 定期清理传输队列中的已完成/取消任务，释放内存。
- 性能优化
  - 大目录优先使用树视图，按需展开子节点。
  - 批量下载时选择单一目标目录，减少弹窗与 IO 开销。
  - 合理设置列宽与排序，避免频繁重排。

[本节为补充说明，无需特定文件引用]