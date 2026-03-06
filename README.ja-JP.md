<p align="center">
  <img src="public/icon.png" alt="Netcatty" width="128" height="128">
</p>

<h1 align="center">Netcatty</h1>

<p align="center">
  <strong>モダンな SSH クライアント、SFTP ブラウザ & ターミナルマネージャー</strong><br/>
  <a href="https://netcatty.app"><strong>netcatty.app</strong></a>
</p>

<p align="center">
  Electron、React、xterm.js で構築された機能豊富な SSH ワークスペース。<br/>
  分割ターミナル、Vault ビュー、SFTP ワークフロー、カスタムテーマ、キーワードハイライト — すべてが一つに。
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

[![Netcatty メインインターフェース](screenshots/main-window-dark.png)](screenshots/main-window-dark.png)

---

# 目次 <!-- omit in toc -->

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

GIF で機能をさっと確認できます（素材は `screenshots/gifs/`）：

### Vault ビュー：グリッド / リスト / ツリー
状況に合わせて見え方を切り替え。グリッドで全体像、リストで密度、ツリーで階層を扱えます。

![Vault ビュー：グリッド/リスト/ツリー](screenshots/gifs/gird-list-tre-views.gif)

### 分割ターミナル + セッション管理
複数セッションを分割ペインで並べて作業。関連タスクを横並びにしてコンテキストスイッチを減らします。

![分割ターミナル + セッション管理](screenshots/gifs/dual-terminal--split-manage.gif)

### SFTP：ドラッグ＆ドロップ + 内蔵エディタ
ドラッグ＆ドロップでファイルを移動し、内蔵エディタでそのまま編集できます。

![SFTP：ドラッグ＆ドロップ + 内蔵エディタ](screenshots/gifs/sftpview-with-drag-and-built-in-editor.gif)

### ドラッグでアップロード
ファイルをそのままドロップしてアップロードを開始。ダイアログ操作を減らせます。

![ドラッグでアップロード](screenshots/gifs/drag-file-upload.gif)

### カスタムテーマ
テーマを調整して自分の好みに合わせた見た目に。

![カスタムテーマ](screenshots/gifs/custom-themes.gif)

### キーワードハイライト
重要な出力（エラー/警告/マーカーなど）を見つけやすくするために、ハイライトをカスタマイズできます。

![キーワードハイライト](screenshots/gifs/custom-highlight.gif)

---

<a name="スクリーンショット"></a>
# スクリーンショット

<a name="メインウィンドウ"></a>
## メインウィンドウ

メインウィンドウは、長時間の SSH 作業を前提に設計されています。セッション、ナビゲーション、主要ツールへ素早くアクセスできます。

![メインウィンドウ（ダーク）](screenshots/main-window-dark.png)

![メインウィンドウ（ライト）](screenshots/main-window-light.png)

<a name="vault-ビュー"></a>
## Vault ビュー

作業に合わせて見え方を切り替え：グリッドで全体像、リストでスキャン、ツリーで整理と階層ナビゲーション。

![Vault グリッドビュー](screenshots/vault_grid_view.png)

![Vault リストビュー](screenshots/vault_list_view.png)

![Vault ツリービュー（ダーク）](screenshots/treeview-dark.png)

![Vault ツリービュー（ライト）](screenshots/treeview-light.png)

<a name="分割ターミナル"></a>
## 分割ターミナル

分割ペインで複数のサーバー/タスクを同時に扱えます（例：デプロイ + ログ + 監視）。

![分割ウィンドウ](screenshots/split-window.png)

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

### プロジェクト構造

```
├── App.tsx                 # メイン React アプリケーション
├── components/             # React コンポーネント
│   ├── Terminal.tsx        # ターミナルコンポーネント
│   ├── SftpView.tsx        # SFTP ブラウザ
│   ├── VaultView.tsx       # ホスト管理
│   ├── KeyManager.tsx      # SSH キー管理
│   └── ...
├── application/            # 状態管理 & 国際化
├── domain/                 # ドメインモデル & ロジック
├── infrastructure/         # サービス & アダプター
├── electron/               # Electron メインプロセス
│   ├── main.cjs            # メインエントリ
│   └── bridges/            # IPC ブリッジ
└── public/                 # 静的アセット & アイコン
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

<a name="ライセンス"></a>
# ライセンス

このプロジェクトは **GPL-3.0 ライセンス** の下でライセンスされています - 詳細は [LICENSE](LICENSE) ファイルをご覧ください。

---

<p align="center">
  ❤️ を込めて作成 by <a href="https://ko-fi.com/binaricat">binaricat</a>
</p>
