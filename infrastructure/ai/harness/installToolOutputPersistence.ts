import { getNetcattyBridge } from '../aiChatStreamingSupport';
import type {
  PersistedToolOutputRecord,
  ReadToolOutputInput,
  ToolOutputPersistence,
  ToolOutputStore,
} from './toolOutputStore';

type ToolOutputReadResult = Awaited<ReturnType<ToolOutputPersistence['read']>>;

/**
 * Narrowed view of the netcatty bridge methods used for tool-output
 * persistence. (PanelBridge's index signature returns `unknown`, so the
 * specific promises need their own interface.)
 */
interface ToolOutputTempBridge {
  getToolOutputPersistenceStatus?: () => Promise<{ durable: boolean; reason?: string }>;
  writeToolOutputTemp?: (
    record: PersistedToolOutputRecord,
    content: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  restoreToolOutputTemp?: (
    handleId: string,
    chatSessionId: string,
  ) => Promise<{ path: string; record: PersistedToolOutputRecord } | null>;
  readToolOutputTemp?: (
    path: string,
    request: ReadToolOutputInput,
  ) => Promise<Omit<ToolOutputReadResult, 'handleId' | 'storedChars' | 'sourceTruncated'> | null>;
  deleteToolOutputTemp?: (path: string) => Promise<{ ok: boolean }>;
  deleteChatToolOutputsTemp?: (chatSessionId: string) => Promise<{ deletedCount: number }>;
  deleteTerminalToolOutputsTemp?: (
    chatSessionId: string,
    terminalSessionId: string,
  ) => Promise<{ deletedCount: number }>;
  deleteTerminalToolOutputsEverywhereTemp?: (
    terminalSessionId: string,
  ) => Promise<{ deletedCount: number }>;
}

/**
 * Install the host-backed tool-output persistence onto `store` from the
 * netcatty bridge. `CattyTurnDriver` performs the same wiring at the start of
 * every Catty turn, but flows that move durable tool outputs before any turn
 * runs (undo branching an existing session right after an app restart) need
 * `restore`/`write` immediately so the alias pass can durably copy restored
 * handles under the branch id before the branch is published. Idempotent:
 * each call installs an equivalent closure; when the bridge does not expose
 * the tool output methods, persistence is explicitly cleared the same way the
 * driver does.
 *
 * Returns true when a persistence closure was installed (even one whose
 * `write`/`restore` reject while secure storage is reported non-durable), and
 * false when no store or no matching bridge methods are available.
 */
export async function installToolOutputPersistence(
  store: ToolOutputStore | undefined,
  bridge?: unknown,
): Promise<boolean> {
  if (!store) return false;
  const netcattyBridge = (
    (bridge ?? getNetcattyBridge()) as ToolOutputTempBridge | undefined
  );
  if (!netcattyBridge) return false;
  const setPersistence = (
    store as { setPersistence?: ToolOutputStore['setPersistence'] }
  ).setPersistence;
  if (!setPersistence) return false;
  const persistenceStatus = await netcattyBridge.getToolOutputPersistenceStatus?.()
    .catch((): { durable: boolean; reason?: string } => ({ durable: false }));
  if (
    netcattyBridge.writeToolOutputTemp
    && netcattyBridge.readToolOutputTemp
    && netcattyBridge.deleteToolOutputTemp
  ) {
    const persistence: ToolOutputPersistence = {
      write: async (record, content) => {
        if (!persistenceStatus?.durable) {
          throw new Error(persistenceStatus?.reason ?? 'Secure local storage is unavailable.');
        }
        const result = await netcattyBridge.writeToolOutputTemp!(record, content);
        if (!result.ok || !result.path) {
          throw new Error(result.error || 'Unable to persist tool output.');
        }
        return result.path;
      },
      restore: persistenceStatus?.durable && netcattyBridge.restoreToolOutputTemp
        ? (handleId, chatSessionId) => netcattyBridge.restoreToolOutputTemp!(handleId, chatSessionId)
        : undefined,
      read: (path, request) => netcattyBridge.readToolOutputTemp!(path, request),
      delete: async path => {
        await netcattyBridge.deleteToolOutputTemp!(path);
      },
      deleteSession: netcattyBridge.deleteChatToolOutputsTemp
        ? async chatSessionId => {
          await netcattyBridge.deleteChatToolOutputsTemp!(chatSessionId);
        }
        : undefined,
      deleteTerminalSession: netcattyBridge.deleteTerminalToolOutputsTemp
        ? async (chatSessionId, terminalSessionId) => {
          await netcattyBridge.deleteTerminalToolOutputsTemp!(chatSessionId, terminalSessionId);
        }
        : undefined,
      deleteTerminalEverywhere: netcattyBridge.deleteTerminalToolOutputsEverywhereTemp
        ? async terminalSessionId => {
          await netcattyBridge.deleteTerminalToolOutputsEverywhereTemp!(terminalSessionId);
        }
        : undefined,
    };
    setPersistence.call(store, persistence);
    return true;
  }
  setPersistence.call(store, undefined);
  return false;
}
