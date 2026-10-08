import { getNetcattyBridge } from '../aiChatStreamingSupport';
import type {
  PersistedToolOutputRecord,
  ReadToolOutputInput,
  ToolOutputReadResult,
  ToolOutputStore,
} from './toolOutputStore';

type NetcattyBridge = NonNullable<ReturnType<typeof getNetcattyBridge>>;

type ToolOutputTempBridge = NetcattyBridge & {
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
};

/**
 * Configure the durable tool-output persistence adapter on the shared
 * `ToolOutputStore` from the netcatty bridge's temp-output methods.
 *
 * Turn drivers call this when a turn starts, so callers that can run before
 * any turn (e.g. the "Fork from here" flow right after an app restart) must
 * call it too — otherwise `restore` stays unset and rehoming cannot pull
 * retained handles back from durable storage.
 */
export async function installToolOutputPersistence(
  store: ToolOutputStore,
  bridge?: NetcattyBridge,
): Promise<void> {
  const toolOutputTempBridge = (bridge ?? getNetcattyBridge()) as ToolOutputTempBridge | undefined;
  const persistenceStatus: { durable: boolean; reason?: string } | undefined =
    await toolOutputTempBridge?.getToolOutputPersistenceStatus?.()
      .catch(() => ({ durable: false }));
  if (
    toolOutputTempBridge?.writeToolOutputTemp
    && toolOutputTempBridge.readToolOutputTemp
    && toolOutputTempBridge.deleteToolOutputTemp
  ) {
    store.setPersistence?.({
      write: async (record, content) => {
        if (!persistenceStatus?.durable) {
          throw new Error(persistenceStatus?.reason || 'Secure local storage is unavailable.');
        }
        const result = await toolOutputTempBridge.writeToolOutputTemp!(record, content);
        if (!result.ok || !result.path) {
          throw new Error(result.error || 'Unable to persist tool output.');
        }
        return result.path;
      },
      restore: persistenceStatus?.durable && toolOutputTempBridge.restoreToolOutputTemp
        ? (handleId, chatSessionId) => toolOutputTempBridge.restoreToolOutputTemp!(handleId, chatSessionId)
        : undefined,
      read: (path, request) => toolOutputTempBridge.readToolOutputTemp!(path, request),
      delete: async path => {
        await toolOutputTempBridge.deleteToolOutputTemp!(path);
      },
      deleteSession: toolOutputTempBridge.deleteChatToolOutputsTemp
        ? async chatSessionId => {
          await toolOutputTempBridge.deleteChatToolOutputsTemp!(chatSessionId);
        }
        : undefined,
      deleteTerminalSession: toolOutputTempBridge.deleteTerminalToolOutputsTemp
        ? async (chatSessionId, terminalSessionId) => {
          await toolOutputTempBridge.deleteTerminalToolOutputsTemp!(chatSessionId, terminalSessionId);
        }
        : undefined,
      deleteTerminalEverywhere: toolOutputTempBridge.deleteTerminalToolOutputsEverywhereTemp
        ? async terminalSessionId => {
          await toolOutputTempBridge.deleteTerminalToolOutputsEverywhereTemp!(terminalSessionId);
        }
        : undefined,
    });
  } else {
    store.setPersistence?.(undefined);
  }
}
