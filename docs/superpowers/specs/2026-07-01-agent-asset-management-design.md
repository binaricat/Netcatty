# Agent Asset Management Design

## Summary

Agent asset management lets Netcatty agents manage saved server assets without creating a separate asset model. A server asset is the existing Vault `Host` entity. The feature exposes safe asset CRUD and connection lifecycle actions through the capability system, while preserving the current Vault UI, storage, and session architecture.

The first implementation should improve the existing Vault host agent surface rather than add a new page. Existing manual add, edit, delete, and connect workflows remain owned by Vault. Agents receive redacted host metadata, can request approved writes, and can ask Netcatty to open, connect, disconnect, or reconnect hosts without receiving credentials.

## Goals

- Treat saved server assets as existing Vault hosts.
- Support agent add, edit, remove, list, and get operations for saved hosts.
- Support agent open, connect, disconnect, and reconnect operations for SSH sessions.
- Keep credentials and key material out of all agent-visible outputs, logs, errors, tool artifacts, and generated tool specs.
- Reuse `useVaultState`, existing host creation helpers, secure field persistence, and Vault UI behavior.
- Route all agent-facing operations through the capability catalog and existing policy checks.
- Require approval in confirm mode for writes and session side effects.
- Block writes and session side effects in observer mode.
- Build the work in small phases, with a focused commit and agent review after each phase.

## Non-Goals

- Do not create a separate asset database, storage key, or migration path.
- Do not create a new top-level Assets page.
- Do not expose raw `password`, `telnetPassword`, `privateKey`, `passphrase`, or derived secret values to any agent surface.
- Do not make public MCP a credential export mechanism.
- Do not bypass existing host details UI, Vault ordering, secure persistence, or confirmation policy.
- Do not expand this phase to arbitrary remote inventory discovery.
- Do not support local terminal, telnet, serial, Mosh, or EternalTerminal lifecycle actions as "server assets" in this phase.

## Existing Code Context

The current codebase already has most of the storage and safety boundaries needed for this feature:

- `domain/models.ts` exports `Host` and related Vault types.
- `domain/host.ts`, `domain/vaultHostCreate.ts`, and import helpers already normalize and create hosts from drafts.
- `application/state/useVaultState.ts` owns hosts, keys, snippets, identities, groups, import/export, and persistence.
- `components/HostDetailsPanel.tsx`, `components/VaultView.tsx`, and Vault list components already provide manual host add, edit, delete, and connect workflows.
- `infrastructure/ai/vaultAgentBridgeClient.ts` already has renderer-side Vault agent operations for host get, host list, host create, host import, and host notes.
- `electron/bridges/aiBridge/vaultAgentBridge.cjs` forwards main-process requests into renderer Vault state without sending credentials back.
- `electron/capabilities/catalog/vault.cjs`, `electron/capabilities/services/vaultService.cjs`, and `electron/bridges/mcpServerBridge/capabilityRpcDispatch.cjs` already expose catalog-driven Vault operations to agent surfaces.
- `electron/capabilities/policy.cjs` already centralizes observer and confirm-mode policy.

The current host agent read path has a sanitizer in `vaultAgentBridgeClient.ts`. This work should move or duplicate that behavior only where necessary to make redaction reusable, testable, and enforced across new asset operations.

## Asset Model

An asset is a Vault host. The agent-facing name can be `asset` where it improves clarity, but implementation should map directly to `Host` and existing Vault operations.

Agent-visible asset fields:

- `id`
- `label`
- `hostname`
- `port`
- `username`
- `protocol`
- `group`
- `tags`
- `hasNotes`
- `notesLength`
- `os`
- `authMethod`
- `hasPassword`
- `hasKey`
- `connectScriptIds`
- `loginScriptId`
- creation and update metadata that already exists on `Host`

Secret fields that must never appear in agent-visible output:

- `password`
- `telnetPassword`
- `privateKey`
- `passphrase`
- any future field marked as a secret credential

The redacted shape should expose presence booleans such as `hasPassword` and `hasKey` so agents can reason about whether a host is connectable without seeing secrets. It should expose only note metadata such as `hasNotes` and `notesLength`; `Host.notes` content is freeform user-authored text and is not part of `RedactedAgentHost`.

## Capability Contract

### Read Operations

`asset.list` and `asset.get` return an explicit `RedactedAgentHost` shape. They are read operations and should be available in observer mode without approval. They are still sensitive metadata reads, so they must use the same explicit catalog policy style as existing Vault host reads.

Add canonical catalog IDs for the asset contract: `asset.list`, `asset.get`, `asset.add`, `asset.edit`, `asset.remove`, `asset.open`, `asset.connect`, `asset.disconnect`, and `asset.reconnect`. Existing `vault.host.list`, `vault.host.get`, `vault.hosts.create`, and `vault.host.import` behavior stays available for compatibility where it remains exposed, and routes to the same redacted host service where the semantics overlap. Compatibility operations must obey the same redaction, approval, and secret argument masking-or-reject contract as the new `asset.*` operations.

### Write Operations

`asset.add`, `asset.edit`, and `asset.remove` mutate Vault hosts through the renderer Vault bridge.

Rules:

- They require approval in confirm mode.
- They are denied in observer mode.
- They may accept secret input when creating or editing a host only if the tool-call argument path has a masking contract for approval payloads, tool cards, artifacts, trace storage, chat history replay, public MCP argument display, logs, and errors.
- They never echo secret input in success, preview, validation, or error responses.
- They write through existing Vault state and persistence paths.
- They preserve existing secure-field encryption and backward compatibility behavior.

`asset.add` can reuse `hosts.create` internals after the argument masking contract is in place. If that masking contract is not complete, `asset.add`, `asset.edit`, `vault.hosts.create`, `vault.host.import`, and any other overlapping compatibility operation must reject raw `password`, `telnetPassword`, `privateKey`, `passphrase`, and future secret credential input, and require a saved identity/key reference or manual UI credential entry. `asset.edit` should update one host by `hostId` using the same validation and sanitization rules as manual Host Details edits. `asset.remove` should delete by `hostId` and return a redacted summary of the removed host or a minimal `{ ok, hostId }` result.

### Session Operations

`asset.open`, `asset.connect`, `asset.disconnect`, and `asset.reconnect` are side-effecting operations.

Rules:

- They require approval in confirm mode.
- They are denied in observer mode.
- They accept `hostId` or `sessionId` as appropriate.
- They never expose credentials.
- They return redacted host and session summaries only.

`asset.open` means "navigate the app to the saved host or host details page" and does not establish a network connection by itself. It should use a renderer bridge action because navigation and panel state live in the app.

`asset.connect` means "start an SSH connection for this host" using the existing connection path. It should create or focus the resulting terminal session consistently with manual Vault host connect behavior.

`asset.disconnect` means "close the SSH session identified by `sessionId`". If a `hostId` is provided and multiple sessions exist, the operation should require a `sessionId` or return a disambiguation error with redacted session summaries.

`asset.reconnect` means "close and start a fresh SSH connection for the same host/session context" using existing reconnect behavior where possible. If the session has no resolvable Vault host, return a clear non-secret error.

## Data Flow

Read flow:

1. Agent tool call enters through Catty/global agent/public MCP surface.
2. Capability catalog resolves the tool to an RPC method.
3. Policy checks observer, confirm, chat cancellation, and surface rules.
4. Main-process capability dispatch calls `vaultService`.
5. `vaultService` invokes `VaultAgentBridge`.
6. Renderer `useVaultAgentBridge` and `vaultAgentBridgeClient` read `useVaultState`.
7. The renderer returns only redacted asset data.

Write flow:

1. Agent tool call enters through the capability surface.
2. Capability policy denies observer mode or requests confirm-mode approval.
3. Approved request reaches the Vault service.
4. Renderer bridge validates input and mutates `useVaultState`.
5. Existing persistence writes secure fields through the current adapter path.
6. Response contains only redacted assets or non-secret identifiers.

Session flow:

1. Agent asks to open, connect, disconnect, or reconnect.
2. Capability policy treats the operation as a write because it changes app or network state.
3. Main process routes to an asset/session service.
4. Renderer handles UI navigation for `asset.open`.
5. Existing terminal and SSH session orchestration handles connect, close, and reconnect.
6. Response contains redacted host/session metadata.

## Security Requirements

- Add a central redaction helper such as `redactHostForAgent(host)` in a shared domain or AI-safe domain module.
- Redaction must return an explicit allowlisted `RedactedAgentHost` object. Do not use object spreading, pass-through copies, or denylist-only filtering for agent-visible host data.
- Nested host fields are omitted unless this design or a separate approved design explicitly allowlists their safe shape.
- Redaction must compute credential presence booleans such as `hasPassword` and `hasKey` without returning credential values, identity file paths, key material, proxy secrets, environment values, startup commands, `Host.notes` content, or future unreviewed fields.
- Tests must assert that `JSON.stringify(result)` does not contain representative password, telnet password, key, passphrase, or secret-like note values.
- Tests must also assert that masked tool arguments, approval summaries, tool cards, artifacts, trace entries, chat history replay data, public MCP argument display data, logs, and thrown errors do not include representative password, telnet password, key, and passphrase values for both `asset.*` tools and overlapping compatibility tools such as `vault.hosts.create` and `vault.host.import`.
- Tool outputs, tool inputs shown to users, artifacts, toast messages, logs, thrown errors, approval summaries, and persisted agent traces must not include raw credentials.
- `Host.notes` content must be treated as sensitive freeform text. It is omitted from `asset.list` and `asset.get` by default. Existing host notes tools remain separate sensitive-read tools and must not be folded into `RedactedAgentHost`.
- Validation errors should name invalid fields without echoing secret values.
- Public MCP must not expose any extra host fields compared with internal agent surfaces.
- `asset.edit` must prevent accidental secret removal unless the input explicitly requests clearing a credential field.
- `asset.remove` deletes the host and therefore deletes embedded `Host.notes` with that host. It must not remove related SSH keys, identities, snippets, Vault Notes sidebar entries, or port-forward rules unless a separate approved design explicitly adds cascade behavior.
- `asset.disconnect` and `asset.reconnect` must validate that the target session belongs to the requested host when both are provided.

## UI and Navigation

No new Assets page is required.

Manual asset management remains in Vault Hosts. Agent-driven `asset.open` should focus the existing Vault host or details UI. If the Vault view is not active, Netcatty should navigate there and open the relevant host details panel using existing component patterns.

If UI state requires a small bridge addition, keep it in the application/UI layer and avoid putting view state into domain helpers. The domain layer should remain pure.

## Error Handling

Errors should be specific and non-secret:

- Missing host: `Host not found.`
- Missing session: `Session not found or already closed.`
- Ambiguous disconnect target: return matching redacted sessions and ask for `sessionId`.
- Observer denial: use existing observer-mode denial text.
- Approval denial: use existing approval-denied handling.
- Unsupported protocol: `Only SSH host assets are supported for connect operations.`
- Bridge unavailable: use the current Vault bridge unavailable pattern.

No error message should include a password, private key content, passphrase, or complete connection URL containing credentials.

## Testing Plan

Phase tests should be added near the code they protect:

- Domain or AI redaction tests for `redactHostForAgent`, including explicit allowlist behavior and nested field omission.
- Tool argument masking tests for secret-bearing asset add/edit calls and overlapping compatibility calls such as `vault.hosts.create` and `vault.host.import` across approval payloads, tool cards, artifacts, traces, history replay, public MCP display data, logs, and errors.
- `vaultAgentBridgeClient` tests for asset list, get, add, edit, remove, and secret non-leak assertions.
- Vault service and capability dispatch tests for routing and policy behavior.
- Capability catalog/codegen tests for generated Catty/global/public MCP surfaces.
- Session operation tests for connect, disconnect, reconnect, ambiguous host sessions, missing host, missing session, and protocol rejection.
- Public MCP adapter tests that verify asset tools return the same redacted shape as internal surfaces.

Existing focused MCP and capability tests should continue to pass after each phase. Full typecheck currently has unrelated upstream errors, so phase completion should report focused verification and avoid claiming full typecheck success until those upstream errors are addressed.

## Implementation Phases

1. Commit this design spec.
2. Add central redaction and input validation tests.
3. Add renderer Vault agent bridge support for asset add, edit, and remove.
4. Add session action bridge support for asset open, connect, disconnect, and reconnect.
5. Add capability catalog, RPC, MCP, generated tool specs, and policy coverage.
6. Run focused verification and request an agent review after each implementation commit.

Each phase should be committed separately. Each commit should have a review pass before moving to the next phase.

## High-Risk Review

The highest-risk area is secret leakage. The implementation must treat redaction and argument masking as contracts, not presentation details. Any helper that returns agent-visible hosts should call the same allowlist redaction function, and tests should check serialized output rather than individual fields only. If any agent surface cannot mask secret tool arguments end to end, asset add/edit and overlapping compatibility operations must reject raw secret fields on that surface. Freeform `Host.notes` content is not part of the redacted host shape because users may paste credentials or private operational details there.

The second-highest-risk area is policy bypass. New asset operations must enter through the capability catalog so observer and confirm-mode behavior is inherited. Direct ad hoc IPC from an agent surface to renderer mutation should be avoided.

The third-highest-risk area is session ownership. Disconnect and reconnect operations must not close the wrong session when multiple sessions share a host. Prefer `sessionId` for destructive session operations and require disambiguation when a `hostId` maps to multiple live sessions.

The fourth-highest-risk area is accidental data loss. `asset.edit` should patch only provided fields, and secret clearing should be explicit. `asset.remove` should remove the host only, including its embedded `Host.notes`, while leaving linked entities untouched unless a separate approved design specifies cascade behavior.

## Acceptance Criteria

- Agents can list and get saved server assets as redacted Vault hosts.
- Agents can add, edit, and remove saved server assets through approved capability calls.
- Agents can open a saved host in the UI, connect it over SSH, close an SSH session, and reconnect.
- Observer mode blocks asset writes and session side effects.
- Confirm mode requests approval for asset writes and session side effects.
- No agent-visible result, artifact, error, or log contains secret host values.
- Existing manual Vault host workflows continue to work.
- Generated capability surfaces are in sync.
- Focused tests for redaction, bridge behavior, policy, and session actions pass.
