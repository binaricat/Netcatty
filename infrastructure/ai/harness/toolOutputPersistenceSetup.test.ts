import assert from 'node:assert/strict';
import test from 'node:test';
import { getNetcattyBridge } from '../aiChatStreamingSupport';
import { ToolOutputStore } from './toolOutputStore';
import { installToolOutputPersistence } from './toolOutputPersistenceSetup';

type BridgeStub = NonNullable<ReturnType<typeof getNetcattyBridge>>;

test('installToolOutputPersistence configures the durable adapter from bridge methods', async () => {
  const files = new Map<string, string>();
  const store = new ToolOutputStore();
  await installToolOutputPersistence(store, {
    getToolOutputPersistenceStatus: async () => ({ durable: true }),
    writeToolOutputTemp: async (_record, content) => {
      files.set('/netcatty/temp.log', content);
      return { ok: true, path: '/netcatty/temp.log' };
    },
    restoreToolOutputTemp: async () => null,
    readToolOutputTemp: async path => {
      const content = files.get(path);
      if (content == null) return null;
      return {
        mode: 'head',
        content,
        totalChars: content.length,
        startOffset: 0,
        endOffset: content.length,
        nextOffset: content.length,
        hasMore: false,
      };
    },
    deleteToolOutputTemp: async path => {
      files.delete(path);
      return { ok: true };
    },
  } as unknown as BridgeStub);

  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'durable please' });
  await handle.spillPromise;
  assert.equal(files.get('/netcatty/temp.log'), 'durable please');
});

test('installToolOutputPersistence clears the adapter when the bridge cannot persist', async () => {
  const store = new ToolOutputStore();
  await installToolOutputPersistence(store, {} as unknown as BridgeStub);
  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'memory only' });
  await handle.spillPromise;
  // Without a temp-output bridge there is no adapter: the handle stays in
  // memory only, matching the no-adapater behavior before any turn starts.
  assert.equal(handle.filePath, undefined);
});
