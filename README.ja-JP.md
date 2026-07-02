<p align="center">
  <img src="public/icon.png" alt="Netcatty" width="128" height="128">
</p>

<h1 align="center">Netcatty</h1>

<p align="center">
  <strong>🔥 AI 搭載の SSH クライアント、SFTP ブラウザ & ターミナルマネージャー 🚀</strong><br/>
  <a href="https://netcatty.app"><strong>netcatty.app</strong></a>
</p>

<p align="center">
  Electron、React、xterm.js で構築された機能豊富な SSH ワークスペース。<br/>
  🔥 内蔵 AI Agent · 分割ターミナル · Vault ビュー · SFTP ワークフロー · カスタムテーマ — すべてが一つに。
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
    <img src="https://img.shields.io/github/v/release/binaricat/Netcatty?style=for-the-badge&logo=github&label=最新版をダウンロード&color=success" alt="最新版をダウンロード">
  </a>
</p>

<p align="center">
  <a href="https://ko-fi.com/binaricat">
    <img src="https://cdn.ko-fi.com/cdn/kofi3.png?v=2" width="150" alt="Ko-fi でサポート">
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja-JP.md">日本語</a>
</p>

---

<img width="3142" height="1764" alt="Screenshot 2026-07-02 at 22 51 24" src="https://github.com/user-attachments/assets/3116165d-623a-4d3a-a28a-914befb9b72d" />

---

<a name="catty-agent"></a>
# 🔥 Catty Agent — あなたの IT 運用 AI パートナー

> 🚀 **AI で日常の IT 運用作業を加速。** Catty Agent はサーバー環境を理解し、コマンドを実行し、自然な会話で複数ホストの複雑な操作をこなす内蔵 AI アシスタントです。

### 🔥 Catty Agent にできること

- 🚀 **自然言語でサーバー管理** — コマンドを暗記せず、必要なことを話しかけるだけ
- 🔥 **リアルタイムサーバー診断** — 会話を通じてステータス確認、ログ調査、リソース監視
- 🚀 **マルチホスト連携** — 複数サーバーのタスクを同時にコーディネート
- 🔥 **インテリジェントなコンテキスト認識** — サーバー環境を理解し、的確な回答を提供
- 🚀 **ワンステップで複雑な操作** — クラスター構築、サービスデプロイなど簡単な指示で実行

### 🎬 AI の動作デモ

#### 🔥 シングルホスト — インテリジェントなサーバー診断

Catty Agent にサーバーの健全性チェックを依頼すると、適切なコマンドを実行し、出力を分析して数秒で明確なサマリーを提示します。

<img width="1510" height="870" alt="ai-single" src="https://github.com/user-attachments/assets/d3f34e53-8476-4fab-8634-394b931d1ff1" />

#### 🚀 マルチホスト — Docker Swarm クラスターのセットアップ

1 つの会話で 2 台のサーバーをまたいで Docker Swarm クラスターをオーケストレーションする Catty Agent をご覧ください。初期化、トークン交換、ノード参加まですべてこなします — あなたは望む結果を伝えるだけ。

<img width="1515" height="870" alt="ai-muti" src="https://github.com/user-attachments/assets/ca166fc5-65d9-4d7b-951a-962c2ef230d8" />

---

# 目次 <!-- omit in toc -->

- [🔥 Catty Agent — AI パートナー](#catty-agent)
- [Netcatty とは](#netcatty-とは)
- [なぜ Netcatty](#なぜ-netcatty)
- [機能](#機能)
- [デモ](#デモ)
- [スクリーンショット](#スクリーンショット)
  - [メインウィンドウ](#メインウィンドウ)
  - [Vault ビュー](#vault-ビュー)
  - [分割ターミナル](#分割ターミナル)
- [対応ディストリビューション](#対応ディストリビューション)
- [はじめに](#はじめに)
- [ビルドとパッケージ](#ビルドとパッケージ)
- [技術スタック](#技術スタック)
- [コントリビューション](#コントリビューション)
- [コントリビューター](#コントリビューター)
- [Star 履歴](#star-履歴)
- [ライセンス](#ライセンス)

---

<a name="netcatty-とは"></a>
# Netcatty とは

**Netcatty** は、複数のリモートサーバーを効率的に管理する必要がある開発者、システム管理者、DevOps エンジニア向けに設計された、モダンなクロスプラットフォーム SSH クライアントおよびターミナルマネージャーです。

- **Netcatty は** PuTTY、Termius、SecureCRT、macOS Terminal.app の代替となる SSH 接続ツール
- **Netcatty は** 強力な SFTP クライアント（ドラッグ＆ドロップ + 内蔵エディタ）
- **Netcatty は** 分割ペイン、タブ、セッション管理を備えたターミナルワークスペース
- **Netcatty は** シェルの代替ではありません — SSH/Telnet/Mosh やローカル/シリアル経由でシェルに接続します（環境により異なります）

---

<a name="なぜ-netcatty"></a>
# なぜ Netcatty

複数サーバーを日常的に扱うなら、Netcatty は「スピード」と「流れ」を重視した作りになっています：

- **ワークスペース中心** — 分割ペインで複数セッションを並行操作
- **Vault の見やすさ** — グリッド/リスト/ツリーで状況に合わせて切り替え
- **SFTP の作業感** — ドラッグ＆ドロップと内蔵エディタでサクッと編集

---

<a name="機能"></a>
# 機能

### 🗂️ Vault
- **複数ビュー** — グリッド / リスト / ツリー
- **高速検索** — ホストやグループを素早く見つける

### 🖥️ ターミナルワークスペース
- **分割ペイン** — 水平・垂直分割でマルチタスク
- **セッション管理** — 複数の接続を並行して扱う

### 📁 SFTP + 内蔵エディタ
- **ファイル作業** — ドラッグ＆ドロップでアップロード/ダウンロード
- **その場で編集** — 内蔵エディタで小さな修正を素早く

### 🎨 パーソナライズ
- **カスタムテーマ** — UI の見た目を好みに調整
- **キーワードハイライト** — ターミナル出力の強調表示ルールをカスタマイズ

---

<a name="デモ"></a>
# デモ

動画で機能をさっと確認できます（素材は `screenshots/gifs/`）：

### Vault ビュー：グリッド / リスト / ツリー
状況に合わせて見え方を切り替え。グリッドで全体像、リストで密度、ツリーで階層を扱えます。

https://github.com/user-attachments/assets/e2742987-3131-404d-bd4b-06423e5bfd99

### 分割ターミナル + セッション管理
複数セッションを分割ペインで並べて作業。関連タスクを横並びにしてコンテキストスイッチを減らします。

https://github.com/user-attachments/assets/377d0c46-cc5a-4382-aa31-5acfd412ce62

### SFTP：ドラッグ＆ドロップ + 内蔵エディタ
ドラッグ＆ドロップでファイルを移動し、内蔵エディタでそのまま編集できます。

https://github.com/user-attachments/assets/c6e06af4-b0d5-461c-b0c7-9d6f655af6c7

### ドラッグでアップロード
ファイルをそのままドロップしてアップロードを開始。ダイアログ操作を減らせます。

https://github.com/user-attachments/assets/c8e0c4ff-f020-4e18-9b09-681ec97b003f

### カスタムテーマ
テーマを調整して自分の好みに合わせた見た目に。

https://github.com/user-attachments/assets/77e2a693-4ef2-4823-8ca1-9bcbf14ed98b

### キーワードハイライト
重要な出力（エラー/警告/マーカーなど）を見つけやすくするために、ハイライトをカスタマイズできます。

https://github.com/user-attachments/assets/e6516993-ad66-4594-8c28-57426082339b

---

<a name="スクリーンショット"></a>
# スクリーンショット

<a name="メインウィンドウ"></a>
## メインウィンドウ

メインウィンドウは、長時間の SSH 作業を前提に設計されています。セッション、ナビゲーション、主要ツールへ素早くアクセスできます。

<img width="1531" height="875" alt="black-grid" src="https://github.com/user-attachments/assets/004b80f6-5bbb-4f14-b8cd-33a0a5913b8c" />

<img width="1550" height="876" alt="light" src="https://github.com/user-attachments/assets/2b59a999-a25e-4217-944c-9aef0a09f272" />

<a name="vault-ビュー"></a>
## Vault ビュー

作業に合わせて見え方を切り替え：グリッドで全体像、リストでスキャン、ツリーで整理と階層ナビゲーション。

<img width="1554" height="882" alt="list" src="https://github.com/user-attachments/assets/03249f15-b5f8-4770-a3c3-d5001636ea00" />

<img width="1561" height="878" alt="tree" src="https://github.com/user-attachments/assets/739f7b66-3898-43d0-8dd3-b9b97fd8e8de" />

<a name="分割ターミナル"></a>
## 分割ターミナル

分割ペインで複数のサーバー/タスクを同時に扱えます（例：デプロイ + ログ + 監視）。

<img width="1560" height="871" alt="split" src="https://github.com/user-attachments/assets/c93a8523-6256-4bb3-8b6e-d599831f2f9f" />

---

<a name="対応ディストリビューション"></a>
# 対応ディストリビューション

Netcatty は接続したホストの OS を検出し、ホスト一覧でアイコンとして表示します：

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

---

<a name="はじめに"></a>
# はじめに

### ダウンロード

[GitHub Releases](https://github.com/binaricat/Netcatty/releases/latest) からお使いのプラットフォームに対応した最新版をダウンロードしてください。

| OS | サポート状況 |
| :--- | :--- |
| **macOS** | Universal (x64 / arm64) |
| **Windows** | x64 / arm64 |
| **Linux** | x64 / arm64 |

または [GitHub Releases](https://github.com/binaricat/Netcatty/releases) ですべてのリリースを参照してください。

> **macOS ユーザーへ：** 現在のリリースはコード署名と notarization が行われている想定です。Gatekeeper の警告が出る場合は、GitHub Releases から最新版の公式ビルドを取得しているか確認してください。

### Nix / NixOS

Netcatty は Nix および NixOS ユーザー向けに、公式 Linux AppImage リリースをラップした flake を提供しています：

```bash
nix run github:binaricat/Netcatty
```

宣言型インストールには、Netcatty flake を input として追加し、NixOS または Home Manager のパッケージリストで `inputs.netcatty.packages.${pkgs.system}.default` を使用してください。

### 前提条件
- Node.js 18+ と npm
- macOS、Windows 10+、または Linux

### 開発

```bash
# リポジトリをクローン
git clone https://github.com/binaricat/Netcatty.git
cd Netcatty

# 依存関係をインストール
npm install

# 開発モードを起動（Vite + Electron）
npm run dev
```

---

<a name="ビルドとパッケージ"></a>
# ビルドとパッケージ

```bash
# 本番用ビルド
npm run build

# 現在のプラットフォーム用にパッケージ
npm run pack

# 特定のプラットフォーム用にパッケージ
npm run pack:mac     # macOS (DMG + ZIP)
npm run pack:win     # Windows (NSIS インストーラー)
npm run pack:linux   # Linux (AppImage + DEB + RPM)
```

---

<a name="技術スタック"></a>
# 技術スタック

| カテゴリ | テクノロジー |
|--------|------------|
| フレームワーク | Electron 40 |
| フロントエンド | React 19, TypeScript |
| ビルドツール | Vite 7 |
| ターミナル | xterm.js 5 |
| スタイリング | Tailwind CSS 4 |
| SSH/SFTP | ssh2, ssh2-sftp-client |
| PTY | node-pty |
| アイコン | Lucide React |

---

<a name="コントリビューション"></a>
# コントリビューション

コントリビューションを歓迎します！お気軽に Pull Request を提出してください。

1. リポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. Pull Request をオープン

アーキテクチャの概要とコーディング規約については [agents.md](agents.md) を参照してください。

---

<a name="コントリビューター"></a>
# コントリビューター

貢献してくださったすべての方に感謝します！

<a href="https://github.com/binaricat/Netcatty/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=binaricat/Netcatty" />
</a>

---

<a name="ライセンス"></a>
# ライセンス

このプロジェクトは **GPL-3.0 ライセンス** の下でライセンスされています - 詳細は [LICENSE](LICENSE) ファイルをご覧ください。

---

<a name="star-履歴"></a>
# Star 履歴

<a href="https://star-history.com/#binaricat/Netcatty&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=binaricat/Netcatty&type=Date" />
 </picture>
</a>

---

<p align="center">
  ❤️ を込めて作成 by <a href="https://ko-fi.com/binaricat">binaricat</a>
</p>
