# Agent Asset Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe agent-accessible server asset management for saved Vault hosts, including add, edit, remove, open, connect, disconnect, and reconnect without leaking credentials.

**Architecture:** Reuse existing Vault `Host` state as the asset model. Add a shared allowlisted redaction and argument-masking layer, extend the renderer Vault agent bridge for CRUD, add a renderer app-action bridge for UI/session side effects, then expose canonical `asset.*` capabilities through catalog, RPC, Catty/global tools, and public MCP.

**Tech Stack:** TypeScript, React hooks, Electron IPC, Netcatty capability catalog/codegen, node:test, tsx, Vite/tsc.

---

## File Structure

- Create `domain/agentAsset.ts`
  - Owns `RedactedAgentHost`, `redactHostForAgent`, `containsRawHostSecretInput`, `maskSecretToolArgs`, and helpers shared by renderer and tests.
  - Uses an explicit allowlist. No object spreading from `Host` into agent-visible output.

- Create `domain/agentAsset.test.ts`
  - Verifies redaction omits `password`, `telnetPassword`, `privateKey`, `passphrase`, `identityFilePaths`, proxy/env/startup fields, and `Host.notes` content.
  - Verifies masking covers nested JSON strings used by `vault.hosts.create` and raw text used by `vault.host.import`.

- Modify `infrastructure/ai/vaultAgentBridgeClient.ts`
  - Replace current host sanitizer/list summary with `redactHostForAgent`.
  - Add `asset.list`, `asset.get`, `asset.add`, `asset.edit`, and `asset.remove`.
  - Keep `host.get`, `host.list`, `hosts.create`, and `host.import` compatible but redacted.

- Modify `infrastructure/ai/vaultAgentBridgeClient.test.ts`
  - Add tests for asset CRUD and compatibility non-leak behavior.

- Create `infrastructure/ai/assetActionBridgeClient.ts`
  - Renderer-side handler for `asset.open`, `asset.connect`, `asset.disconnect`, and `asset.reconnect`.
  - Returns only redacted host/session summaries.

- Create `infrastructure/ai/assetActionBridgeClient.test.ts`
  - Unit tests for open/connect/disconnect/reconnect decisions and session ambiguity.

- Create `application/state/useAssetActionBridge.ts`
  - Wires current React app state and handlers into `assetActionBridgeClient`.

- Modify `App.tsx`
  - Register `useAssetActionBridge` near `useVaultAgentBridge`.
  - Pass `hosts`, `sessions`, `resolveEffectiveHost`, `handleConnectToHost`, `closeSession`, `setActiveTabId`, `setNavigateToSection`, `setDeepLinkHostDraft`, and `setWorkspaceFocusedSession`.

- Create `electron/bridges/aiBridge/assetActionBridge.cjs`
  - Main-process bridge matching the existing VaultAgentBridge request/response pattern.

- Modify `electron/bridges/aiBridge.cjs`
  - Register the asset action bridge and expose `invokeAssetAction`.

- Create `electron/capabilities/catalog/asset.cjs`
  - Canonical `asset.*` capability definitions.

- Modify `electron/capabilities/catalog/index.cjs`
  - Include `ASSET_CAPABILITIES`.

- Modify `electron/capabilities/schemas/toolInputs.cjs`
  - Add schemas for `asset_list`, `asset_get`, `asset_add`, `asset_edit`, `asset_remove`, `asset_open`, `asset_connect`, `asset_disconnect`, and `asset_reconnect`.

- Modify `electron/capabilities/services/vaultService.cjs`
  - Add asset CRUD methods routed to `invokeVaultAgent`.
  - Add secret masking/reject checks before invoking renderer for asset add/edit and compatibility create/import.

- Create `electron/capabilities/services/assetSessionService.cjs`
  - Calls `invokeAssetAction` for open/connect/disconnect/reconnect.

- Modify `electron/bridges/mcpServerBridge/capabilityRpcDispatch.cjs`
  - Add service bindings for `asset.*` capabilities.
  - Pass `invokeAssetAction` into service registry.

- Modify `electron/capabilities/services/index.cjs` if needed by local exports.

- Modify `components/ai/PublicMcpApprovalPanel.tsx`
  - Display masked args instead of raw `approval.args`.

- Modify `components/ai/ChatMessageList.tsx`, `components/ai/toolArtifacts/formatVaultToolTooltip.ts`, `components/ai/cattyHistoryReplay.ts`, `infrastructure/ai/conversationExport.ts`, and `infrastructure/ai/harness/turnDrivers/cattyStreamProcessor.ts`
  - Use masked tool args for display/history/export/replay persistence where asset/vault host secret-bearing calls appear.

- Modify `components/ai/toolArtifacts/vaultToolArtifact.ts`
  - Add canonical asset tool names and keep artifacts redacted.

- Modify generated files via `npm run generate:capability-tools`
  - `infrastructure/ai/harness/generated/cattyToolSpecs.json`
  - `infrastructure/ai/harness/generated/globalAgentToolSpecs.json`
  - MCP registry output if the generator updates it.

---

## Task 1: Redaction And Argument Masking Foundation

**Files:**
- Create: `domain/agentAsset.ts`
- Create: `domain/agentAsset.test.ts`
- Modify: `infrastructure/ai/vaultAgentBridgeClient.ts`
- Modify: `infrastructure/ai/vaultAgentBridgeClient.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Add `domain/agentAsset.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from './models';
import {
  containsRawHostSecretInput,
  maskSecretToolArgs,
  redactHostForAgent,
} from './agentAsset';

const secretHost = {
  id: 'host-1',
  label: 'prod',
  hostname: '10.0.0.1',
  username: 'root',
  password: 'ssh-password-secret',
  telnetPassword: 'telnet-password-secret',
  port: 22,
  tags: ['prod'],
  os: 'linux',
  authMethod: 'password',
  privateKey: 'legacy-private-key-secret',
  passphrase: 'legacy-passphrase-secret',
  identityFilePaths: ['/Users/me/.ssh/prod-key'],
  startupCommand: 'echo startup-secret',
  environmentVariables: [{ key: 'TOKEN', value: 'env-secret', enabled: true }],
  proxyConfig: { type: 'ssh', host: 'proxy.example.com', port: 22, username: 'proxy', password: 'proxy-secret' },
  notes: 'note contains pasted-secret',
} as Host & Record<string, unknown>;

describe('redactHostForAgent', () => {
  it('returns an allowlisted host shape without secrets or freeform notes', () => {
    const redacted = redactHostForAgent(secretHost);
    const serialized = JSON.stringify(redacted);

    assert.equal(redacted.id, 'host-1');
    assert.equal(redacted.hostname, '10.0.0.1');
    assert.equal(redacted.hasPassword, true);
    assert.equal(redacted.hasKey, true);
    assert.equal(redacted.hasNotes, true);
    assert.equal(redacted.notesLength, 'note contains pasted-secret'.length);

    assert.doesNotMatch(serialized, /ssh-password-secret/);
    assert.doesNotMatch(serialized, /telnet-password-secret/);
    assert.doesNotMatch(serialized, /legacy-private-key-secret/);
    assert.doesNotMatch(serialized, /legacy-passphrase-secret/);
    assert.doesNotMatch(serialized, /pasted-secret/);
    assert.doesNotMatch(serialized, /proxy-secret/);
    assert.doesNotMatch(serialized, /env-secret/);
    assert.doesNotMatch(serialized, /startup-secret/);
    assert.doesNotMatch(serialized, /prod-key/);
  });
});

describe('maskSecretToolArgs', () => {
  it('masks secret fields in nested JSON host creation input', () => {
    const args = {
      hosts: JSON.stringify([
        { hostname: 'a.example.com', password: 'pw-secret', telnetPassword: 'tn-secret', privateKey: 'key-secret', passphrase: 'phrase-secret' },
      ]),
    };

    assert.equal(containsRawHostSecretInput(args), true);
    const masked = maskSecretToolArgs('vault_hosts_create', args);
    const serialized = JSON.stringify(masked);
    assert.doesNotMatch(serialized, /pw-secret|tn-secret|key-secret|phrase-secret/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it('masks import text because exported host data can contain credentials', () => {
    const masked = maskSecretToolArgs('vault_hosts_import', {
      format: 'csv',
      text: 'Hostname,Password\\n10.0.0.1,import-secret',
    });
    assert.doesNotMatch(JSON.stringify(masked), /import-secret/);
    assert.equal(masked.text, '[REDACTED_IMPORT_TEXT]');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- domain/agentAsset.test.ts infrastructure/ai/vaultAgentBridgeClient.test.ts
```

Expected: `domain/agentAsset.test.ts` fails because `domain/agentAsset.ts` does not exist.

- [ ] **Step 3: Implement `domain/agentAsset.ts`**

Create `domain/agentAsset.ts`:

```ts
import type { Host } from './models';

export interface RedactedAgentHost {
  id: string;
  label: string;
  hostname: string;
  port?: number;
  username: string;
  protocol?: Host['protocol'];
  group?: string;
  tags: string[];
  os: Host['os'];
  authMethod?: Host['authMethod'];
  hasPassword: boolean;
  hasKey: boolean;
  hasNotes: boolean;
  notesLength: number;
  connectScriptIds?: string[];
  loginScriptId?: string;
  createdAt?: number;
  lastConnectedAt?: number;
  order?: number;
}

export const HOST_SECRET_FIELD_NAMES = new Set([
  'password',
  'telnetPassword',
  'privateKey',
  'passphrase',
]);

const SECRET_ARG_TOOL_NAMES = new Set([
  'asset_add',
  'asset_edit',
  'vault_hosts_create',
  'vault_hosts_import',
]);

function hasString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function redactHostForAgent(host: Host): RedactedAgentHost {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    protocol: host.protocol,
    group: host.group,
    tags: Array.isArray(host.tags) ? [...host.tags] : [],
    os: host.os,
    authMethod: host.authMethod,
    hasPassword: hasString(host.password) || hasString(host.telnetPassword),
    hasKey: hasString(host.identityFileId) || hasString(host.identityId) || Boolean(host.identityFilePaths?.length),
    hasNotes: hasString(host.notes),
    notesLength: typeof host.notes === 'string' ? host.notes.length : 0,
    connectScriptIds: host.connectScriptIds ? [...host.connectScriptIds] : undefined,
    loginScriptId: host.loginScriptId,
    createdAt: host.createdAt,
    lastConnectedAt: host.lastConnectedAt,
    order: host.order,
  };
}

function maskUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskUnknown);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = HOST_SECRET_FIELD_NAMES.has(key) ? '[REDACTED]' : maskUnknown(entry);
  }
  return out;
}

function maskJsonString(value: string): string {
  try {
    return JSON.stringify(maskUnknown(JSON.parse(value)));
  } catch {
    return '[REDACTED_JSON_WITH_SECRETS]';
  }
}

export function containsRawHostSecretInput(args: Record<string, unknown>): boolean {
  const direct = ['password', 'telnetPassword', 'privateKey', 'passphrase'].some((key) => hasString(args[key]));
  return direct || hasString(args.hosts) || hasString(args.text);
}

export function maskSecretToolArgs(toolName: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  if (!SECRET_ARG_TOOL_NAMES.has(toolName)) return args;
  const out = maskUnknown(args) as Record<string, unknown>;
  if (typeof args.hosts === 'string') out.hosts = maskJsonString(args.hosts);
  if (typeof args.text === 'string') out.text = '[REDACTED_IMPORT_TEXT]';
  return out;
}
```

- [ ] **Step 4: Replace host sanitizer usage**

In `infrastructure/ai/vaultAgentBridgeClient.ts`:

```ts
import {
  redactHostForAgent,
  type RedactedAgentHost,
} from '../../domain/agentAsset';
```

Delete the local `SENSITIVE_HOST_KEYS`, `sanitizeHostForAgent`, and `summarizeHostForList` implementation. Replace calls:

```ts
sanitizeHostForAgent(deps.resolveEffectiveHost(host))
```

with:

```ts
redactHostForAgent(deps.resolveEffectiveHost(host))
```

Replace list mapping:

```ts
deps.getHosts().map((host) => summarizeHostForList(deps.resolveEffectiveHost(host)))
```

with:

```ts
deps.getHosts().map((host) => redactHostForAgent(deps.resolveEffectiveHost(host)))
```

- [ ] **Step 5: Strengthen existing Vault bridge tests**

In `infrastructure/ai/vaultAgentBridgeClient.test.ts`, update the host list test to assert:

```ts
assert.equal(hosts?.[0]?.hasPassword, true);
assert.equal(hosts?.[0]?.hasNotes, false);
assert.equal('password' in (hosts?.[0] ?? {}), false);
assert.equal('notes' in (hosts?.[0] ?? {}), false);
assert.doesNotMatch(JSON.stringify(result), /secret/);
```

Add a host with `notes: 'note-secret'`, `telnetPassword: 'telnet-secret'`, `identityFilePaths: ['/tmp/private-key']`, and assert serialized output does not contain any of those values.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test -- domain/agentAsset.test.ts infrastructure/ai/vaultAgentBridgeClient.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit phase 1**

Run:

```bash
git add domain/agentAsset.ts domain/agentAsset.test.ts infrastructure/ai/vaultAgentBridgeClient.ts infrastructure/ai/vaultAgentBridgeClient.test.ts
git commit -m "feat: add safe agent asset redaction"
```

- [ ] **Step 8: Review phase 1**

Run a code review focused on phase 1. Required review checks:

- `redactHostForAgent` uses only an allowlist.
- No `Host.notes`, `password`, `telnetPassword`, key material, proxy secret, env value, startup command, or file path can appear in serialized redacted output.
- Compatibility host get/list/create/import all use the same redaction.

---

## Task 2: Vault Asset CRUD In Renderer Bridge

**Files:**
- Modify: `infrastructure/ai/vaultAgentBridgeClient.ts`
- Modify: `infrastructure/ai/vaultAgentBridgeClient.test.ts`

- [ ] **Step 1: Write failing asset CRUD tests**

Add tests under `describe('handleVaultAgentOp vault hosts', ...)`:

```ts
it('asset.add creates hosts and returns redacted assets', async () => {
  const deps = createDeps({ hosts: [], customGroups: [] });
  const result = await handleVaultAgentOp('asset.add', {
    hosts: JSON.stringify([{ hostname: 'asset.example.com', username: 'deploy', password: 'asset-secret', notes: 'note-secret' }]),
  }, deps);

  assert.equal(result.ok, true);
  assert.equal((result as { addedCount?: number }).addedCount, 1);
  assert.equal(deps.getHosts().length, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /asset-secret|note-secret/);
});

it('asset.edit patches only provided fields and keeps secret clearing explicit', async () => {
  const deps = createDeps({
    hosts: [{
      id: 'host-1',
      label: 'old',
      hostname: 'old.example.com',
      username: 'root',
      password: 'existing-secret',
      tags: [],
      os: 'linux',
    }],
  });

  const result = await handleVaultAgentOp('asset.edit', {
    hostId: 'host-1',
    patch: { label: 'new', hostname: 'new.example.com' },
  }, deps);

  assert.equal(result.ok, true);
  assert.equal(deps.getHosts()[0].label, 'new');
  assert.equal(deps.getHosts()[0].password, 'existing-secret');
  assert.doesNotMatch(JSON.stringify(result), /existing-secret/);
});

it('asset.remove deletes only the host', async () => {
  const deps = createDeps({
    hosts: [
      { id: 'host-1', label: 'a', hostname: 'a.example.com', username: 'root', tags: [], os: 'linux', notes: 'note-secret' },
      { id: 'host-2', label: 'b', hostname: 'b.example.com', username: 'root', tags: [], os: 'linux' },
    ],
  });

  const result = await handleVaultAgentOp('asset.remove', { hostId: 'host-1' }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(deps.getHosts().map((host) => host.id), ['host-2']);
  assert.doesNotMatch(JSON.stringify(result), /note-secret/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- infrastructure/ai/vaultAgentBridgeClient.test.ts
```

Expected: FAIL with unknown `asset.add`, `asset.edit`, and `asset.remove`.

- [ ] **Step 3: Implement asset op aliases and edit/remove helpers**

In `vaultAgentBridgeClient.ts`:

- Add `case 'asset.list'` that returns the same as `host.list`.
- Add `case 'asset.get'` that returns `{ ok: true, asset: redactHostForAgent(...) }`.
- Add `case 'asset.add'` that delegates to the existing `hosts.create` path or extracts the shared host-create block into `createHostsFromParams(params, deps)`.
- Add `case 'asset.edit'` with this behavior:

```ts
const hostId = String(params.hostId || '');
const patch = params.patch && typeof params.patch === 'object' && !Array.isArray(params.patch)
  ? params.patch as Partial<Host> & { clearPassword?: boolean; clearTelnetPassword?: boolean; clearPrivateKey?: boolean; clearPassphrase?: boolean }
  : null;
if (!hostId) return { ok: false, error: 'hostId is required.' };
if (!patch) return { ok: false, error: 'patch is required.' };
const existing = deps.getHosts().find((entry) => entry.id === hostId);
if (!existing) return { ok: false, error: 'Host not found.' };
const nextHost: Host = {
  ...existing,
  ...safeAllowedPatchFields(patch),
  password: patch.clearPassword ? undefined : (patch.password !== undefined ? String(patch.password) : existing.password),
  telnetPassword: patch.clearTelnetPassword ? undefined : (patch.telnetPassword !== undefined ? String(patch.telnetPassword) : existing.telnetPassword),
};
deps.updateHosts(deps.getHosts().map((entry) => entry.id === hostId ? nextHost : entry));
return { ok: true, asset: redactHostForAgent(deps.resolveEffectiveHost(nextHost)) };
```

`safeAllowedPatchFields` should allow only scalar/list fields required for asset editing: `label`, `hostname`, `port`, `username`, `protocol`, `group`, `tags`, `os`, `authMethod`, `identityId`, `identityFileId`, `notes`, `connectScriptIds`, `loginScriptId`.

- Add `case 'asset.remove'`:

```ts
const hostId = String(params.hostId || '');
if (!hostId) return { ok: false, error: 'hostId is required.' };
const existing = deps.getHosts().find((entry) => entry.id === hostId);
if (!existing) return { ok: false, error: 'Host not found.' };
deps.updateHosts(deps.getHosts().filter((entry) => entry.id !== hostId));
return { ok: true, hostId, asset: redactHostForAgent(deps.resolveEffectiveHost(existing)) };
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- infrastructure/ai/vaultAgentBridgeClient.test.ts domain/agentAsset.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit phase 2**

Run:

```bash
git add infrastructure/ai/vaultAgentBridgeClient.ts infrastructure/ai/vaultAgentBridgeClient.test.ts
git commit -m "feat: add renderer asset crud bridge"
```

- [ ] **Step 6: Review phase 2**

Review checks:

- `asset.edit` cannot clear credentials unless an explicit clear flag is present.
- `asset.remove` only removes the host array entry.
- Responses never include raw credentials or `Host.notes` content.

---

## Task 3: Secret Argument Masking Across UI, Trace, And Approval Paths

**Files:**
- Modify: `components/ai/PublicMcpApprovalPanel.tsx`
- Modify: `components/ai/ChatMessageList.tsx`
- Modify: `components/ai/toolArtifacts/formatVaultToolTooltip.ts`
- Modify: `components/ai/cattyHistoryReplay.ts`
- Modify: `infrastructure/ai/conversationExport.ts`
- Modify: `infrastructure/ai/harness/turnDrivers/cattyStreamProcessor.ts`
- Create or modify tests near each changed file.

- [ ] **Step 1: Write failing masking tests**

Add or update tests so each serialized display/export output omits:

```ts
const secretArgs = {
  hosts: JSON.stringify([{ hostname: 'a.example.com', password: 'pw-secret', telnetPassword: 'tn-secret' }]),
  text: 'Hostname,Password\\na.example.com,import-secret',
};
```

Required assertions:

```ts
assert.doesNotMatch(renderedOrSerialized, /pw-secret|tn-secret|import-secret/);
assert.match(renderedOrSerialized, /REDACTED/);
```

Target tests:

- `components/ai/PublicMcpApprovalPanel.test.tsx`
- `components/ai/ChatMessageList.test.tsx`
- `components/ai/toolArtifacts/formatVaultToolTooltip.test.ts`
- `components/ai/cattyHistoryReplay.test.ts` if present, otherwise create it
- `infrastructure/ai/conversationExport.test.ts` if present, otherwise create it
- `infrastructure/ai/harness/turnDrivers/cattyStreamProcessor.test.ts` if present, otherwise add assertions to existing harness stream processor tests

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- components/ai/PublicMcpApprovalPanel.test.tsx components/ai/ChatMessageList.test.tsx components/ai/toolArtifacts/formatVaultToolTooltip.test.ts infrastructure/ai/conversationExport.test.ts infrastructure/ai/harness/turnDrivers/cattyStreamProcessor.test.ts
```

Expected: FAIL where raw args are currently serialized.

- [ ] **Step 3: Apply masking at display and persistence boundaries**

Import `maskSecretToolArgs` from `domain/agentAsset`.

Use these replacements:

- In `PublicMcpApprovalPanel.tsx`, render `JSON.stringify(maskSecretToolArgs(approval.toolName, approval.args), null, 2)`.
- In `ChatMessageList.tsx`, before storing or passing `tc.arguments` to result cards, use `maskSecretToolArgs(tc.name, tc.arguments ?? {})`.
- In `formatVaultToolTooltip.ts`, format masked args.
- In `cattyHistoryReplay.ts`, mask tool call arguments before building replay text.
- In `conversationExport.ts`, export masked tool call arguments.
- In `cattyStreamProcessor.ts`, store masked arguments in UI messages when a tool call is appended. Keep the raw `args` only for actual tool execution in the local execution closure.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit phase 3**

Run:

```bash
git add components/ai infrastructure/ai domain/agentAsset.ts
git commit -m "fix: mask secret asset tool arguments"
```

- [ ] **Step 6: Review phase 3**

Review checks:

- Approval panels, tool cards, artifacts, history replay, conversation export, and trace/UI stored messages do not retain raw asset host secrets.
- Raw args are still available only at the execution boundary needed to create/import hosts.

---

## Task 4: Asset Session And UI Action Bridge

**Files:**
- Create: `infrastructure/ai/assetActionBridgeClient.ts`
- Create: `infrastructure/ai/assetActionBridgeClient.test.ts`
- Create: `application/state/useAssetActionBridge.ts`
- Modify: `App.tsx`
- Create: `electron/bridges/aiBridge/assetActionBridge.cjs`
- Modify: `electron/bridges/aiBridge.cjs`

- [ ] **Step 1: Write failing action client tests**

Create `infrastructure/ai/assetActionBridgeClient.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleAssetActionOp } from './assetActionBridgeClient';
import type { Host } from '../../domain/models';

const host: Host = {
  id: 'host-1',
  label: 'prod',
  hostname: 'prod.example.com',
  username: 'root',
  password: 'secret',
  tags: [],
  os: 'linux',
  protocol: 'ssh',
};

describe('handleAssetActionOp', () => {
  it('opens a host in Vault without leaking credentials', async () => {
    const opened: string[] = [];
    const result = await handleAssetActionOp('asset.open', { hostId: 'host-1' }, {
      getHosts: () => [host],
      getSessions: () => [],
      resolveEffectiveHost: (entry) => entry,
      openHost: (hostId) => { opened.push(hostId); },
      connectHost: () => 'unused',
      closeSession: () => true,
      focusSession: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(opened, ['host-1']);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('requires sessionId when disconnect by host is ambiguous', async () => {
    const result = await handleAssetActionOp('asset.disconnect', { hostId: 'host-1' }, {
      getHosts: () => [host],
      getSessions: () => [
        { id: 's1', hostId: 'host-1', status: 'connected' },
        { id: 's2', hostId: 'host-1', status: 'connected' },
      ],
      resolveEffectiveHost: (entry) => entry,
      openHost: () => {},
      connectHost: () => 'unused',
      closeSession: () => true,
      focusSession: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /sessionId/);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- infrastructure/ai/assetActionBridgeClient.test.ts
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement renderer action client**

Create `infrastructure/ai/assetActionBridgeClient.ts` with:

```ts
import type { Host } from '../../domain/models';
import { redactHostForAgent } from '../../domain/agentAsset';

type AgentSession = { id: string; hostId?: string; status?: string; workspaceId?: string };

export interface AssetActionDeps {
  getHosts: () => Host[];
  getSessions: () => AgentSession[];
  resolveEffectiveHost: (host: Host) => Host;
  openHost: (hostId: string) => void;
  connectHost: (host: Host) => string | void;
  closeSession: (sessionId: string) => boolean | void;
  focusSession: (sessionId: string) => void;
}

function sessionSummary(session: AgentSession) {
  return { sessionId: session.id, hostId: session.hostId, status: session.status, workspaceId: session.workspaceId };
}

function findHost(deps: AssetActionDeps, hostId: string) {
  return deps.getHosts().find((entry) => entry.id === hostId);
}

export async function handleAssetActionOp(op: string, params: Record<string, unknown>, deps: AssetActionDeps) {
  const hostId = typeof params.hostId === 'string' ? params.hostId : '';
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';

  switch (op) {
    case 'asset.open': {
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const host = findHost(deps, hostId);
      if (!host) return { ok: false, error: 'Host not found.' };
      deps.openHost(hostId);
      return { ok: true, asset: redactHostForAgent(deps.resolveEffectiveHost(host)) };
    }
    case 'asset.connect': {
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const host = findHost(deps, hostId);
      if (!host) return { ok: false, error: 'Host not found.' };
      const effectiveHost = deps.resolveEffectiveHost(host);
      if ((effectiveHost.protocol ?? 'ssh') !== 'ssh') return { ok: false, error: 'Only SSH host assets are supported for connect operations.' };
      const newSessionId = deps.connectHost(host);
      return { ok: true, asset: redactHostForAgent(effectiveHost), sessionId: typeof newSessionId === 'string' ? newSessionId : undefined };
    }
    case 'asset.disconnect': {
      const sessions = deps.getSessions().filter((entry) => (
        sessionId ? entry.id === sessionId : hostId ? entry.hostId === hostId : false
      ));
      if (sessions.length === 0) return { ok: false, error: 'Session not found or already closed.' };
      if (!sessionId && sessions.length > 1) return { ok: false, error: 'sessionId is required because multiple sessions match this host.', sessions: sessions.map(sessionSummary) };
      const target = sessions[0];
      deps.closeSession(target.id);
      return { ok: true, session: sessionSummary(target) };
    }
    case 'asset.reconnect': {
      const sessions = deps.getSessions().filter((entry) => entry.id === sessionId);
      const session = sessions[0];
      if (!session) return { ok: false, error: 'Session not found or already closed.' };
      const host = session.hostId ? findHost(deps, session.hostId) : undefined;
      if (!host) return { ok: false, error: 'Host not found.' };
      deps.closeSession(session.id);
      const newSessionId = deps.connectHost(host);
      return { ok: true, previousSession: sessionSummary(session), sessionId: typeof newSessionId === 'string' ? newSessionId : undefined, asset: redactHostForAgent(deps.resolveEffectiveHost(host)) };
    }
    default:
      return { ok: false, error: `Unknown asset action operation "${op}".` };
  }
}
```

- [ ] **Step 4: Wire React hook**

Create `application/state/useAssetActionBridge.ts` using the same pattern as `useVaultAgentBridge`: keep refs for current input and register a renderer handler that calls `handleAssetActionOp`.

In `App.tsx`, add:

```ts
useAssetActionBridge({
  hosts,
  sessions,
  resolveEffectiveHost,
  openHost: (hostId) => {
    const host = hosts.find((entry) => entry.id === hostId);
    if (!host) return;
    setDeepLinkHostDraft(host);
    setNavigateToSection('hosts');
    setActiveTabId('vault');
  },
  connectHost: handleConnectToHost,
  closeSession: (sessionId) => {
    closeSession(sessionId);
    return true;
  },
  focusSession: (sessionId) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (session?.workspaceId) {
      setActiveTabId(session.workspaceId);
      setWorkspaceFocusedSession(session.workspaceId, sessionId);
      return;
    }
    setActiveTabId(sessionId);
  },
});
```

- [ ] **Step 5: Add Electron bridge**

Create `electron/bridges/aiBridge/assetActionBridge.cjs` by copying the request/response pattern from `vaultAgentBridge.cjs`, with channel names:

- `netcatty:ai:asset-action:request`
- `netcatty:ai:asset-action:response`

Export `createAssetActionBridge` and `ASSET_ACTION_TIMEOUT_MS`.

Register it from `electron/bridges/aiBridge.cjs` beside the vault bridge and pass `invokeAssetAction` into capability dispatch dependencies.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test -- infrastructure/ai/assetActionBridgeClient.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit phase 4**

Run:

```bash
git add infrastructure/ai/assetActionBridgeClient.ts infrastructure/ai/assetActionBridgeClient.test.ts application/state/useAssetActionBridge.ts App.tsx electron/bridges/aiBridge/assetActionBridge.cjs electron/bridges/aiBridge.cjs
git commit -m "feat: add asset session action bridge"
```

- [ ] **Step 8: Review phase 4**

Review checks:

- Session side effects are routed through the new action bridge.
- Disconnect by host refuses ambiguous matches.
- Connect only supports SSH host assets in this phase.
- Results remain redacted.

---

## Task 5: Capability Catalog, RPC, MCP, And Generated Tool Specs

**Files:**
- Create: `electron/capabilities/catalog/asset.cjs`
- Modify: `electron/capabilities/catalog/index.cjs`
- Modify: `electron/capabilities/schemas/toolInputs.cjs`
- Modify: `electron/capabilities/services/vaultService.cjs`
- Create: `electron/capabilities/services/assetSessionService.cjs`
- Modify: `electron/bridges/mcpServerBridge/capabilityRpcDispatch.cjs`
- Modify: `electron/capabilities/catalog/integrity.test.cjs`
- Modify: `electron/bridges/mcpServerBridge/capabilityRpcDispatch.test.cjs`
- Modify generated files by running `npm run generate:capability-tools`

- [ ] **Step 1: Write failing catalog and dispatch tests**

Add tests:

```js
test("asset capabilities are exposed on global and public surfaces", () => {
  const { getCapabilityById } = require("../registry.cjs");
  assert.equal(getCapabilityById("asset.list").surfaces.global.rpcMethod, "asset/list");
  assert.equal(getCapabilityById("asset.connect").surfaces.public.mcpTool, "asset_connect");
});

test("dispatch routes asset add to vault service", async () => {
  let invokedOp;
  const dispatch = createCapabilityRpcDispatcher({
    invokeVaultAgent: async (op) => { invokedOp = op; return { ok: true }; },
    invokeAssetAction: async () => ({ ok: true }),
    permissionMode: "auto",
    permissionGrantsSnapshot: [],
    evaluatePermissionWithGrants: () => ({ allowed: true, requiresApproval: false }),
    isChatSessionCancelled: () => false,
    requestApprovalFromRenderer: async () => true,
    USER_DENIED_MESSAGE: "denied",
  });
  await dispatch("asset/add", { hosts: "[]" });
  assert.equal(invokedOp, "asset.add");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- electron/capabilities/catalog/integrity.test.cjs electron/bridges/mcpServerBridge/capabilityRpcDispatch.test.cjs electron/capabilities/adapters/mcpAdapter.test.cjs
```

Expected: FAIL until catalog and dispatch are added.

- [ ] **Step 3: Add asset catalog**

Create `electron/capabilities/catalog/asset.cjs` with nine implemented capabilities:

- `asset.list`: read, sensitiveRead true, bypassesApproval true, surfaces global `asset/list`, public `public/asset/list`, MCP `asset_list`
- `asset.get`: read, sensitiveRead true, input `hostId`
- `asset.add`: write, surfaces global/public, MCP `asset_add`
- `asset.edit`: write, input `hostId` plus `patch` string JSON
- `asset.remove`: write, input `hostId`
- `asset.open`: write, input `hostId`
- `asset.connect`: write, input `hostId`
- `asset.disconnect`: write, input `sessionId` optional and `hostId` optional
- `asset.reconnect`: write, input `sessionId`

Every write capability uses:

```js
policy: {
  write: true,
  sensitiveRead: false,
  longRunning: false,
  requiresChatSession: false,
  bypassesObserverBlock: false,
  bypassesApproval: false,
  bypassesChatCancel: false,
}
```

- [ ] **Step 4: Add schemas**

Add matching entries to `TOOL_INPUT_FIELDS` in `electron/capabilities/schemas/toolInputs.cjs`.

Descriptions for secret-bearing tools must say:

```js
"Raw credential fields are accepted only when Netcatty can mask approval, history, and export displays; otherwise use identityId or identityFileId."
```

- [ ] **Step 5: Add services and dispatch bindings**

In `vaultService.cjs`, add:

- `listAssets`
- `getAsset`
- `addAsset`
- `editAsset`
- `removeAsset`

They invoke renderer ops `asset.list`, `asset.get`, `asset.add`, `asset.edit`, `asset.remove`.

Create `assetSessionService.cjs` with:

- `open`
- `connect`
- `disconnect`
- `reconnect`

Each calls `invokeAssetAction(op, params)`.

In `capabilityRpcDispatch.cjs`, add bindings:

```js
"asset.list": { domain: "vault", method: "listAssets" },
"asset.get": { domain: "vault", method: "getAsset" },
"asset.add": { domain: "vault", method: "addAsset" },
"asset.edit": { domain: "vault", method: "editAsset" },
"asset.remove": { domain: "vault", method: "removeAsset" },
"asset.open": { domain: "assetSession", method: "open" },
"asset.connect": { domain: "assetSession", method: "connect" },
"asset.disconnect": { domain: "assetSession", method: "disconnect" },
"asset.reconnect": { domain: "assetSession", method: "reconnect" },
```

- [ ] **Step 6: Generate tool specs**

Run:

```bash
npm run generate:capability-tools
```

Expected: generated Catty/global tool specs include `asset_*` tools.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test -- electron/capabilities/catalog/integrity.test.cjs electron/capabilities/registry.test.cjs electron/capabilities/codegen/toolSurfaces.test.cjs electron/capabilities/adapters/mcpAdapter.test.cjs electron/bridges/mcpServerBridge/capabilityRpcDispatch.test.cjs
```

Expected: PASS.

- [ ] **Step 8: Commit phase 5**

Run:

```bash
git add electron/capabilities electron/bridges/mcpServerBridge infrastructure/ai/harness/generated
git commit -m "feat: expose asset capabilities"
```

- [ ] **Step 9: Review phase 5**

Review checks:

- All `asset.*` write operations require confirm approval and observer blocks them.
- Public MCP has no broader fields than internal agent surfaces.
- Generated specs are in sync.

---

## Task 6: Final Verification And Branch Review

**Files:**
- No expected source edits unless tests expose a defect.

- [ ] **Step 1: Run focused asset and capability test suite**

Run:

```bash
npm test -- domain/agentAsset.test.ts infrastructure/ai/vaultAgentBridgeClient.test.ts infrastructure/ai/assetActionBridgeClient.test.ts components/ai/PublicMcpApprovalPanel.test.tsx components/ai/ChatMessageList.test.tsx components/ai/toolArtifacts/formatVaultToolTooltip.test.ts electron/capabilities/catalog/integrity.test.cjs electron/capabilities/registry.test.cjs electron/capabilities/codegen/toolSurfaces.test.cjs electron/capabilities/adapters/mcpAdapter.test.cjs electron/bridges/mcpServerBridge/capabilityRpcDispatch.test.cjs
```

Expected: PASS.

- [ ] **Step 2: Run codegen drift check**

Run:

```bash
npm run generate:capability-tools
git diff --exit-code infrastructure/ai/harness/generated
```

Expected: no diff.

- [ ] **Step 3: Run typecheck and record status**

Run:

```bash
npm run typecheck -- --pretty false
```

Expected: May fail due to known upstream type errors. If it fails, record the first upstream failure and do not claim full typecheck passes.

- [ ] **Step 4: Run final review**

Review checks:

- Objective coverage: add/remove/edit server assets, asset info protected, open UI page, SSH connect, close SSH connection, reconnect.
- Security: no serialized focused test result contains representative secrets.
- Policy: observer blocks all writes/session side effects; confirm requests approval.
- Public MCP: asset tools are present and redacted.

- [ ] **Step 5: Commit any verification fixes**

If Step 1 or Step 2 required fixes, commit them:

```bash
git add <fixed-files>
git commit -m "test: cover asset management safety"
```

---

## Plan Self-Review

- Spec coverage:
  - Asset is Vault `Host`: Tasks 1, 2, and 5.
  - Add/edit/remove: Task 2 and Task 5.
  - Open/connect/disconnect/reconnect: Task 4 and Task 5.
  - Secret protection: Task 1 and Task 3.
  - Confirm/observer policy: Task 5 and Task 6.
  - Public MCP and generated tools: Task 5.
  - Per-phase commits and review: commit/review step in each task.

- Completeness scan:
  - No incomplete-marker or intentionally vague implementation notes are present.
  - Test commands and expected outcomes are listed for each phase.

- Type consistency:
  - Canonical capability IDs use `asset.*`.
  - Tool names use `asset_*`.
  - Renderer ops use `asset.add`, `asset.edit`, `asset.remove`, `asset.open`, `asset.connect`, `asset.disconnect`, and `asset.reconnect`.
  - Redacted output uses `RedactedAgentHost`, `hasNotes`, and `notesLength`; raw `Host.notes` is excluded.
