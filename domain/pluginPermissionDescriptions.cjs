"use strict";

// Presentation only. Admission and grants remain owned by the canonical schema
// and permission engine. Tests require exact coverage of its permission enum.
const PERMISSION_DESCRIPTIONS = {
  "ai.agent.use": [true, "Agent conversations", "Use configured host Agents and read this plugin's own chat history. Model or Agent service usage may incur costs.", "Agent 会话", "使用宿主已配置的 Agent，并读取此插件自己的聊天历史；模型或 Agent 服务可能产生费用。"],
  "ai.agent.actions": [true, "Agent actions", "Authorize Agent tools against explicitly selected targets under this plugin's policy. Commands can change remote systems.", "Agent 操作", "根据插件策略授权 Agent 工具操作明确选中的目标；命令可能更改远程系统。"],
  storage: [false, "Plugin storage", "Save and read this plugin's local data.", "插件存储", "保存和读取此插件自己的本地数据。"],
  "runtime.advanced": [true, "Full device access", "Run Node code with filesystem and network access outside broker restrictions. Developer mode only.", "完整设备访问", "运行 Node 代码，可直接访问文件系统和网络，不受代理权限限制。仅限开发者模式。"],
  "settings.read": [false, "Read plugin settings", "Read this plugin's configured preferences.", "读取插件设置", "读取此插件自己的设置。"],
  "settings.write": [false, "Change plugin settings", "Update this plugin's preferences.", "修改插件设置", "修改此插件自己的设置。"],
  commands: [false, "Plugin commands", "Register and run this plugin's own commands.", "插件命令", "注册和执行此插件自己的命令。"],
  menus: [false, "Menu entries", "Add this plugin's actions to host menus.", "菜单入口", "将此插件的操作加入应用菜单。"],
  "ui.interact": [false, "Host prompts", "Ask the host to show bounded input and choice dialogs.", "宿主交互", "请求宿主显示有界的输入和选择对话框。"],
  views: [false, "Plugin panels", "Display plugin-owned panels inside the app.", "插件面板", "在应用中显示插件自己的面板。"],
  "ai.invoke": [true, "Use configured AI model", "Send plugin prompts and permitted selected text to the configured model. Provider charges may apply. Does not grant tools or host actions.", "使用已配置的 AI 模型", "向已配置的模型发送插件提示和权限允许的所选文本。模型提供商可能收费。此权限不授予工具或宿主操作权限。"],
  "context.selected.list": [true, "Selected context summaries", "Ask you to share summaries of selected workspace, tab, session, host, or Note references. Does not read their text.", "所选上下文摘要", "请求你分享所选工作区、标签页、会话、主机或笔记引用的摘要。此权限不会读取其文本。"],
  "context.selected.read": [true, "Read selected context", "Read text from host-selected references under this plugin's permission setting. It may contain private data.", "读取所选上下文", "根据插件权限设置读取宿主所选引用中的文本，其中可能包含隐私信息。"],
  "clipboard.read": [true, "Read clipboard", "Read copied text, which may contain passwords or other sensitive data.", "读取剪贴板", "读取复制的文本，其中可能包含密码或其他敏感数据。"],
  "clipboard.write": [true, "Write clipboard", "Replace clipboard content that you may paste elsewhere.", "写入剪贴板", "替换剪贴板内容，可能影响你随后粘贴的数据。"],
  "terminal.selection.read": [true, "Share terminal selection", "Read only the current selection from the host-selected live terminal. It may contain secrets. Ask mode shows one sharing preview.", "分享终端选区", "仅读取宿主所选活跃终端的当前选区，可能包含秘密；询问模式显示一次分享预览。"],
  "terminal.input.propose": [true, "Review terminal input draft", "Open an editable host draft for one selected terminal. Does not send input or Enter.", "审阅终端输入草稿", "打开所选终端的可编辑宿主草稿，不发送输入或回车。"],
  "terminal.metadata": [true, "Terminal metadata", "Read terminal/session details that may identify hosts and activity.", "终端元数据", "读取终端和会话信息，可能暴露主机及操作活动。"],
  "terminal.output": [true, "Read terminal output", "Receive terminal output through supported providers; it may contain credentials or private data.", "读取终端输出", "通过支持的提供器接收终端输出，其中可能包含凭据或隐私信息。"],
  "terminal.input": [true, "Send terminal input", "Send input to a terminal; input may execute commands or change a remote host.", "发送终端输入", "向终端发送输入，可能执行命令或更改远程主机。"],
  "terminal.decorate": [false, "Terminal presentation", "Provide annotations and visual changes to terminal content.", "终端展示", "为终端内容提供标注和视觉效果。"],
  "terminal.complete": [true, "Terminal completion", "Receive completion context and suggest terminal input.", "终端补全", "接收补全上下文并建议终端输入。"],
  "terminal.intercept.input": [true, "Rewrite terminal input", "Inspect and modify input before delivery. Not every secret/no-echo input can be detected. Developer mode only.", "改写终端输入", "检查并修改发送前的输入。无法识别所有秘密或无回显输入。仅限开发者模式。"],
  "terminal.intercept.output": [true, "Rewrite terminal output", "Inspect and modify output, including information shown as command results. Developer mode only.", "改写终端输出", "检查并修改输出，包括呈现为命令结果的信息。仅限开发者模式。"],
  "vault.metadata": [true, "Host inventory", "Read host metadata that can reveal infrastructure details.", "主机清单", "读取主机元数据，可能暴露基础设施信息。"],
  "vault.write": [true, "Change host inventory", "Request changes to stored host records.", "修改主机清单", "请求更改保存的主机记录。"],
  "vault.credentials": [true, "Use host credentials", "Use approved host credential references through operation-bound leases; this can authenticate to hosts.", "使用主机凭据", "通过绑定操作的租约使用已批准的主机凭据引用，可能用于向主机认证。"],
  "sftp.read": [true, "Read remote files", "Read remote file content through supported host APIs.", "读取远程文件", "通过支持的宿主 API 读取远程文件内容。"],
  "sftp.write": [true, "Change remote files", "Write or change remote files through supported host APIs.", "修改远程文件", "通过支持的宿主 API 写入或修改远程文件。"],
  network: [true, "Network requests", "Contact approved origins. Data sent to them leaves this device.", "网络请求", "访问已批准的网络来源。发送的数据会离开此设备。"],
  "network.stream": [true, "TCP and TLS connections", "Send and receive data over TCP or TLS at approved endpoints. Data may leave this device.", "TCP 和 TLS 连接", "通过 TCP 或 TLS 与已批准的端点收发数据。数据可能离开此设备。"],
  "filesystem.read": [true, "Read local files", "Read approved local paths, which may contain sensitive files.", "读取本地文件", "读取已批准的本地路径，其中可能包含敏感文件。"],
  "filesystem.write": [true, "Change local files", "Write to approved local paths; existing content may be changed.", "修改本地文件", "写入已批准的本地路径，可能改变现有文件内容。"],
  secrets: [true, "Plugin secrets", "Store and use this plugin's secrets through OS-backed storage and controlled leases.", "插件秘密", "通过系统密钥存储与受控租约保存和使用此插件的秘密。"],
  "companion.execute": [true, "Run native programs", "Launch digest-verified companion executables with device authority. Developer mode only.", "运行本机程序", "启动经过摘要校验的辅助可执行程序，拥有设备权限。仅限开发者模式。"],
  "provider.terminal": [true, "Terminal providers", "Provide terminal features; separate permissions govern access to terminal data.", "终端提供器", "提供终端扩展功能；终端数据访问由额外权限控制。"],
  "provider.connection": [true, "Connection provider", "Implement a connection backend and handle its session data.", "连接提供器", "实现连接后端并处理对应会话数据。"],
  "provider.authentication": [true, "Authentication provider", "Participate in login challenges using approved credential leases.", "认证提供器", "使用已批准的凭据租约参与登录验证。"],
  "provider.sync": [true, "Encrypted sync storage", "Store encrypted sync objects; this permission does not provide the master key or plaintext vault.", "加密同步存储", "存储加密同步对象；此权限不提供主密钥或明文凭据库。"],
  "provider.importer": [true, "Import provider", "Parse user-selected files into drafts for host review; input files may be sensitive.", "导入提供器", "解析用户选择的文件并生成供宿主确认的草稿；输入文件可能包含敏感数据。"],
};
function describePluginPermission(permission, locale = "en") {
  const entry = Object.hasOwn(PERMISSION_DESCRIPTIONS, permission) ? PERMISSION_DESCRIPTIONS[permission] : null;
  const chinese = locale.startsWith("zh");
  if (!entry) return { known: false, sensitive: true, label: chinese ? "无法识别的权限" : "Unrecognized permission", description: chinese ? "此版本无法识别该权限，拒绝授权。" : "This version does not recognize this permission. Access is denied." };
  return { known: true, sensitive: entry[0], label: entry[chinese ? 3 : 1], description: entry[chinese ? 4 : 2] };
}
module.exports = { PERMISSION_DESCRIPTIONS, describePluginPermission };
