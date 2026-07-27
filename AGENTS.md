# Agents Overview

This project is wired around three layers: domain (pure logic), application state (React hooks orchestrating the domain), and UI (components). Use this document as a quick guide for extending or reusing the codebase.

## Current Agents (Roles)
- **Domain** (`domain/`): Models and pure helpers. Examples:
  - `models.ts` defines Host/SSHKey/Snippet/Workspace entities.
  - `agentActivity.ts` defines persisted agent activity and token usage records.
  - `host.ts` handles distro normalization and host sanitization.
  - `workspace.ts` contains workspace tree operations (split/insert/prune/sizing).
- **Application State** (`application/state/`): Hooks that own state and persistence boundaries.
  - `useSettingsState` handles theme, accent color, terminal themes, sync config (localStorage).
  - `useVaultState` owns hosts/keys/snippets/custom groups and import/export, persisting to storage.
  - `useSessionState` owns terminal sessions, workspace lifecycle, drag/split logic.
- **Infrastructure** (`infrastructure/`): External edges and configuration.
  - `config/` holds defaults, storage keys, terminal themes.
  - `persistence/localStorageAdapter.ts` abstracts localStorage read/write.
  - `services/` contains networked services (Gemini AI, GitHub Gist sync).
- **UI** (`components/`, `App.tsx`): Presentation; depends on hooks and domain helpers only.

## How Things Talk
- UI calls application hooks -> hooks call domain helpers -> persistence/config via infrastructure adapters.
- `App.tsx` wires hooks to components; no business logic should live in components beyond view glue.
- Local storage keys are centralized in `infrastructure/config/storageKeys.ts`; avoid ad-hoc `localStorage` calls elsewhere.

## AI Agent Harness (`infrastructure/ai/harness/`)

Turn orchestration is centralized in **AgentRuntime**; the React hook `useAIChatStreaming` only manages UI state and delegates `runTurn` / `stopTurn`.

| Layer | Module | Role |
|-------|--------|------|
| Runtime | `agentRuntime.ts`, `globalAgentRuntime.ts` | Turn lifecycle, trace fan-out, per-turn ToolOutputStore / ToolResultDedup |
| Drivers | `turnDrivers/cattyTurnDriver.ts`, `turnDrivers/externalSdkTurnDriver.ts` | Catty `streamText` + External SDK IPC; emit unified `AgentEvent`s |
| Context | `contextManager.ts`, `contextBudget.ts`, `tokenEstimator.ts`, `sessionState.ts`, `staleContextPruner.ts`, `compactionPruner.ts`, `cattyRuntime.ts` | Pre-turn / step / 413 compaction, dynamic thresholds, SessionState reinjection, stale tool pruning |
| Tools | `capabilityTools.ts`, `toolOutputStore.ts`, `toolResultDedup.ts` | Catalog tools, truncated output handles (`tool_output_read`), duplicate-read notices |
| Trace | `traceStore.ts`, `agentEventAdapter.ts` | Session event log incl. `usage`, `performance`, and `CompactionTrace` |

External SDK turns normalize file changes, web searches, plan updates, recoverable warnings, and token usage into the shared event protocol. These activity and usage records are stored on assistant messages so the compact activity view is restored with chat history.

**Stop** always goes through `stopAgentTurn()` (UI, `/stop`, MCP). Do not add parallel abort paths in hooks.

### Codex App Server (experimental)

Codex can opt into a persistent `codex app-server --stdio` runtime under
`electron/bridges/aiBridge/codexAppServer/`; the existing TypeScript SDK remains
the default. The main process owns JSONL RPC correlation, thread/turn routing,
native approvals, `request_user_input`, model discovery, and process cleanup.

- Session identities include the Codex runtime; SDK and App Server threads must
  never resume across runtimes.
- Observer maps to `read-only + never`, Confirm to `read-only + on-request`, and
  Auto to `danger-full-access + never`.
- App Server native “allow for session” decisions are session-scoped Codex
  grants and must not become persistent Netcatty permission grants.
- `turn/completed` is the terminal lifecycle event. Retryable `error`
  notifications are warnings; process exit is fatal.
- Regenerate the committed protocol contract with
  `npm run generate:codex-app-server-schema` after upgrading Codex, and verify it
  with `npm run check:codex-app-server-schema`.

### AI SDK v7 (Catty path)

Catty sidebar turns use **Vercel AI SDK 7** via `streamText` in `turnDrivers/cattyStreamProcessor.ts`. Key conventions:

| Concern | Module | Notes |
|---------|--------|-------|
| `runtimeContext` | `cattyRuntimeContext.ts` | Per-turn orchestration state (`chatSessionId`, `turnId`, `agentKind`, `permissionMode`, scope, `lastCompaction`). Passed to `prepareStep` and lifecycle callbacks. **Does not replace** pre-turn compaction or 413 handling. |
| `toolsContext` | `capabilityTools.ts` | Per-tool keyed context (`bridge`, `getExecutorContext`, `toolOutputStore`, …). Tools read deps from `{ context }` in `execute`, not closure capture. |
| `toolApproval` | `cattyToolApproval.ts` | Write-tool gating for Catty `streamText` only. Calls `requestApproval()` in confirm mode; observer auto-denies writes. **External MCP agents** still approve via main-process `mcpServerBridge` → `setupMcpApprovalBridge()` — unchanged. |
| `timeout` | `streamTimeouts.ts` | `totalMs` / `stepMs` / `chunkMs` / `toolMs` on `streamText`; compaction `generateText` uses a shorter 90s timeout. |
| Lifecycle | `cattyStreamProcessor.ts` | `onStart` → `model_call_start`; `onStepEnd` → per-step `step_end` usage; `onEnd` → turn-total `usage`; `finalStep.performance` → `performance` event. Distinct from `AgentRuntime` turn_start/turn_end. |

Compaction remains **`prepareTurnContext` / `compactCattyMessages`** (pre-turn + 413-retry). Step-level pruning is **`prepareStepContext`** only (typed compression + handle notices, no LLM summarize).

### Google Antigravity Integration (Local Harness)

Netcatty supports delegating AI capabilities to the local Google Antigravity binary (`localharness`). When the user selects Google as their provider, the `antigravityTurnDriver.ts` bridges the Netcatty UI to the Antigravity agent via WebSocket.

**Authentication Rules:**
1. **API Key (Gemini API):** If an API key is provided in the Netcatty settings, the driver populates `gemini_api_endpoint` in the `config` payload, allowing standard Gemini API usage.
2. **Account Auth / Application Default Credentials (ADC):** If NO API key is provided, the driver configures `vertex_endpoint` instead. This triggers the Google Cloud SDK inside the `localharness` to look for local ADC credentials (e.g. established via `gcloud auth application-default login`). If ADC is missing on the machine, the binary will cleanly report `failed to find default credentials` back to the UI.

**Important details:**
- The Go binary strictly requires `cascade_id` to match `[a-zA-Z0-9-]`. Since Netcatty's session IDs include underscores (`_`), the TurnDriver replaces them with hyphens (`-`).
- The protocol's JSON keys must be camelCase (e.g., `textDelta` instead of `text_delta`) for the Go unmarshaler to accept them.

### Capability exposure (Round 2 + gap fill)

Single source of truth: `electron/capabilities/catalog/` + `electron/capabilities/codegen/toolSurfaces.cjs`.

**Agent kinds** (where an in-app agent runs — orthogonal to MCP/CLI/RPC surfaces):

| Kind | UI | Tool list | Notes |
|------|-----|-----------|--------|
| `sidebar` | Chat side panel (Catty) | `listAgentToolSpecs('sidebar')` → `cattyToolSpecs.json` | Includes `harness.*` renderer-local tools (`surfaces.catty`) |
| `global` | Future app-wide agent | `listAgentToolSpecs('global')` → `globalAgentToolSpecs.json` | Shared RPC tools (terminal, SFTP, vault, …); **no** sidebar-only harness tools unless opted in |

Placement rules (`resolveAgentKinds` in `toolSurfaces.cjs`):

- Explicit `agentKinds` on a catalog entry overrides inference.
- `surfaces.globalAgent` only → global agent (future global-only local tools).
- `surfaces.catty` only (harness) → sidebar only.
- RPC/MCP-backed tools → both agents unless restricted via `agentKinds`.

| Surface | Codegen / consumer | Notes |
|---------|-------------------|--------|
| Catty (sidebar) tools | `npm run generate:capability-tools` → `infrastructure/ai/harness/generated/cattyToolSpecs.json` | Sidebar agent tool set. CI verifies JSON drift. |
| Global agent tools | same script → `globalAgentToolSpecs.json` | Prepared for future global agent runtime; shared RPC tools only today. |
| MCP stdio | `electron/capabilities/codegen/mcpToolRegistry.cjs` → `electron/mcp/netcatty-mcp-server.cjs` | Registry-driven; external agents. Harness tools are **not** on MCP. |
| CLI | `electron/cli/netcatty-tool-cli.cjs` + `electron/capabilities/adapters/cliAdapter.cjs` | **30** catalog commands; exec/sftp/session remain special-case; vault/portforward/snippets use catalog fallback dispatch |
| RPC dispatch | `electron/bridges/mcpServerBridge.cjs` + `capabilityRpcDispatch.cjs` | `netcatty/*` builtin handlers via `buildBuiltinRpcHandlerRegistry` (catalog-aligned); `public/*`, `vault/*`, `portforward/*` → services |
| Vault bridge | `electron/bridges/aiBridge/vaultAgentBridge.cjs` + `infrastructure/ai/vaultAgentBridgeClient.ts` | Renderer vault state; **never** returns password/privateKey |
| AI context | `buildAITerminalSessionInfo` + `useTerminalAiContexts` | Per-session `hostChain` + `activePortForwards`; mirrored in `getContext` and Catty system prompt |

**Policy:** SFTP writes/transfers, `portforward_start`, and `host_notes_set` require confirm-mode approval. Observer mode blocks writes.

**Handles:** `ToolOutputStore` persists across turns per chat session; cleared on chat session delete. Large `sftp.read` results spill to `tool_output_read`.

**Harness domain (`catalog/harness.cjs`):** Catty-only surface (`surfaces.catty.toolName`). Registered in the capability catalog but executed locally in `capabilityTools.executeLocalCattyCapability` (not MCP/CLI). `harness.web.search` is omitted when web search is not configured.

## Plugin host runtime (internal preview)

The phase-2 plugin host lives under `electron/plugins/` and is disabled unless
`NETCATTY_PLUGIN_DEV=1` is present at application launch. Public wire and package
types still come only from `packages/plugin-contract/schema/`; do not add a
second private RPC shape when extending the host.

- `PackageStore` validates an immutable `.ncpkg` snapshot, extracts only into
  private staging, and atomically publishes an installed version.
- `PluginManager` serializes install, enable/disable, restart and uninstall
  mutations. Do not bypass it from renderer IPC.
- Ordinary plugins run in a sandboxed, offline `BrowserWindow` session and can
  reach only their runtime-scoped `netcatty-plugin://` authority.
- Node-only plugins run in a dedicated `utilityProcess`; they remain an advanced
  development-only path until permission and distribution phases land.
- `PluginRpcRouter` owns correlation, cancellation, deadlines, stream credit and
  protocol-failure containment. Runtime identity is assigned by the host and is
  never accepted from request parameters.
- App quit goes through `runPluginShutdown()` after the dirty-editor guard; do
  not add another independent quit interception path.

Run `npm run test:plugin-runtime` for main-process boundaries and
`npm run test:plugin-runtime:electron` for real BrowserWindow/utilityProcess
smoke coverage. Packaged-resource changes must also pass `npm run pack:dir`.

## Extending the System
1) **New domain logic**: Add pure functions/types under `domain/`; avoid side effects.  
2) **New stateful behavior**: Wrap it in a hook under `application/state/`; keep external I/O behind adapters.  
3) **New integrations**: Create adapters under `infrastructure/services/` (or `persistence/`); expose typed functions.  
4) **UI changes**: Consume hook outputs/handlers; do not bypass state hooks for persistence or domain logic.

## Data & Storage
- Persisted keys: see `storageKeys.ts`. Use `localStorageAdapter` for all reads/writes.
- Seed data: `config/defaultData.ts`; terminal themes: `config/terminalThemes.ts`.
- **Temporary files**: All temporary files (e.g., SFTP downloaded files for external editing) must be written to Netcatty's dedicated temp directory via `tempDirBridge.getTempFilePath(fileName)`. Do not write directly to `os.tmpdir()`. This ensures proper cleanup and user visibility in Settings > System.

## Testing & Safety
- Favor unit tests for domain helpers (e.g., `workspace.ts`, `host.ts`) and hook-level tests for application state.
- When changing storage keys or schema, provide migration or backward-compat handling.
- Keep components dumb: if a prop list grows large, consider deriving a smaller view model in the hook.

## Coding Conventions
- Keep logic pure in domain; side effects belong to application/infrastructure layers.
- Prefer composition over deep prop drilling; lift shared state into hooks.
- Avoid direct network/fetch in components; add a service/adaptor first.
- Maintain ASCII-only unless required by existing file content.

## Reporting Issues & PRs

Issues opened without the required format are **auto-closed** by the issue-format bot. Agents that file issues via `gh` or the API must still follow these rules:

- **Title:** start with `[Bug]`, `[Feature]`, or `[Other]`, then a short summary (≥ 4 characters after the prefix). Example: `[Bug] SFTP upload fails on Windows`.
- **Body:** use the templates under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) (Bug Report or Feature Request) and fill every required field. Blank issues are disabled.
- **PRs:** follow [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

Full contributor guidance (setup, commits, PR process): [CONTRIBUTING.md](./CONTRIBUTING.md).

## Review Boundaries
- Treat `electron/cli/*`, `netcatty-tool-cli`, the CLI discovery file, and the local TCP bridge as internal Netcatty integration surfaces unless a task explicitly says otherwise.
- Do not review those surfaces as public APIs by default, and do not assume they must support third-party callers, manual launches, or non-Netcatty agents.
- On supported first-party paths, assume Netcatty's own launcher provides required integration environment such as `NETCATTY_TOOL_CLI_DISCOVERY_FILE`.
- If a review concern depends on external exposure, third-party compatibility, or public API stability, call it out as out of scope unless the task explicitly includes that contract.

---

## Aside Panel Design System

VaultView subpages (Hosts, Keychain, Port Forwarding, Snippets, Known Hosts) share a unified aside panel design system via reusable components in `components/ui/aside-panel.tsx`.

### Core Components

Import from `./ui/aside-panel`:
```tsx
import {
  AsidePanel,
  AsidePanelHeader,
  AsidePanelContent,
  AsidePanelFooter,
  AsideActionMenu,
  AsideActionMenuItem
} from "./ui/aside-panel";
```

### Basic Usage
```tsx
<AsidePanel
  open={isOpen}
  onClose={handleClose}
  title="Panel Title"
  subtitle="Optional subtitle"
  // For sub-panels with back navigation:
  showBackButton={true}
  onBack={handleBack}
  // Optional action menu:
  actions={
    <AsideActionMenu>
      <AsideActionMenuItem onClick={handleDuplicate}>
        <Copy size={14} className="mr-2" /> Duplicate
      </AsideActionMenuItem>
      <AsideActionMenuItem variant="destructive" onClick={handleDelete}>
        <Trash2 size={14} className="mr-2" /> Delete
      </AsideActionMenuItem>
    </AsideActionMenu>
  }
>
  <AsidePanelContent>
    {/* Your scrollable content here */}
  </AsidePanelContent>
  <AsidePanelFooter>
    <Button className="w-full">Save</Button>
  </AsidePanelFooter>
</AsidePanel>
```

Note: When `title` prop is provided, AsidePanel automatically renders the header. Do NOT use `AsidePanelHeader` directly inside AsidePanel - this would cause duplicate headers.

### Component Props

**AsidePanel**
- `open: boolean` - Controls panel visibility
- `onClose: () => void` - Close button handler
- `title?: string` - Header title (header only renders if title is provided)
- `subtitle?: string` - Secondary text below title
- `showBackButton?: boolean` - Show back arrow (for sub-panels)
- `onBack?: () => void` - Back button handler
- `actions?: ReactNode` - Right-side actions (buttons or AsideActionMenu)
- `width?: string` - Panel width (default: "w-[380px]")
- `children: ReactNode` - Panel content

**AsidePanelContent**
- `children: ReactNode` - Content wrapped in ScrollArea with `space-y-4` gap
- `className?: string` - Additional CSS classes

**AsidePanelFooter**
- `children: ReactNode` - Footer content (usually buttons)
- `className?: string` - Additional CSS classes

**AsideActionMenu / AsideActionMenuItem**
- Popover-based dropdown menu for header actions
- `variant="destructive"` for delete actions (red text)

### Design Specifications
- Position: `absolute right-0 top-0 bottom-0` (relative to parent container with `relative` positioning)
- Width: `w-[380px]` (configurable via `width` prop)
- Background: `bg-background` (solid, no backdrop-blur)
- Border: `border-l border-border/60`
- Z-index: `z-30`
- Header: `shrink-0` to prevent scrolling, close button uses X icon
- Content: `flex-1 overflow-hidden` with internal ScrollArea and `space-y-4` gap
- **Important**: Parent container must have `relative` positioning for the panel to position correctly

### Panel Navigation Patterns
- **Main panels**: Close with X icon, no back button
- **Sub-panels (stacked)**: ArrowLeft (←) back button + X close button
- Use panel stack state for nested navigation: `panelStack: PanelMode[]`
- `popPanel()` returns to previous panel, `closePanel()` closes all panels

### SelectHostPanel Integration
For host selection, use `SelectHostPanel` component with:
- Breadcrumb navigation in content area (not header)
- `multiSelect` prop for multiple host selection
- `selectedHostIds` array for controlled selection
- Sort dropdown and tag filter for large host lists
- Uses `absolute` positioning (not `fixed`) - parent needs `relative`

### Migration from Manual Implementation
Replace manual panel structure:
```tsx
// OLD: Manual implementation
<div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-background z-50 flex flex-col">
  <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag shrink-0">
    {/* header content */}
  </div>
  <ScrollArea className="flex-1">
    <div className="p-4 space-y-4">{/* content */}</div>
  </ScrollArea>
</div>

// NEW: Using AsidePanel components (header via props)
<AsidePanel open={open} onClose={onClose} title="Title">
  <AsidePanelContent>{/* content */}</AsidePanelContent>
</AsidePanel>
```

### Important Positioning Notes
- AsidePanel uses `absolute` positioning with `top-0 bottom-0 right-0`
- The panel positions relative to its nearest positioned ancestor
- For correct alignment with the top of the page:
  - Render AsidePanel at the root level of your section (e.g., VaultView root div)
  - Do NOT render AsidePanel inside a scrollable content area or nested containers
  - The parent container should be `absolute inset-0` or have `relative` positioning
