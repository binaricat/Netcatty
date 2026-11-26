/**
 * Regenerate components/terminal/autocomplete/commandDescriptions.ts from the
 * Fig specs and the committed zh-CN/zh-TW description dictionaries.
 *
 * Commands whose spec has no root description use the reviewed table below.
 * Run with: node --import tsx scripts/generate-command-descriptions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = path.join(rootDir, 'components/terminal/autocomplete/commandDescriptions.ts');
const descriptionDir = path.join(rootDir, 'components/terminal/autocomplete');
const electronDir = path.join(rootDir, 'electron');

const { loadFigSpec, registerFigSpecHandlers } = createRequire(import.meta.url)(
  path.join(electronDir, 'main/registerBridges.cjs'),
);
const handlers = new Map();
registerFigSpecHandlers({ handle: (name, handler) => handlers.set(name, handler) }, electronDir);

const simplified = JSON.parse(fs.readFileSync(path.join(descriptionDir, 'descriptions.zh-CN.json'), 'utf8'));
const traditional = JSON.parse(fs.readFileSync(path.join(descriptionDir, 'descriptions.zh-TW.json'), 'utf8'));
const { COMMAND_DESCRIPTIONS: existing } = await import(pathToFileURL(targetPath).href);

/** Root descriptions for commands whose Fig spec has none. */
const MANUAL = {
  agrippa: ['Generate a React app with a flexible generator', '使用灵活生成器创建 React 应用', '使用靈活產生器建立 React 應用'],
  airflow: ['Workflow scheduler for authoring, scheduling and monitoring data pipelines', '用于编写、调度和监控数据管道的工作流调度器', '用於編寫、排程和監控資料管道的工作流排程器'],
  argo: ['Workflow engine for Kubernetes', 'Kubernetes 工作流引擎', 'Kubernetes 工作流程引擎'],
  babel: ['JavaScript compiler', 'JavaScript 编译器', 'JavaScript 編譯器'],
  barnard59: ['Streaming data pipelines with JavaScript', '使用 JavaScript 构建流式数据管道', '使用 JavaScript 構建串流資料管道'],
  bunx: ['Run a package binary with Bun', '使用 Bun 运行软件包二进制', '使用 Bun 執行軟體包二進位檔'],
  bw: ['Bitwarden CLI', 'Bitwarden 命令行工具', 'Bitwarden 命令列工具'],
  bws: ['Bitwarden Secrets Manager CLI', 'Bitwarden Secrets Manager 命令行工具', 'Bitwarden Secrets Manager 命令列工具'],
  cl: ['Commerce Layer CLI', 'Commerce Layer 命令行工具', 'Commerce Layer 命令列工具'],
  commercelayer: ['Commerce Layer CLI', 'Commerce Layer 命令行工具', 'Commerce Layer 命令列工具'],
  cosign: ['Container image signing and verification', '容器镜像签名与验证', '容器映像簽章與驗證'],
  'create-next-app': ['Create a new Next.js app', '创建新的 Next.js 应用', '建立新的 Next.js 應用'],
  'create-redwood-app': ['Create a new RedwoodJS app', '创建新的 RedwoodJS 应用', '建立新的 RedwoodJS 應用'],
  'create-remix': ['Create a new Remix app', '创建新的 Remix 应用', '建立新的 Remix 應用'],
  dotslash: ['Run portable executables with a metadata file', '使用元数据文件运行可移植可执行文件', '使用中繼資料檔案執行可攜式執行檔'],
  'elm-review': ['Static analysis for Elm', 'Elm 静态分析工具', 'Elm 靜態分析工具'],
  firebase: ['Firebase CLI', 'Firebase 命令行工具', 'Firebase 命令列工具'],
  goto: ['Jump to directories by name', '按名称跳转目录', '按名稱跳轉目錄'],
  homey: ['Homey CLI', 'Homey 命令行工具', 'Homey 命令列工具'],
  ibus: ['Input method framework for Linux', 'Linux 输入法框架', 'Linux 輸入法框架'],
  kitty: ['GPU-accelerated terminal emulator', 'GPU 加速的终端模拟器', 'GPU 加速的終端機模擬器'],
  kubecolor: ['Colorized kubectl output', '为 kubectl 输出着色', '為 kubectl 輸出著色'],
  kubectl: ['Kubernetes command-line tool', 'Kubernetes 命令行工具', 'Kubernetes 命令列工具'],
  make: ['Build automation tool', '构建自动化工具', '構建自動化工具'],
  mask: ['Run commands defined in a Markdown file', '运行 Markdown 文件中定义的命令', '執行 Markdown 檔案中定義的命令'],
  mosh: ['Mobile shell for roaming SSH sessions', '支持漫游 SSH 会话的移动 shell', '支援漫遊 SSH 工作階段的行動 shell'],
  nuxt: ['Vue framework for building web applications', '用于构建 Web 应用的 Vue 框架', '用於構建 Web 應用程式的 Vue 框架'],
  nvm: ['Node Version Manager', 'Node 版本管理器', 'Node 版本管理器'],
  'oh-my-posh': ['Prompt theme engine', '提示符主题引擎', '提示字元主題引擎'],
  pgcli: ['PostgreSQL CLI with autocompletion', '带自动补全的 PostgreSQL 命令行工具', '帶自動補全的 PostgreSQL 命令列工具'],
  planter: ['Create and manage project planters', '创建和管理项目 planters', '建立和管理專案 planters'],
  playwright: ['End-to-end testing framework', '端到端测试框架', '端對端測試框架'],
  publish: ['Publish and deploy websites', '发布和部署网站', '發布和部署網站'],
  pytest: ['Python testing framework', 'Python 测试框架', 'Python 測試框架'],
  sfdx: ['Salesforce CLI', 'Salesforce 命令行工具', 'Salesforce 命令列工具'],
  'shell-config': ['Manage shell configuration', '管理 shell 配置', '管理 shell 設定'],
  simctl: ['Control iOS simulators', '控制 iOS 模拟器', '控制 iOS 模擬器'],
  speedtest: ['Measure internet connection speed', '测量网络连接速度', '測量網路連線速度'],
  su: ['Switch user or run a command as another user', '切换用户或以其他用户身份运行命令', '切換使用者或以其他使用者身分執行命令'],
  systemctl: ['Control the systemd system and service manager', '控制 systemd 系统和服务管理器', '控制 systemd 系統與服務管理員'],
  tailscale: ['WireGuard-based mesh VPN', '基于 WireGuard 的网状 VPN', '基於 WireGuard 的網狀 VPN'],
  tangram: ['Build and run Tangram applications', '构建和运行 Tangram 应用', '構建和執行 Tangram 應用程式'],
  task: ['Task runner', '任务运行器', '任務執行器'],
  'wasm-pack': ['Build Rust-generated WebAssembly packages', '构建 Rust 生成的 WebAssembly 软件包', '構建 Rust 產生的 WebAssembly 軟體包'],
  webpack: ['JavaScript module bundler', 'JavaScript 模块打包器', 'JavaScript 模組打包器'],
  wing: ['Wing language toolchain', 'Wing 语言工具链', 'Wing 語言工具鏈'],
  z: ['Jump to frequently used directories', '跳转到常用目录', '跳轉到常用目錄'],
};

const names = (await handlers.get('netcatty:figspec:list')(null, 'linux'))
  .filter((name) => !name.includes('/'));
if (names.length === 0) {
  throw new Error('Fig spec list is empty; refusing to rewrite command descriptions');
}

const unknownManual = Object.keys(MANUAL).filter((name) => !names.includes(name));
if (unknownManual.length > 0) {
  throw new Error(`Manual command descriptions reference unknown commands: ${unknownManual.join(', ')}`);
}

const failures = [];
const specs = new Map(await Promise.all(names.map(async (name) => {
  try {
    return [name, await loadFigSpec(electronDir, name, 'linux')];
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
    return [name, null];
  }
})));
if (failures.length > 0) {
  throw new Error(`Failed to load Fig specs:\n${failures.join('\n')}`);
}

// Seed only commands that still exist so removed specs cannot linger forever.
const result = Object.fromEntries(
  names.filter((name) => existing[name]).map((name) => [name, existing[name]]),
);
for (const name of names) {
  const spec = specs.get(name);
  const manual = MANUAL[name];
  const en = manual?.[0] || spec?.description?.trim() || existing[name]?.en || '';
  if (!en) continue;
  const zhCN = manual?.[1] ?? simplified[en] ?? existing[name]?.zhCN;
  const zhTW = manual?.[2] ?? traditional[en] ?? existing[name]?.zhTW;
  result[name] = {
    en,
    ...(zhCN ? { zhCN } : {}),
    ...(zhTW ? { zhTW } : {}),
  };
}

const missingZhCN = Object.entries(result).filter(([, value]) => !value.zhCN).map(([name]) => name);
const missingZhTW = Object.entries(result).filter(([, value]) => !value.zhTW).map(([name]) => name);

const lines = Object.keys(result).sort().map((name) => {
  const value = result[name];
  const fields = [`en: ${JSON.stringify(value.en)}`];
  if (value.zhCN) fields.push(`zhCN: ${JSON.stringify(value.zhCN)}`);
  if (value.zhTW) fields.push(`zhTW: ${JSON.stringify(value.zhTW)}`);
  return `  ${JSON.stringify(name)}: { ${fields.join(', ')} },`;
});

fs.writeFileSync(targetPath, `// Generated from @withfig/autocomplete + local specs and the committed
// zh-CN/zh-TW autocomplete dictionaries. Regenerate when specs change.
export type CommandDescription = { en: string; zhCN?: string; zhTW?: string };

export const COMMAND_DESCRIPTIONS: Record<string, CommandDescription> = {
${lines.join('\n')}
};
`);

console.log(JSON.stringify({
  commands: names.length,
  entries: Object.keys(result).length,
  missingZhCN,
  missingZhTW,
}, null, 2));
