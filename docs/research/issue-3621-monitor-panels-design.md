# 自定义监控面板：研究与页面雏形

日期：2026-10-17。对应 [#3621](https://github.com/binaricat/Netcatty/issues/3621)。本稿取代上一版“在主机分组里开启监控”的提案，以用户本轮要求为准。

状态：用户已认可雏形并授权正式实现，补充的五项要求如下，优先于原型中仅为演示而作的简化：

- 成品使用整个 App 的设计系统、主题色、字体、间距与现有组件；不把独立雏形的样式直接搬入产品。
- 新建、编辑、选择主机与详情的表单交互沿用当前 Vault 的成熟模式，包括返回、取消、保存、验证与滚动行为。
- 所有新增用户可见文字、状态、错误与操作完整接入现有 i18n，覆盖项目已有语言，不把雏形中的中文硬编码带入成品。
- 面板配置中的主机引用、顺序、列表/图表布局和显示偏好等纳入现有云同步，并覆盖相应导入导出、备份及兼容路径；读数与趋势仍绝不持久化或同步。
- 主机系统识别、能力判断、信息探测与状态采集复用或扩充现有逻辑，禁止为监控平行重写一套探测器。

## 1. 已确认的产品要求

1. Vault 左侧菜单新增独立“监控”栏目。
2. 用户可创建、命名和切换多个监控面板。
3. 每个面板自由选择已有主机，可跨分组；面板不等于主机分组。
4. 同一个面板可在列表和丰富图表两种展示之间切换。
5. 使用 SSH 长连接，沿用 Netcatty 现有连接复用逻辑，不另造一套独立监控连接池。
6. 用户已明确：面板名称、主机选择、展示偏好等配置重启后保留；监控读数不在本地持久化。
7. 研究与雏形已完成并获认可；正式实现单独创建 thread 与 worktree，延续此前授权的 PR 审查与合并流程。原型验证不替代真实 App、同步与 SSH 验收。

完成标准：核实多面板管理、主机选择、两种展示和连接复用的相关一手资料；给出一致的运行与保存规则；雏形中的新建、修改、复制、删除、选主机、切换、启停和失败提示能实际操作；打开浏览器验证布局与交互，并区分示例演示与真实连接验证。

## 2. 研究结论

最适合的组合是 **Homarr 的命名面板管理 + Grafana 的对象与展示分离 + ServerBox 的紧凑主机卡片 + Termix 的共享采集**。最终做成 Netcatty 自己的轻量监控页面，保持现有 Vault 导航、品牌、配色、图标和右侧面板习惯。

不需要让用户逐张图配置数据源、查询语言和坐标位置。面板只负责“看哪些主机、怎么显示、多久更新”，一台主机在多个面板出现，不应使远端查询成倍增加。

### 一手资料对照

| 项目 | 已核实的模式 | 本设计采用什么 | 没有照搬什么 |
| --- | --- | --- | --- |
| Homarr | 独立命名 board，创建、复制、打开、删除、搜索切换；服务器选择器补充来源防同名 | 面板管理与切换；主机显示名称、地址和分组 | 分享权限、门户首页、嵌套容器、完整自由布局 |
| Grafana | 集中选择监控对象；同一数据提供者切换图形/表格预览；自动网格 | 主机集合属于整页面板；列表/图表只换展示；自动排布 | 查询编辑器、数据源管理、变量依赖、历史数据库 |
| ServerBox | 多主机卡片/行/网格密度，核心读数摘要与单机详情 | 图表卡片与列表的信息密度 | 远端采集脚本与其断连行为 |
| Termix | 同机多观察者共享采集；列表摘要与详情分开；认证与网络错误分别处理 | 多面板共享一份指标，明确失败和待登录 | 独立于终端的监控连接池 |

本轮没有部署竞品；下列行为来自官方文档与固定提交源码。没有声称某一个竞品完整具备本设计的全部功能。

### Homarr：面板管理和对象选择

固定提交：`e0ff7ab007d915269351ab9f5b227f2ffcc2c115`。

- [官方 Boards](https://homarr.dev/docs/management/boards/) 与 [创建表单](https://github.com/homarr-labs/homarr/blob/e0ff7ab007d915269351ab9f5b227f2ffcc2c115/packages/forms-collection/src/board-create/board-create-form.tsx#L20-L98)确认 board 是可命名的独立对象；[复制表单](https://github.com/homarr-labs/homarr/blob/e0ff7ab007d915269351ab9f5b227f2ffcc2c115/apps/nextjs/src/app/%5Blocale%5D/manage/boards/_components/duplicate-board-form.tsx#L22-L86)要求为副本命名。
- [BoardSwitcher](https://github.com/homarr-labs/homarr/blob/e0ff7ab007d915269351ab9f5b227f2ffcc2c115/apps/nextjs/src/components/board/board-switcher.tsx#L51-L80)支持按名称过滤面板；我们采用轻量下拉，不再增加第二级永久侧栏。
- [系统选择](https://github.com/homarr-labs/homarr/blob/e0ff7ab007d915269351ab9f5b227f2ffcc2c115/packages/widgets/src/beszel-system-stats/selection.ts#L14-L32)用来源 ID 与系统 ID 区分对象，多来源时补来源名称。我们对应保存已有主机 ID，并展示地址和分组，避免只凭名称选错。
- 官方有 [table](https://homarr.dev/docs/widgets/beszel-system-table/)、[grid](https://homarr.dev/docs/widgets/beszel-system-grid/) 和 [stats](https://homarr.dev/docs/widgets/beszel-system-stats/) 三种相关展示。它们是不同 widget，并不能证明 Homarr 有一个按钮让整个页面直接切换三种展示。我们的一键列表/图表是针对本需求做的简化。

### Grafana：同数据换展示与自动排布

固定提交：`3392442829842df6485c9305a23c30943147ebe6`。

- [Variables 文档](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/)说明通过页面顶部的统一选择改变监控对象，避免复制很多相同内容。我们的对象选择使用现有主机多选，而不引入变量语言。
- [PanelEditor.onToggleTableView](https://github.com/grafana/grafana/blob/3392442829842df6485c9305a23c30943147ebe6/public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx#L422-L448)保留原图表的数据提供者，通过 `DataProviderSharer` 建立表格预览。这是同数据换展示的明确先例，但它是图表编辑器内预览，不是全局 dashboard 一键转表格。
- [自动网格编辑器](https://github.com/grafana/grafana/blob/3392442829842df6485c9305a23c30943147ebe6/public/app/features/dashboard-scene/scene/layout-auto-grid/AutoGridLayoutManagerEditor.tsx#L44-L171)提供按最小列宽和最多列数排布的能力。我们的首版只自动适应可用宽度，不做拖拽搭建器。

### ServerBox 与 Termix：多机读数与共享

- [ServerBox 列表密度](https://github.com/lollipopkit/flutter_server_box/blob/278d48013e0e855c889455aeb58e17c9b8db6679/lib/view/page/server/card/density.dart#L6-L95)和[读数构造](https://github.com/lollipopkit/flutter_server_box/blob/278d48013e0e855c889455aeb58e17c9b8db6679/lib/view/page/server/card/metric.dart#L491)提供多机紧凑呈现参考；标签过滤不等于本设计的命名面板。
- [Termix 观察者管理](https://github.com/Termix-SSH/Plugin-Host-Metrics/blob/e3bde42a184e41c2b09c80a82fe2ab1f3306a726/src/backend/poller.ts#L59-L157)提供同机多处查看共享采集的参考；[采集入口](https://github.com/Termix-SSH/Plugin-Host-Metrics/blob/e3bde42a184e41c2b09c80a82fe2ab1f3306a726/src/backend/collect.ts#L67-L185)优先使用插件自己的连接或 stats 池，不能当成已经满足 Netcatty 的终端连接复用要求。

### Xterminal 在新方案中的位置

此前已实际查看需求中的列表截图、官方连接中心和单机监控图片。Xterminal 的“信息”列和右侧详细监控适合参考读数组织；新的多命名面板结构来自本轮用户要求，不能继续受“只在分组里加开关”的旧方案限制。

[Xterminal 连接中心](https://docs.xterminal.cn/connections/overview/)；[官方监控说明](https://docs.xterminal.cn/advanced/server-monitor/)明确会写采集脚本，不能将它作为“长连接就没有查询/审计”的证明。

## 3. 页面结构与主要流程

### 独立入口

Vault 左侧在“主机”下方增加“监控”，沿用原有选中态和折叠方式。正在运行时，栏目旁显示运行面板数；应用顶部工具栏保持原样。页面主体依次为：

1. 标题“监控”、“全部停止”和“新建面板”。
2. 当前面板名称下拉、说明、编辑与更多菜单。
3. 列表/图表切换、搜索、趋势范围、更新频率、当前面板开始/停止。
4. 主机列表或图表卡片；右侧按需展开编辑或详情，与页面顶部对齐，覆盖在内容上方并可拖拽调宽，不改变左侧内容宽度。

面板多时下拉支持按名称查找。第一版不再给监控面板引入分组、文件夹或嵌套页面。

### 新建与编辑

首次无面板时显示“创建第一个监控面板”。新建与编辑使用现有右侧面板风格：名称、可选说明、默认列表/图表、已有主机多选。

选择器按名称、地址和分组搜索；分组只负责帮助选择，最终保存的是明确的主机 ID 集合。可跨组选主机，显示“已选 N 台”，支持选择筛选结果和清空。名称不能为空、不能与现有面板重名；至少选一台。

保存只保存配置，不发起连接。新面板进入未开始状态，用户点击“开始监控”才连接。复制只复制配置与主机集合，不复制读数和运行状态；删除只删除面板，并释放它的监控需求，主机和其他面板保留。

编辑运行中面板时，保存后应用差异：新增成员加入队列，移除成员撤销本面板的需求；重复成员与其他面板继续共用。取消编辑不改变正在运行的名单。

主机改名或改组后按 ID 跟随；主机删除后显示失效成员并允许移除，不静默替换为同地址的另一条主机。组选中按当时的具体成员保存，未来新加主机不会悄悄加入面板。

### 列表模式

每台一行，字段为主机图标/名称/地址、状态、CPU、内存、各分区占用、上传/下载、更新时间。仅提供名称与保存的顺序两种排序，列表和卡片均支持拖拽；拖拽基于当前显示顺序保存并切换为保存的顺序，搜索隐藏的主机仍保留。提供搜索与详情入口。没有“需关注”机制。磁盘进度保留百分比，鼠标悬停时显示完整分区名与已用/总容量，缺失容量不伪造为零。

列表用于比较，避免每一行都塞完整图表。缺失值显示 `--`；失败时保留旧值但降灰并说明时间；第一次差值采样尚未完成时显示采样中。CPU 与网速未就绪不伪装成 0。

### 图表模式

每台一张自动排列的卡片：主机图标/名称/地址/状态、CPU 当前值及核数、内存当前值及容量、CPU/内存短趋势（悬停显示指示线、真实采样值和时间）、总容量最大的两个分区的挂载点和占用条、网络上下行当前速率。卡片高度保持一致，内部以留白和彩色读数分区，不嵌套描边容器或状态标签；列表同样无边框，工具栏控件统一高度。面板说明不在主页面重复展示。

点击主机打开右侧详情，显示放大的 CPU/内存趋势、网络上传/下载趋势、系统信息和各盘/各网卡读数。详情、编辑与选主机互斥打开，均使用可拖拽调宽的内联侧栏，打开时收窄左侧内容，与其他 Vault 分区保持一致；侧栏标题栏与主内容标题栏同高，保留返回/关闭和固定底部操作。

两种展示共用主机集合、读数和短趋势。换视图不重新登录、不清曲线、不新建另一份采集。显示偏好按每个面板保存。首版不加入自由拖拽布局和每张图的查询编辑器。

## 4. 已认可的运行规则

建议每个面板独立开始/停止。**明确开始的面板在应用运行期间继续采集，切换面板或进入终端不中断。** 不因打开下拉菜单或保存面板便自动开始全部面板。每次明确开始和每次变更采集频率都会清空当前面板的所有旧曲线，从本次操作之后的真实读数重新绘制；不会清除其他面板或终端的共享读数。

这种持续运行方式随雏形获得用户认可。它与上一稿“离开页面暂停”的规则不同，以本稿为准。研究和雏形阶段没有发起真实主机连接；正式实现须使用可控测试环境验证，不能任意批量登录用户保存的生产主机。

- 侧栏与顶部持续显示运行面板数；监控页同时显示去重后的主机数并提供“全部停止”。
- 停止 A 面板不影响 B 面板；交集主机由仍有效的需求继续使用。
- 停止取消本面板的后续采样和排队，释放不再需要的监控用途；正常终端不被断开。
- 退出软件结束全部监控。重启只还原面板配置，全部为未开始，不自动恢复后台运行。
- Vault 锁定、系统睡眠或网络断开时，不继续用缓存秘密重试登录；展示暂停/断开与缺口，解锁或恢复网络后依既有安全规则处理，不能绕过身份确认。
- 需要口令、验证码或主机身份确认时逐台处理，其他主机继续；不要同时弹出一串登录框。

默认 5 秒更新，菜单提供 3/5/10/30/60 秒，隐藏 1/2 秒选项，内部采样能力不作变更。共享缓存按当前监控的最快需求刷新，不以旧的 4 秒缓存限制 1 秒采集。系统信息、磁盘容量可低频，列表不采完整进程/GPU/每核详情。采集失败有限退避，认证或身份变化等待用户，不循环刷日志。

## 5. SSH 长连接：复用现有机制的真实边界

核对基线：Netcatty main `8aeb6ade6fc2b56436442ebe93852cb5dde5c141`。

### 已有基础

- [共享连接池](../../electron/bridges/sshConnectionPool.cjs)已支持非终端用途的借用/归还、兼容身份匹配、并发建连合并和空闲保留；[转发使用路径](../../electron/bridges/portForwardingBridge.cjs)说明不必先开终端才能借用连接。
- 完整连接身份包含保存主机、地址/端口/账号、路由与代理、认证及信任策略等。不能按 IP 或主机名另做一个简化去重表。
- 最后一个用途归还后，普通空闲连接默认可保留 5 分钟；配置为 0 时可保留到退出/主动清理。故“停止监控”应表示停止查询与归还用途，不应许诺物理连接瞬间消失。

### 需要增加的能力

- 当前池没有正式 monitor 用途；现有 [统计入口](../../electron/bridges/sshBridge/sessionOps.cjs)仍依赖终端 session。正式实现需要新增监控用途，并把采样上下文与 CPU/网速前次计数从终端会话解耦。不能创建隐藏终端冒充监控，否则可能带来终端启动脚本和其他副作用。
- 多面板、详情、终端与窗口对同一兼容身份共用一份采集；只有第一次无可用连接才按既有认证/组继承/跳板/信任检查流程建连。不另造监控专用池，不绕过认证。
- 多个订阅频率不同时，底层基础读数按最短有效需求；1 秒等快速监控始终使用轻量采集，进程/GPU 等完整读数只由终端按其自身频率触发，并有独立的 4 秒缓存；例如终端仍要每 5 秒读数，监控面板选择 30 秒不意味着该机器远端查询变为每 30 秒。各面板可按自身频率呈现，实际共享频率需可解释。
- 长连接指已认证 SSH 传输保持与复用，现有路径仍定时执行查询。它不自动等于持续推流、无远端命令或零堡垒机审计；改为持续采集进程属于另一个明确决策，本方案不默认引入远端落盘脚本或常驻安装。

正式支持范围先以现有 Linux/macOS SSH 统计与已验证跳板方式为准。网络设备、Telnet、单通道/受限方式需明确不可用原因。现有 [SelectHostPanel](../../components/SelectHostPanel.tsx)的默认过滤不足以代表这些能力已经全部处理。

## 6. 保存什么、不保存什么

| 保存的面板配置 | 只在内存中的运行内容 |
| --- | --- |
| 面板 ID、名称、说明 | 实时读数和最后成功快照 |
| 有序主机 ID 集合 | 趋势点与网速/CPU 差值基线 |
| 列表/图表偏好、刷新间隔、趋势范围 | 正在运行的面板集合、连接状态、错误响应 |
| 必要的排序和显示偏好 | SSH 连接对象、临时认证状态 |

配置通过现有 [storageKeys](../../infrastructure/config/storageKeys.ts) 和 [localStorageAdapter](../../infrastructure/persistence/localStorageAdapter.ts) 保存，不复制凭据。按照用户最新要求，必须把面板实体、主机引用、顺序与布局/显示偏好接入现有云同步、导入导出与备份体系。当前这些路径尚无面板字段，正式实现要补齐字段传输、合并、删除传播和旧版本缺字段兼容，不能只增加本地键后宣称同步已完成。多个设备和窗口间的修改不能互相静默覆盖或使已删除面板复活；主机 ID 的解析和失效引用遵循现有主机同步语义。

实时读数、内存曲线、登录连接与“正在运行”状态不进入同步载荷。其他设备收到面板配置后以未开始状态呈现，不因一次云端配置拉取自动批量登录主机。

监控读数不写 localStorage、IndexedDB、文件、缓存、备份、同步或常规日志；不通过“页面状态恢复”间接带出采样。诊断仅记录必要的状态与计数，不记录采样正文。

短趋势建议每个唯一采集身份一份有上限的内存缓冲，保留最近 30 分钟、最多 1800 点，监控最快 1 秒一点。多个面板不各存一份。按时间和数量同时裁剪，失去需求后有限期回收；程序退出全部清空。

因此只提供最近 5/15/30 分钟的观察范围，不提供昨天/过去一周等历史查询。实际采样不足所选范围时显示已采时长，断网或暂停期间保留缺口，不补 0、不虚构连贯趋势。100 台 × 1,800 点 × 六个 8 字节数字约 8.6MB 只是原始数字下限，实际对象和渲染占用仍要实测。

## 7. 雏形与本次验证

独立雏形位于本对话的可视化输出目录 `vault-monitor-panels`，以独立本地预览运行；未把监控功能接入主仓库。使用现有 AppLogo、AppWordmark 和 Lucide 图标，参考实际运行的 Vault 浅色界面。所有主机、状态和曲线都是示例；“打开终端”只说明正式功能的去向，验证码只演示逐台恢复。

已在浏览器检查：

- 初始未开始；开始后图表、计数和异常状态正确；列表/图表来回切换。
- 跨组选两台主机，创建新面板后未自动开始；开始第二面板后按唯一主机数计数。
- 离开监控栏目仍有运行数量提示；回来保留运行状态。
- 编辑改名、复制配置但不复制运行状态、删除面板不删其他配置。
- 删除到零个面板后，空状态仍能创建；空名称和未选主机有提示。
- 重开页面保留配置，运行状态与读数清空。
- 逐台演示登录恢复、过期数据提示、重试和网络详情。
- 桌面、小窗口、窄窗口及深色模式；修复了编辑侧栏底部按钮需要滚到页面底部才能看到的问题。
- 浏览器错误/警告检查与独立雏形构建。

这些证明雏形可用于审阅流程，不证明新的真实 SSH 采集、复用、审计或内存占用已经验收。首次开始后的预填短趋势是用于展示效果的示例数据，正式功能不能回填并不存在的历史。

## 8. 用户认可后，正式实现的交付门槛

1. 另开 thread/worktree，先确认 issue 与 PR 关系，按本稿确认的范围实现，不与暂缓的私人分组锁定混合。
2. 无终端的新监控连接、已有终端/SFTP/转发连接的复用、同身份并发建连都走真实路径；账号、密钥、代理或信任策略不同绝不错误共享。
3. 两面板、两窗口、列表/详情/终端同时查看，同机只采一份；切视图不重连，停一个面板不影响其他用途，退出后没有监控遗留。
4. 点击停止时连接中/排队中/采集中分别验证：不再补发后续查询；连接按池规则保留或关闭，终端继续能输入。
5. 核验读数绝无落盘或同步路径；重启只有配置没有曲线与运行状态；配置跨窗口编辑不会互相覆盖。两端真实同步或代表性端到端路径覆盖创建、改名、增删主机、改布局、删除面板、旧载荷缺字段及导入导出恢复；对既有同步方式的影响逐项核对。
6. 真实主机与至少一个代表堡垒机测查询与审计量；测试慢主机、首次采样、睡眠、断网、认证、主机删除和凭据变更。
7. 对代表性的主机规模测试内存、重绘与连接成本；不以原始数字估算替代运行结果。
8. 实际运行 Netcatty 走完整新建/编辑/切换/启停/详情流程；检查设计系统、Vault 表单交互、亮暗主题和窄窗口，切换语言验证状态、错误、复数和长文本；确认系统探测复用已有真实路径，再按已有 PR 审查与合并标准交付。

## 9. Implementation acceptance checklist

- [x] Named panels: create/edit/copy/delete, ordered cross-group host references, list/cards, search/sort/attention, details and terminal action.
- [x] Existing Vault components/themes/forms; every visible addition translated for all five locales.
- [x] Config only: local storage, concurrent window field edits, cloud merge/deletions/legacy payloads, JSON import/export and protective backups.
- [x] Shared SSH pool, full identity, joined dials, explicit monitor lease, no shell or startup commands; serialized authentication.
- [x] One collection/baseline/history per compatible transport across panels/windows/terminal; cancellation releases only owned demand.
- [x] Memory-only samples/status/errors; bounded sparse trends, honest first samples, stale readings and unsupported targets.
- [x] Lock/sleep/offline/close/quit cleanup; restart restores stopped configuration only.
- [x] Controlled SSH integration, cancellation/reuse and representative scale checks; real Electron complete flows, themes, narrow windows, languages.
- [ ] Focused and required checks, independent current-head reviews, exact-head remote review, CI and review-thread gates; verify after merge.

## 10. Implementation notes (2026-10-17)

- Panel configuration is normalized through an allowlist. It participates in the existing three-way and convergent sync collections, deletion records, auto-sync change notifications, Vault JSON export/import and protective backups. Prepared cloud applies rebase intervening window edits; old payloads without the field preserve local panels.
- Monitoring runs in the terminal worker, using the existing SSH registry's full identity and joined dials, with an explicit `monitor` lease. Authentication reuses the existing SSH preparation, host-key, keyboard-interactive and jump-host paths. No terminal session or shell is created for monitoring.
- Ordinary terminal opens retain their existing fresh-login policy. If a terminal already exists, monitoring borrows its compatible transport. Distinct transports with the exact same normalized identity share the metrics cache and baseline too, so a required fresh terminal login does not duplicate collection.
- Shared collection/history is volatile. Each history keeps at most 1800 points from the last 30 minutes, sampled no faster than every second. At most 256 unique monitoring identities run at once; the metrics identity cache is bounded to 512 entries and periodically prunes expired histories. No readings, errors, running intent or credentials enter the panel storage shape. Renderer polling transfers only new history points and omits unchanged host stats using per-history sample cursors; fresh samples and connection changes include their complete current stats. Trend geometry is memoized across unchanged samples (including after panel resets), reduces dense runs to per-column extrema, and advances idle viewports on a shared five-second clock. Hover still reads the original samples; missing samples and cadence gaps remain separate runs.
- Known network devices are rejected using the existing renderer banner rules, extracted into one shared module. Recognized single-channel peers are rejected before an extra command runs. Monitor-only samples omit process and GPU queries. Terminal readers share a separate four-second complete-sample cache; monitor readers continue collecting lightweight samples. The same existing Linux/macOS parser, disk handling, CPU deltas and network deltas serve terminal and monitoring readers.
- A real macOS shell exercise found an existing cooked-template escape in the disk awk expression. It now uses a literal prefix comparison, with a generated-command regression test; the actual monitor reads root/volume capacity correctly.

Verified so far in an isolated Electron profile and controlled SSH fixture (no saved production host logins): creation, validation, cross-group selection, copy starting stopped, two running panels, navigation retention, direct and jump-host real shell sampling, known-host confirmation, unsupported network devices, sequential verification prompts, failed login details, light/dark and Chinese/narrow rendering. Stopping an in-flight slow query produced no additional queries after 12 seconds; another panel and an ordinary terminal remained usable. Starting monitoring against an existing terminal did not add an authenticated connection. Restart restored two saved panels with zero running panels and zero monitor readings.

Focused configuration, sync/backup round-trip, concurrent edit, collection, pool, SSH authentication and capability checks pass. Build and directory packaging have run; the packaged archive includes the shared vendor rules and monitoring runtime. The repository-wide TypeScript check has 755 pre-existing errors on both this work and an untouched main snapshot, with no new diagnostics after path/line normalization. The Node 26 full suite also exposes a pre-existing transfer FileHandle cleanup failure, reproduced against untouched main; missing nested plugin dependencies were environment setup and were corrected. The complete suite finished with 13,822 tests: 13,791 passed, 30 skipped and the one reproduced baseline FileHandle failure. Follow-up review fixes have focused regression coverage. Current-head review and merge checks are recorded in the PR.


Additional acceptance evidence:

- Actual two-window execution: both owners watched the same two supported identities with two running panels and only two unique monitoring entries. A stale editor in the second window changed description and host order after the first renamed the panel; all three edits survived. Stopping and then closing the second owner left the first live. Independent tests cover owner closure during active and queued authentication, credential-changing and same-identity retry, and stop during post-authentication work.
- Actual UI actions also exercised saved ordering, name sorting, search, attention filtering, duplicate creation starting stopped, confirmed deletion retaining all saved hosts, and JSON restore. Clear All Local Data removes panels. An offline event stops all monitoring; restore recreates five saved panels with zero running panels.
- Each of the five locales was rendered in Electron with no untranslated monitoring keys or document overflow. Light/dark and 760px width were checked; the editor's Save button remained inside the viewport.
- A controlled SSH fixture supplied 100 distinct identities over real connections. All 100 produced their first readings in 876ms; 100 cards rendered (two trend charts each), with a measured renderer heap increase of 6.69MiB. The fixture recorded 100 successful authentications, 100 collection commands plus capability/disk work, and zero shells for this exercise. This tests fixture throughput and rendering, not a production fleet's network latency.
- Accelerated in-memory history exercise through the production sampler retained exactly 18,000 points for 100 identities, with a measured heap increase of 1.92MiB after collection. This measures the real bounded object representation; it does not claim 30 minutes of production observation.
- Last successful readings and their timestamp survive sampling failure; missing measurements remain null. A failed host does not block reuse and collection on an already-authenticated host. Capacity is applied after obsolete demand is removed, including replacing a host at the 256-identity bound.

### Fast-cadence transport validation

Renderer polling sends a per-host timestamp cursor. Worker snapshots send only newer points after the first full snapshot; renderer memory merges, deduplicates and bounds history to 1,800 points and 30 minutes. Endpoint history identities travel with cursors so replacing a host connection cannot merge readings from different endpoints. Worker/runtime changes replace history, and older responses cannot overwrite newer state. A 256-host test with full retained histories transfers only 256 new points per polling round, below one percent of the full-history payload. Full terminal stats keep their own four-second cache; one-second monitor requests remain lightweight.
