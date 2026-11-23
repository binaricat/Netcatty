# 通过已有 SSH 服务器连接服务

普通浏览器插件现在可以请求：用户选择 Vault 中的一台 SSH 服务器，确认该服务器能够访问的地址和端口，由 Netcatty 完成 SSH 登录，然后向插件提供有界的双向字节流。数据库协议和数据界面仍由插件实现。

## 调用方式

清单声明以下功能：`network.byte-streams`、`network.host-byte-streams`、`vault.host-actions`。交互式命令还需 `commands.interactive`，对应命令设置 `interactive: true`。

权限声明 `vault.metadata` 和 `network.hostStream`；可以放在 optional 中。此路径不需要 `network.stream` 的静态端点声明，也不需要 `vault.credentials`、Node 运行环境、终端执行或本地文件权限。原来的直接 TCP/TLS 接口仍要求精确的静态端点，仍禁止访问本机控制地址。

```ts
const selection = await context.vault.selectHosts({ title: '选择一个 SSH 服务器' });
if (selection.cancelled || selection.hosts.length !== 1) return;
const target = selection.hosts[0].target;
const connection = await context.network.connectViaHost({
  target,
  expectedRevision: target.revision,
  endpoint: 'tcp://127.0.0.1:3306',
}, cancellationToken);

// 交给插件内的浏览器数据库驱动。必须显式关闭连接。
try {
  await connection.writable.write(protocolBytes);
  const bytes = await connection.readable.read();
} finally {
  await connection.close();
}
```

`127.0.0.1` 指 SSH 服务器自身。域名由该服务器解析。`tls://` 表示通过 SSH 通道后立即建立 TLS，并按原始目标名称验证证书；不支持关闭证书验证或协议内 STARTTLS 升级。普通 MySQL/PostgreSQL 的协议内 TLS 协商不能用 `tls://` 代替。

## 授权和生命周期

- 每条新连接都显示宿主确认界面，列出插件、所选服务器、目的地址和端口。即使该权限设为允许，也不会省略目标确认；拒绝状态直接阻止请求。
- 选择引用绑定插件来源、版本、运行实例、窗口和主机修订，五分钟内可用于发起请求。它不包含 SSH 密码或私钥，不是可以绕过确认的连接授权。
- 宿主在提交前重新检查主机、继承配置、代理、密钥和身份是否变化；一次性确认不能重放或换成另一台主机。
- 使用现有 SSH 密钥、密码、代理、跳板机、主机密钥确认和多因素登录流程。只支持 SSH 主机，不打开终端、不运行启动脚本、不创建本地监听端口，不复用正在工作的终端连接。
- 已建立的连接固定在原来的 SSH 通道上；换标签页、修改 Vault、选择别的服务器不会把它重新指向别处。选择引用到期不会关闭已经确认的连接。不会自动重连或重发数据库写入。
- 取消正在建立的连接、撤权、插件停用/重启、窗口销毁、应用锁定或隐藏时，连接会关闭。连接建立和通道打开有超时；异常及迟到的连接结果也会清理。
- 与普通字节流共用总连接数及流量限额。每个插件运行实例最多 4 条，总计最多 64 条；每条最多传输 64 MiB，空闲 5 分钟关闭，最长 30 分钟；每块最多 64 KiB。全插件流量限额仍适用。
- 审计仅记录通道操作和字节数，不记录数据库密码、SQL、查询结果或传输内容。宿主无法通过原始字节流证明某条 SQL 是只读的；数据库账号权限才是读写边界。

## 可运行示例

[`examples/plugins/database-host`](../../examples/plugins/database-host/README.md) 提供 Vault 页面和终端侧栏，支持选服务器、输入目的地址及数据库账号、执行 SQL、显示结果、断开。示例使用一个浏览器内的精简 MariaDB 驱动，不是完整数据库管理器。

```sh
node examples/plugins/database-host/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/database-host/.package --out /path/to/database-host.ncpkg
```

测试只使用临时 SSH 服务及 Docker 中的独立 MariaDB，不读取用户 Vault 或连接真实服务器：

```sh
node --test electron/plugins/hostByteStreamTransport.test.cjs
NETCATTY_HOST_STREAM_DATABASE_TEST=1 node --test examples/plugins/database-host/integration.live.test.cjs
# 在另一个终端启动 npx vite --port 5182 --strictPort 后：
npx electron electron/plugins/hostByteStreamUi.live.test.cjs
```

## 本次验证（2026-10-30）

- 插件运行时回归：761 项通过，7 项按运行环境跳过。
- 真实 Electron 运行时：通过（`NETCATTY_PLUGIN_DEV=1 npm run test:plugin-runtime:electron`；开关仅用于该测试中的 Node 插件样本，数据库示例不需要）。
- 独立 MariaDB 和 SSH 实测：连接、增删改查、只读账号拒绝写入、取消连接、锁定后断开、日志不含密码和查询内容均通过。
- 真实插件页面：选择服务器、确认目标地址、增删改查、清空密码、断开及侧栏宽度检查通过。
- `npm run lint` 无错误；`npm run pack:dir` 通过；示例安装包通过校验。
- 全项目类型检查仍有 771 项既有诊断；将修改前后的源文件逐项对照后，诊断没有新增或变化，不能将全项目类型检查标为通过。
