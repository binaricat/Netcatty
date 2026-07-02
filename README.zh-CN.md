<p align="center">
  <img src="public/icon.png" alt="Netcatty" width="128" height="128">
</p>

<h1 align="center">Netcatty</h1>

<p align="center">
  <strong>🔥 AI 驱动的 SSH 客户端、SFTP 浏览器 & 终端管理器 🚀</strong><br/>
  <a href="https://netcatty.app"><strong>netcatty.app</strong></a>
</p>

<p align="center">
  一个基于 Electron、React 和 xterm.js 构建的功能丰富的 SSH 工作空间。<br/>
  🔥 内置 AI Agent · 分屏终端 · Vault 多视图 · SFTP 工作流 · 自定义主题 —— 一应俱全。
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

<img width="3142" height="1764" alt="Screenshot 2026-07-02 at 22 51 24" src="https://github.com/user-attachments/assets/3116165d-623a-4d3a-a28a-914befb9b72d" />

---

<a name="catty-agent"></a>
# 🔥 Catty Agent — 你的 IT 运维 AI 搭档

> 🚀 **用 AI 赋能你的日常 IT 运维工作。** Catty Agent 是内置的 AI 助手，能理解你的服务器环境、执行命令，并通过自然对话完成复杂的多主机操作。

### 🔥 Catty Agent 能做什么？

- 🚀 **自然语言管理服务器** —— 直接说出需求，不再需要记忆命令
- 🔥 **实时服务器诊断** —— 通过对话检查状态、查看日志、监控资源
- 🚀 **多主机协同** —— 跨多台服务器同时协调任务
- 🔥 **智能上下文感知** —— 理解你的服务器环境，给出有针对性的回应
- 🚀 **一键完成复杂操作** —— 搭集群、部署服务，一句话搞定

### 🎬 AI 实战演示

#### 🔥 单主机 —— 智能服务器诊断

让 Catty Agent 检查服务器健康状态，它会自动运行合适的命令、分析输出并给出清晰总结 —— 几秒内完成。

<img width="1510" height="870" alt="ai-single" src="https://github.com/user-attachments/assets/d3f34e53-8476-4fab-8634-394b931d1ff1" />

#### 🚀 多主机 —— Docker Swarm 集群搭建

看 Catty Agent 在一次对话中跨两台服务器编排 Docker Swarm 集群。它负责初始化、令牌交换和节点加入 —— 你只需说出想要的结果。

<img width="1515" height="870" alt="ai-muti" src="https://github.com/user-attachments/assets/ca166fc5-65d9-4d7b-951a-962c2ef230d8" />

---

# 目录 <!-- omit in toc -->

- [🔥 Catty Agent — AI 搭档](#catty-agent)
- [Netcatty 是什么](#netcatty-是什么)
- [为什么是 Netcatty](#为什么是-netcatty)
- [功能特性](#功能特性)
- [界面截图](#界面截图)
  - [主界面](#主界面)
  - [Vault 视图](#vault-视图)
  - [分屏终端](#分屏终端)
- [支持的发行版](#支持的发行版)
- [快速开始](#快速开始)
- [构建与打包](#构建与打包)
- [技术栈](#技术栈)
- [参与贡献](#参与贡献)
- [贡献者](#贡献者)
- [Star 历史](#star-历史)
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

- **以工作区为核心** —— 分屏 + 标签页 + 会话恢复，适合长期驻留的工作流
- **Vault 管理** —— 网格/列表/树形视图，配合快速搜索与拖拽流程更顺手
- **认真做的 SFTP** —— 内置编辑器 + 拖拽上传/下载，文件操作更丝滑

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

<a name="界面截图"></a>
# 界面截图

<a name="主界面"></a>
## 主界面

主界面围绕长期 SSH 工作流设计：把会话、导航和常用工具集中到同一处，减少切换成本。

<img width="1531" height="875" alt="black-grid" src="https://github.com/user-attachments/assets/004b80f6-5bbb-4f14-b8cd-33a0a5913b8c" />

<img width="1550" height="876" alt="light" src="https://github.com/user-attachments/assets/2b59a999-a25e-4217-944c-9aef0a09f272" />

<a name="vault-视图"></a>
## Vault 视图

用更适合当前任务的方式管理与浏览主机：网格看全局，列表做筛选，树形做整理与层级导航。

<img width="1554" height="882" alt="list" src="https://github.com/user-attachments/assets/03249f15-b5f8-4770-a3c3-d5001636ea00" />

<img width="1561" height="878" alt="tree" src="https://github.com/user-attachments/assets/739f7b66-3898-43d0-8dd3-b9b97fd8e8de" />

<a name="分屏终端"></a>
## 分屏终端

分屏适合同时处理多个任务（例如部署 + 日志 + 排障），不用频繁切换窗口。

<img width="1560" height="871" alt="split" src="https://github.com/user-attachments/assets/c93a8523-6256-4bb3-8b6e-d599831f2f9f" />

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
  <img src="public/distro/almalinux.svg" width="48" alt="AlmaLinux" title="AlmaLinux">
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

### Nix / NixOS

Netcatty 提供了一个 flake，为 Nix 和 NixOS 用户封装了官方 Linux AppImage 发行版：

```bash
nix run github:binaricat/Netcatty
```

声明式安装时，将 Netcatty flake 添加为输入，并在 NixOS 或 Home Manager 的软件包列表中使用 `inputs.netcatty.packages.${pkgs.system}.default`。

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
npm run pack:linux   # Linux (AppImage + DEB + RPM)
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

<a href="https://github.com/binaricat/Netcatty/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=binaricat/Netcatty" />
</a>

---

<a name="开源协议"></a>
# 开源协议

本项目采用 **GPL-3.0 协议** 开源 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

<a name="star-历史"></a>
# Star 历史

<a href="https://star-history.com/#binaricat/Netcatty&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date" />
 </picture>
</a>

---

<p align="center">
  用 ❤️ 制作，作者 <a href="https://ko-fi.com/binaricat">binaricat</a>
</p>
