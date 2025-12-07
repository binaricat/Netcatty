# Agents Overview

This project is wired around three layers: domain (pure logic), application state (React hooks orchestrating the domain), and UI (components). Use this document as a quick guide for extending or reusing the codebase.

## Current Agents (Roles)
- **Domain** (`domain/`): Models and pure helpers. Examples:
  - `models.ts` defines Host/SSHKey/Snippet/Workspace entities.
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
- UI calls application hooks → hooks call domain helpers → persistence/config via infrastructure adapters.
- `App.tsx` wires hooks to components; no business logic should live in components beyond view glue.
- Local storage keys are centralized in `infrastructure/config/storageKeys.ts`; avoid ad-hoc `localStorage` calls elsewhere.

## Extending the System
1) **New domain logic**: Add pure functions/types under `domain/`; avoid side effects.  
2) **New stateful behavior**: Wrap it in a hook under `application/state/`; keep external I/O behind adapters.  
3) **New integrations**: Create adapters under `infrastructure/services/` (or `persistence/`); expose typed functions.  
4) **UI changes**: Consume hook outputs/handlers; do not bypass state hooks for persistence or domain logic.

## Data & Storage
- Persisted keys: see `storageKeys.ts`. Use `localStorageAdapter` for all reads/writes.
- Seed data: `config/defaultData.ts`; terminal themes: `config/terminalThemes.ts`.

## Testing & Safety
- Favor unit tests for domain helpers (e.g., `workspace.ts`, `host.ts`) and hook-level tests for application state.
- When changing storage keys or schema, provide migration or backward-compat handling.
- Keep components dumb: if a prop list grows large, consider deriving a smaller view model in the hook.

## Coding Conventions
- Keep logic pure in domain; side effects belong to application/infrastructure layers.
- Prefer composition over deep prop drilling; lift shared state into hooks.
- Avoid direct network/fetch in components; add a service/adaptor first.
- Maintain ASCII-only unless required by existing file content.
