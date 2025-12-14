# Netcatty 云同步系统架构文档

## 概述

Netcatty 实现了**无服务端（Serverless）的多端云同步系统**，支持以下云存储服务商：
- **GitHub Gist** - 使用 Device Flow 认证
- **Google Drive** - 使用 PKCE + Loopback 认证
- **Microsoft OneDrive** - 使用 PKCE + Loopback 认证

核心特性：
- **端到端加密** - 云服务商永远无法看到明文数据
- **零知识架构** - Master Key 仅存在于客户端内存或 Electron safeStorage
- **多端同步** - 同一账户可在多台设备间同步数据
- **冲突检测** - 基于版本向量的冲突检测与解决机制

---

## 安全架构

### 加密算法

| 组件 | 算法 | 参数 |
|------|------|------|
| 对称加密 | AES-256-GCM | 256-bit key, 128-bit tag |
| 密钥派生 | PBKDF2-SHA256 | 600,000 iterations |
| IV 生成 | CSPRNG | 12 bytes (96 bits) |
| Salt 生成 | CSPRNG | 32 bytes (256 bits) |

### 加密流程

```
用户密码 ─────┐
              │
    ┌─────────▼──────────┐
    │     PBKDF2         │
    │  600k iterations   │
    │    SHA-256         │
    └─────────┬──────────┘
              │
    ┌─────────▼──────────┐
    │   AES-256 Key      │
    └─────────┬──────────┘
              │
    ┌─────────▼──────────┐
    │   AES-256-GCM      │
    │  Encrypt Payload   │
    └─────────┬──────────┘
              │
              ▼
    ┌───────────────────┐
    │   Encrypted Data  │ ──────► 云存储
    │   + IV + Salt     │
    └───────────────────┘
```

### 安全状态机

```
                    ┌──────────────┐
                    │   NO_KEY     │  (未设置 Master Key)
                    └──────┬───────┘
                           │ setupMasterKey()
                           ▼
                    ┌──────────────┐
      lock() ◄──────│   UNLOCKED   │
         │          └──────┬───────┘
         │                 │ timeout / manual lock
         ▼                 ▼
    ┌──────────────┐      ┌──────────────┐
    │   LOCKED     │◄─────│   LOCKED     │
    └──────────────┘      └──────────────┘
           │
           │ unlock(password)
           ▼
    ┌──────────────┐
    │   UNLOCKED   │
    └──────────────┘
```

---

## 认证流程

### GitHub Device Flow (RFC 8628)

```
┌─────────┐                ┌─────────┐               ┌──────────┐
│  App    │                │  GitHub │               │  User    │
└────┬────┘                └────┬────┘               └────┬─────┘
     │                          │                         │
     │ POST /login/device/code  │                         │
     │─────────────────────────►│                         │
     │                          │                         │
     │   device_code, user_code │                         │
     │◄─────────────────────────│                         │
     │                          │                         │
     │                          │  显示 user_code        │
     │──────────────────────────────────────────────────►│
     │                          │                         │
     │                          │   用户访问 GitHub 并输入 code
     │                          │◄────────────────────────│
     │                          │                         │
     │ POST /login/oauth/access_token (polling)          │
     │─────────────────────────►│                         │
     │                          │                         │
     │      access_token        │                         │
     │◄─────────────────────────│                         │
     │                          │                         │
```

### Google/OneDrive PKCE Flow

```
┌─────────┐                ┌─────────┐               ┌──────────┐
│  App    │                │  OAuth  │               │  User    │
└────┬────┘                └────┬────┘               └────┬─────┘
     │                          │                         │
     │ 生成 code_verifier       │                         │
     │ 计算 code_challenge      │                         │
     │                          │                         │
     │ 打开浏览器 + auth URL     │                         │
     │──────────────────────────────────────────────────►│
     │                          │                         │
     │                          │   用户授权              │
     │                          │◄────────────────────────│
     │                          │                         │
     │    redirect to localhost:45678/callback           │
     │◄──────────────────────────────────────────────────│
     │                          │                         │
     │ POST /token              │                         │
     │ + code + code_verifier   │                         │
     │─────────────────────────►│                         │
     │                          │                         │
     │     tokens               │                         │
     │◄─────────────────────────│                         │
```

---

## 数据结构

### SyncedFile（加密后的云端文件）

```typescript
interface SyncedFile {
  meta: {
    version: number;           // 版本号
    updatedAt: number;         // 最后更新时间戳
    deviceId: string;          // 更新设备ID
    deviceName: string;        // 更新设备名称
    appVersion: string;        // 应用版本
    encryptionVersion: string; // 加密版本
    iv: string;                // Base64 编码的 IV
    salt: string;              // Base64 编码的 Salt
  };
  payload: string;             // Base64 编码的加密数据
}
```

### SyncPayload（解密后的数据）

```typescript
interface SyncPayload {
  hosts: Host[];
  keys: SSHKey[];
  snippets: Snippet[];
  customGroups: string[];
  portForwardingRules?: PortForwardingRule[];
  knownHosts?: KnownHost[];
  settings?: { /* ... */ };
  syncedAt: number;
}
```

---

## 文件结构

```
nebula-ssh/
├── domain/
│   └── sync.ts                    # 核心类型定义
│
├── infrastructure/
│   └── services/
│       ├── EncryptionService.ts   # 加密服务
│       ├── CloudSyncManager.ts    # 同步管理器
│       └── adapters/
│           ├── index.ts           # 适配器工厂
│           ├── GitHubAdapter.ts   # GitHub Gist 适配器
│           ├── GoogleDriveAdapter.ts   # Google Drive 适配器
│           └── OneDriveAdapter.ts      # OneDrive 适配器
│
├── application/
│   └── state/
│       └── useCloudSync.ts        # React Hook
│
└── components/
    ├── CloudSyncSettings.tsx      # 设置界面
    └── SyncStatusButton.tsx       # 顶栏状态按钮
```

---

## 配置常量

```typescript
const SYNC_CONSTANTS = {
  // 加密参数
  PBKDF2_ITERATIONS: 600000,
  PBKDF2_HASH: 'SHA-256',
  AES_KEY_LENGTH: 256,
  GCM_IV_LENGTH: 12,
  GCM_TAG_LENGTH: 128,
  SALT_LENGTH: 32,

  // 同步参数
  SYNC_INTERVAL_MS: 5 * 60 * 1000,  // 5分钟自动同步
  MAX_RETRY_COUNT: 3,
  CONFLICT_THRESHOLD_MS: 60 * 1000,

  // 云存储
  GIST_FILENAME: 'netcatty-sync.json',
  GOOGLE_FILE_NAME: 'netcatty-sync.json',
  ONEDRIVE_FILE_NAME: 'netcatty-sync.json',
};
```

---

## 存储键

| 键名 | 用途 |
|------|------|
| `netcatty_master_key_config_v1` | Master Key 配置（salt + 验证 hash） |
| `netcatty_device_id_v1` | 设备唯一标识 |
| `netcatty_github_connection_v1` | GitHub 连接状态和 tokens |
| `netcatty_google_connection_v1` | Google 连接状态和 tokens |
| `netcatty_onedrive_connection_v1` | OneDrive 连接状态和 tokens |

---

## OAuth 配置

### GitHub

```typescript
// 需要在 GitHub 创建 OAuth App
// Settings → Developer settings → OAuth Apps → New OAuth App
CLIENT_ID: '<your-github-client-id>'
// Device Flow 不需要 Client Secret
SCOPES: ['gist']
```

### Google Drive

```typescript
// 需要在 Google Cloud Console 创建 OAuth 2.0 Client
// APIs & Services → Credentials → Create OAuth client ID
// Application type: Desktop app
CLIENT_ID: '<your-google-client-id>'
SCOPES: [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email'
]
REDIRECT_URI: 'http://127.0.0.1:45678/oauth/callback'
```

### Microsoft OneDrive

```typescript
// 需要在 Azure Portal 创建 App Registration
// Azure Active Directory → App registrations → New registration
CLIENT_ID: '<your-azure-client-id>'
SCOPES: ['Files.ReadWrite.AppFolder', 'User.Read', 'offline_access']
REDIRECT_URI: 'http://127.0.0.1:45678/oauth/callback'
```

---

## 使用示例

### 设置 Master Key

```typescript
const { setupMasterKey } = useCloudSync();

await setupMasterKey('your-strong-password', 'confirm-password');
// Master Key 已设置，安全状态变为 UNLOCKED
```

### 连接 GitHub

```typescript
const { connectGitHub, completeGitHubAuth } = useCloudSync();

// 开始 Device Flow
const deviceFlow = await connectGitHub();
console.log(`请访问 ${deviceFlow.verificationUri}`);
console.log(`输入代码: ${deviceFlow.userCode}`);

// 轮询等待用户完成授权
await completeGitHubAuth(
  deviceFlow.deviceCode,
  deviceFlow.interval,
  deviceFlow.expiresAt,
  () => console.log('等待用户授权...')
);
```

### 同步数据

```typescript
const { syncNow } = useCloudSync();

const payload = {
  hosts: myHosts,
  keys: myKeys,
  snippets: mySnippets,
  customGroups: [],
  syncedAt: Date.now(),
};

const results = await syncNow(payload);
// results 是 Map<CloudProvider, SyncResult>
```

---

## 冲突解决

当检测到版本冲突时，系统会通过 `currentConflict` 状态通知用户：

```typescript
interface ConflictInfo {
  provider: CloudProvider;
  localVersion: number;
  remoteVersion: number;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  remoteDeviceId: string;
  remoteDeviceName: string;
}
```

用户可以选择：
- `USE_LOCAL` - 使用本地数据覆盖云端
- `USE_REMOTE` - 使用云端数据覆盖本地

```typescript
const { resolveConflict } = useCloudSync();

const remotePayload = await resolveConflict('USE_REMOTE');
if (remotePayload) {
  // 应用云端数据到本地
  applyPayload(remotePayload);
}
```

---

## 安全最佳实践

1. **Master Key 强度**
   - 最少 8 个字符
   - 建议使用密码管理器生成强密码
   - 密码不会以任何形式存储，仅派生 hash 用于验证

2. **Token 存储**
   - OAuth tokens 存储在 localStorage（可选加密）
   - 生产环境建议使用 Electron safeStorage

3. **传输安全**
   - 所有 API 调用使用 HTTPS
   - 敏感数据在传输前已加密

4. **密钥轮换**
   - 支持修改 Master Key（会重新加密所有数据）
   - 建议定期更换 Master Key

---

## 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| 网络错误 | 自动重试（最多3次），显示错误提示 |
| 认证过期 | 自动刷新 token，失败则要求重新授权 |
| 解密失败 | 检查 Master Key 是否正确 |
| 版本冲突 | 显示冲突解决对话框 |

---

## 未来改进

- [ ] Argon2id 密钥派生（替代 PBKDF2）
- [ ] 增量同步（仅同步变更部分）
- [ ] 本地备份/恢复
- [ ] 多设备冲突自动合并
- [ ] Dropbox 支持
- [ ] iCloud 支持（macOS）
