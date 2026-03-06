<p align="center">
  <img src="public/icon.png" alt="Netcatty" width="128" height="128">
</p>

<h1 align="center">Netcatty</h1>

<p align="center">
  <strong>现代化 SSH 客户端、SFTP 浏览器 & 终端管理器</strong><br/>
  <a href="https://netcatty.app"><strong>netcatty.app</strong></a>
</p>

<p align="center">
  一个基于 Electron、React 和 xterm.js 构建的功能丰富的 SSH 工作空间。<br/>
  分屏终端、Vault 多视图、SFTP 工作流、自定义主题、关键词高亮 —— 一应俱全。
</p>

<p align="center">
  <a href="https://github.com/binaricat/Netcatty/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/binaricat/Netcatty?style=for-the-badge&logo=github&label=Release"></a>
  &nbsp;
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge&logo=electron"></a>
  &nbsp;
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-green?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/binaricat/Netcatty/releases/latest">
    <img src="https://img.shields.io/github/v/release/binaricat/Netcatty?style=for-the-badge&logo=github&label=下载最新版&color=success" alt="下载最新版">
  </a>
</p>

<p align="center">
  <a href="https://ko-fi.com/binaricat">
    <img src="https://cdn.ko-fi.com/cdn/kofi3.png?v=2" width="150" alt="在 Ko-fi 上支持我">
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja-JP.md">日本語</a>
</p>

---

[![Netcatty 主界面](screenshots/main-window-dark.png)](screenshots/main-window-dark.png)

---

# 目录 <!-- omit in toc -->

- [Netcatty 是什么](#netcatty-是什么)
- [为什么是 Netcatty](#为什么是-netcatty)
- [功能特性](#功能特性)
- [演示](#演示)
- [界面截图](#界面截图)
  - [主界面](#主界面)
  - [Vault 视图](#vault-视图)
  - [分屏终端](#分屏终端)
- [支持的发行版](#支持的发行版)
- [快速开始](#快速开始)
- [构建与打包](#构建与打包)
- [技术栈](#技术栈)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)

---

<a name="netcatty-是什么"></a>
# Netcatty 是什么

**Netcatty** 是一款现代化的跨平台 SSH 客户端和终端管理器，专为需要高效管理多台远程服务器的开发者、系统管理员和 DevOps 工程师设计。

- **Netcatty 是** PuTTY、Termius、SecureCRT 和 macOS Terminal.app 的现代替代品
- **Netcatty 是** 一个强大的 SFTP 客户端，支持双窗格文件浏览
- **Netcatty 是** 一个终端工作空间，支持分屏、标签页和会话管理
- **Netcatty 支持** SSH、本地终端、Telnet、Mosh、串口（Serial）等连接方式（视环境而定）
- **Netcatty 不是** Shell 替代品 —— 它通过 SSH/Telnet/Mosh 或本地/串口会话连接到 Shell

---

<a name="为什么是-netcatty"></a>
# 为什么是 Netcatty

如果你需要同时维护多台服务器，Netcatty 更像是“工作台”而不是单一终端：

- **以工作区为核心** —— 分屏 + 多会话并行，适合长期驻留的工作流
- **Vault 管理** —— 网格/列表/树形视图，配合搜索与拖拽更顺手
- **认真做的 SFTP** —— 内置编辑器 + 拖拽上传，文件操作更丝滑

---

<a name="功能特性"></a>
# 功能特性

### 🗂️ Vault
- **多种视图** —— 网格 / 列表 / 树形
- **快速搜索** —— 迅速定位主机与分组

### 🖥️ 终端工作区
- **分屏** —— 水平/垂直分割，多任务并行
- **多会话管理** —— 多连接并排处理

### 📁 SFTP + 内置编辑器
- **文件工作流** —— 拖拽上传/下载更直观
- **就地编辑** —— 内置编辑器快速修改文件

### 🎨 个性化
- **自定义主题** —— 按喜好调整应用外观
- **关键词高亮** —— 自定义终端输出高亮规则

---

<a name="演示"></a>
# 演示

GIF 预览（素材均在 `screenshots/gifs/`），在 GitHub README 中可直接观看：

### Vault 视图：网格 / 列表 / 树形
根据不同场景自由切换视图：网格适合总览，列表适合密集浏览，树形适合层级导航与整理。

![Vault 视图：网格/列表/树形](screenshots/gifs/gird-list-tre-views.gif)

### 分屏终端 + 会话管理
用分屏把多个会话并排放在同一个工作区里，降低来回切换窗口/标签页的成本。

![分屏终端 + 会话管理](screenshots/gifs/dual-terminal--split-manage.gif)

### SFTP：拖拽 + 内置编辑器
通过拖拽完成文件传输，并用内置编辑器快速修改文件内容，不用来回切换工具。

![SFTP：拖拽 + 内置编辑器](screenshots/gifs/sftpview-with-drag-and-built-in-editor.gif)

### 拖拽文件上传
把文件直接拖进应用即可触发上传流程，省去多层对话框与路径选择。

![拖拽文件上传](screenshots/gifs/drag-file-upload.gif)

### 自定义主题
按自己的审美与习惯定制主题与界面外观，让日常使用更顺手。

![自定义主题](screenshots/gifs/custom-themes.gif)

### 关键词高亮
让关键输出一眼可见：错误、告警或特定标记被高亮后更容易扫到与定位。

![关键词高亮](screenshots/gifs/custom-highlight.gif)

---

<a name="界面截图"></a>
# 界面截图

<a name="主界面"></a>
## 主界面

主界面围绕长期 SSH 工作流设计：把会话、导航和常用工具集中到同一处，减少切换成本。

![主界面（深色）](screenshots/main-window-dark.png)

![主界面（浅色）](screenshots/main-window-light.png)

<a name="vault-视图"></a>
## Vault 视图

用更适合当前任务的方式管理与浏览主机：网格看全局，列表做筛选，树形做整理与层级导航。

![Vault 网格视图](screenshots/vault_grid_view.png)

![Vault 列表视图](screenshots/vault_list_view.png)

![Vault 树形视图（深色）](screenshots/treeview-dark.png)

![Vault 树形视图（浅色）](screenshots/treeview-light.png)

<a name="分屏终端"></a>
## 分屏终端

分屏适合同时处理多个任务（例如部署 + 日志 + 排障），不用频繁切换窗口。

![分屏窗口](screenshots/split-window.png)

---

<a name="支持的发行版"></a>
# 支持的发行版

Netcatty 会自动识别并在主机列表中展示对应的系统图标：

<p align="center">
  <img src="public/distro/ubuntu.svg" width="48" alt="Ubuntu" title="Ubuntu">
  <img src="public/distro/debian.svg" width="48" alt="Debian" title="Debian">
  <img src="public/distro/centos.svg" width="48" alt="CentOS" title="CentOS">
  <img src="public/distro/fedora.svg" width="48" alt="Fedora" title="Fedora">
  <img src="public/distro/arch.svg" width="48" alt="Arch Linux" title="Arch Linux">
  <img src="public/distro/alpine.svg" width="48" alt="Alpine" title="Alpine">
  <img src="public/distro/amazon.svg" width="48" alt="Amazon Linux" title="Amazon Linux">
  <img src="public/distro/redhat.svg" width="48" alt="Red Hat" title="Red Hat">
  <img src="public/distro/rocky.svg" width="48" alt="Rocky Linux" title="Rocky Linux">
  <img src="public/distro/opensuse.svg" width="48" alt="openSUSE" title="openSUSE">
  <img src="public/distro/oracle.svg" width="48" alt="Oracle Linux" title="Oracle Linux">
  <img src="public/distro/kali.svg" width="48" alt="Kali Linux" title="Kali Linux">
</p>

<a name="快速开始"></a>
# 快速开始

### 下载

从 [GitHub Releases](https://github.com/binaricat/Netcatty/releases/latest) 下载适合您平台的最新版本。

| 操作系统 | 支持情况 |
| :--- | :--- |
| **macOS** | Universal (x64 / arm64) |
| **Windows** | x64 / arm64 |
| **Linux** | x64 / arm64 |

或在 [GitHub Releases](https://github.com/binaricat/Netcatty/releases) 浏览所有版本。

> **macOS 用户注意：** 当前发布版本应已完成代码签名和公证。如果 Gatekeeper 仍然提示风险，请确认您下载的是 GitHub Releases 中的最新官方构建。

### 前置条件
- Node.js 18+ 和 npm
- macOS、Windows 10+ 或 Linux

### 开发

```bash
# 克隆仓库
git clone https://github.com/binaricat/Netcatty.git
cd Netcatty

# 安装依赖
npm install

# 启动开发模式（Vite + Electron）
npm run dev
```

### 项目结构

```
├── App.tsx                 # 主 React 应用
├── components/             # React 组件
│   ├── Terminal.tsx        # 终端组件
│   ├── SftpView.tsx        # SFTP 浏览器
│   ├── VaultView.tsx       # 主机管理
│   ├── KeyManager.tsx      # SSH 密钥管理
│   └── ...
├── application/            # 状态管理 & 国际化
├── domain/                 # 领域模型 & 逻辑
├── infrastructure/         # 服务 & 适配器
├── electron/               # Electron 主进程
│   ├── main.cjs            # 主入口
│   └── bridges/            # IPC 桥接
└── public/                 # 静态资源 & 图标
```

---

<a name="构建与打包"></a>
# 构建与打包

```bash
# 生产构建
npm run build

# 为当前平台打包
npm run pack

# 为特定平台打包
npm run pack:mac     # macOS (DMG + ZIP)
npm run pack:win     # Windows (NSIS 安装程序)
npm run pack:linux   # Linux (AppImage, deb, rpm)
```

---

<a name="技术栈"></a>
# 技术栈

| 分类 | 技术 |
|-----|-----|
| 框架 | Electron 40 |
| 前端 | React 19, TypeScript |
| 构建工具 | Vite 7 |
| 终端 | xterm.js 5 |
| 样式 | Tailwind CSS 4 |
| SSH/SFTP | ssh2, ssh2-sftp-client |
| PTY | node-pty |
| 图标 | Lucide React |

---

<a name="参与贡献"></a>
# 参与贡献

欢迎贡献！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建你的功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交你的更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开一个 Pull Request

查看 [agents.md](agents.md) 了解架构概述和编码规范。

---

<a name="贡献者"></a>
# 贡献者

感谢所有参与贡献的人！

查看：https://github.com/binaricat/Netcatty/graphs/contributors

---

<a name="开源协议"></a>
# 开源协议

本项目采用 **GPL-3.0 协议** 开源 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

<p align="center">
  用 ❤️ 制作，作者 <a href="https://ko-fi.com/binaricat">binaricat</a>
</p>
